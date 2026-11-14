/**
 * Generic OAuth-subscription provider speaking the OpenAI Chat Completions
 * wire protocol. Kimi Code, GLM Coding Plan (ZCode) and Qwen Code all expose
 * an OpenAI-compatible endpoint backed by a member subscription rather than a
 * metered API key, so one adapter serves all three: the differences are the
 * endpoint, the static/discovered catalog, and the device headers the
 * official clients send.
 *
 * The adapter owns no credentials of its own: tokens come from the shared
 * {@link AccountTokenManager}, so multi-account login, proactive refresh and
 * account pools behave exactly like the upstream providers.
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { proxiedFetch } from '../http.js'
import { streamChatCompletions, toChatMessages, toChatTools } from '../translate/chat-completions.js'
import { resolveImages } from '../translate/resolved.js'
import type { TranslatableMessage } from '../translate/resolved.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import type { AccountAwareAdapter } from './accounts.js'
import { idleWatchdog, httpLlmError, mapFetchFailure } from './common.js'
import type { ModelEntry } from './common.js'
import type { ProviderId } from '../auth/store.js'
import {
  DEFAULT_RATE_LIMIT_WAIT,
  DEFAULT_RETRY,
  subscriptionRetryPolicy,
} from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'
import type { PoolAdapter } from './pool.js'

/** The session fields every chat-subscription provider stores. */
export interface ChatSubscriptionSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  account?: string
}

/** One discovered model, reduced to what the adapter advertises. */
export interface ChatSubscriptionDiscovered {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ('text' | 'image')[]
}

/** Static facts of one provider route. */
export interface ChatSubscriptionDefinition {
  /** Provider route id. */
  id: ProviderId
  /** Human-readable provider name. */
  name: string
  /** Full Chat Completions URL. */
  endpoint: string
  /** Diagnostic label used in errors. */
  label: string
  /** Optional live catalog; a failure falls back to the static entries. */
  discover?: (
    session: ChatSubscriptionSession,
    fetchFn: typeof fetch,
    signal: AbortSignal,
  ) => Promise<ChatSubscriptionDiscovered[]>
  /**
   * Re-send an assistant turn's `reasoning_content` on tool rounds. GLM and
   * Kimi thinking models require their own thinking back on the next turn.
   */
  replayReasoning?: boolean
  /** Extra request headers (device identity), per session. */
  headers?: (session: ChatSubscriptionSession) => Promise<Record<string, string>> | Record<string, string>
}

export interface ChatSubscriptionAdapterOptions {
  definition: ChatSubscriptionDefinition
  tokens: AccountTokenManager<ChatSubscriptionSession>
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  rateLimit?: RateLimitWait
  onWarn?: (message: string) => void
  resolveAttachments: () => AttachmentStore | undefined
  pool?: () => PoolAdapter | undefined
  fetchFn?: typeof fetch
}

const ownedErrors = new WeakSet<Error>()

function failure(message: string, code: string): LlmError {
  const error = new LlmError(message, code)
  ownedErrors.add(error)
  return error
}

/**
 * Attach each assistant turn's reasoning to the wire message the shared
 * translator produced. The shared translator intentionally drops reasoning
 * (Responses parity); thinking-only models need it replayed verbatim.
 */
export function withAssistantReasoning(
  messages: readonly TranslatableMessage[],
  system?: string,
): Record<string, unknown>[] {
  const result = toChatMessages(messages, system)
  const assistants = messages.filter(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'text' || block.type === 'tool-call'))
  let index = 0
  for (const wire of result) {
    if (wire.role !== 'assistant') continue
    const source = assistants[index++]
    const reasoning = source?.content
      .filter(block => block.type === 'reasoning')
      .map(block => block.text)
      .join('')
    if (reasoning !== undefined && reasoning.length > 0) wire.reasoning_content = reasoning
  }
  return result
}

/** Map a discovered entry onto the harness model info. */
function toModelInfo(provider: string, entry: ChatSubscriptionDiscovered): LlmModelInfo {
  return {
    provider,
    id: entry.id,
    name: entry.name,
    ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
  }
}

export class ChatSubscriptionAdapter extends LlmAdapter implements AccountAwareAdapter {
  private readonly catalog = new Map<string, ChatSubscriptionDiscovered[]>()
  private readonly fetchFn: typeof fetch

  constructor(private readonly options: ChatSubscriptionAdapterOptions) {
    super()
    this.fetchFn = options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.definition.name }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `${this.options.definition.id}: provider "${provider}" retryPolicy`,
    )
  }

  private checkRoute(provider: string): void {
    if (provider !== this.options.definition.id) {
      throw failure(`${this.options.definition.name} provider route mismatch`, 'INVALID_REQUEST')
    }
  }

  /** Static catalog entries, mapped to model info. */
  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities },
    }))
  }

  /** One account's catalog, live discovery first, static entries as fallback. */
  private async ownCatalog(
    provider: string,
    account: string,
    signal?: AbortSignal,
  ): Promise<LlmModelInfo[]> {
    if (!await this.options.tokens.hasSession(account)) return []
    const discover = this.options.definition.discover
    if (discover === undefined) return this.staticModels(provider)
    const cached = this.catalog.get(account)
    if (cached !== undefined) return cached.map(entry => toModelInfo(provider, entry))
    try {
      const session = await this.options.tokens.session(account)
      const discovered = await discover(
        session,
        this.fetchFn,
        signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      )
      if (discovered.length > 0) {
        this.catalog.set(account, discovered)
        return discovered.map(entry => toModelInfo(provider, entry))
      }
    } catch (error) {
      this.options.onWarn?.(`${this.options.definition.name} model discovery failed; using the built-in catalog (${String(error)})`)
    }
    return this.staticModels(provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const own = await this.listOwnModels(provider, undefined, undefined, true)
    const pool = this.options.pool?.()
    if (pool === undefined) return own
    const extra = await pool.modelsForProvider(provider as ProviderId)
    const seen = new Set(own.map(model => model.id))
    return [...own, ...extra.filter(model => !seen.has(model.id))]
  }

  async listOwnModels(
    provider: string,
    account?: string,
    signal?: AbortSignal,
    _preferCached = false,
  ): Promise<readonly LlmModelInfo[]> {
    this.checkRoute(provider)
    if (account !== undefined) return this.ownCatalog(provider, account, signal)
    const accounts = (await this.options.tokens.list()).map(entry => entry.key)
    if (accounts.length === 0) return []
    return unionAccountCatalogs(
      accounts,
      (key, accountSignal) => this.ownCatalog(provider, key, accountSignal),
      { timeoutMs: DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } },
    )
  }

  lastKnownOwnModels(provider: string, account: string): Promise<readonly LlmModelInfo[] | undefined> {
    const cached = this.catalog.get(account)
    return Promise.resolve(cached?.map(entry => toModelInfo(provider, entry)))
  }

  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.catalog.clear()
    else this.catalog.delete(account)
  }

  private staticEntry(model: string): ChatSubscriptionDiscovered | undefined {
    const entry = this.options.models.find(candidate => candidate.id === model)
    return entry === undefined ? undefined : {
      id: entry.id,
      name: entry.name ?? entry.id,
      ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
      ...entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
    }
  }

  async resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo> {
    this.checkRoute(provider)
    const cached = account === undefined
      ? [...this.catalog.values()].flat().find(entry => entry.id === model)
      : this.catalog.get(account)?.find(entry => entry.id === model)
    const found: ChatSubscriptionDiscovered | undefined = cached ?? this.staticEntry(model)
    if (found === undefined) {
      throw failure(`${this.options.definition.name} has no model "${model}"; configure a supported model in this route catalog`, 'INVALID_MODEL')
    }
    return {
      provider,
      id: model,
      name: found.name ?? model,
      inputModalities: found.inputModalities ?? ['text'],
      ...found.contextWindow === undefined ? {} : { context: { contextWindow: found.contextWindow } },
      ...found.maxTokens === undefined ? {} : { defaultMaxTokens: found.maxTokens },
    }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.resolveOwnModel(provider, model)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamCore(options, undefined)
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    this.checkRoute(options.provider)
    const definition = this.options.definition
    const resolved = await this.resolveOwnModel(options.provider, options.model, account)
    const signal = options.signal
    const watchdog = idleWatchdog(signal, this.options.streamIdleTimeoutMs)
    let response: Response | undefined
    try {
      let session = await this.options.tokens.session(account)
      const messages = await resolveImages(options.messages, this.options.resolveAttachments(), watchdog.signal)
      const body: Record<string, unknown> = {
        model: options.model,
        messages: definition.replayReasoning === true
          ? withAssistantReasoning(messages, options.system)
          : toChatMessages(messages, options.system),
        stream: true,
        stream_options: { include_usage: true },
        ...options.tools === undefined || options.tools.length === 0 ? {} : { tools: toChatTools(options.tools) },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined && resolved.defaultMaxTokens === undefined
          ? {} : { max_tokens: options.maxTokens ?? resolved.defaultMaxTokens },
        ...options.stop === undefined ? {} : { stop: options.stop },
      }
      const request = async (token: string): Promise<Response> => {
        const headers: Record<string, string> = {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          ...await definition.headers?.(session) ?? {},
        }
        return this.fetchFn(definition.endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: watchdog.signal,
          headers,
          body: JSON.stringify(body),
        })
      }
      response = await request(session.accessToken)
      if (response.status === 401) {
        // The access token was revoked earlier than its stored expiry claimed:
        // refresh once and replay the request, the way the official clients do.
        void response.body?.cancel().catch(() => {})
        session = await this.options.tokens.session(account, true)
        response = await request(session.accessToken)
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw failure(`${definition.label} redirects are forbidden; the token is sent only to the fixed subscription endpoint`, 'REDIRECT_BLOCKED')
      }
      if (!response.ok) {
        throw await httpLlmError(response, `${definition.label} request rejected`,
          this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn })
      }
      const bodyStream = response.body
      if (bodyStream === null) throw failure(`${definition.label} returned no response body`, 'EMPTY_RESPONSE')
      for await (const chunk of streamChatCompletions(bodyStream, watchdog.pulse)) {
        yield chunk
      }
    } catch (error) {
      if (error instanceof Error && ownedErrors.has(error)) throw error
      throw mapFetchFailure(definition.label, error, watchdog, signal)
    } finally {
      watchdog.stop()
      const leftover = response?.body
      if (leftover !== undefined && leftover !== null && !leftover.locked) void leftover.cancel().catch(() => {})
    }
  }
}
