/**
 * dsh-plugin-subscriptions: register OAuth-subscription LLM providers
 * (ChatGPT/Codex, Claude, Grok) on `ctx.llm`, and expose the `/subscriptions-auth`
 * RPC channel the web Settings page uses to run the logins. The token store
 * lives at `~/.dsh/plugins/subscriptions/auth.json`; the channel registers only when
 * a host `connection` service exists, so headless compositions load fine.
 * @module dsh-plugin-subscriptions
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
// Type-only: activates the `ctx.tools` Context merge for the inject block.
import type {} from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { registerAuthRpc } from './auth/rpc.js'
import type { AuthController, ImageBytesResult, ProviderStatus } from './auth/rpc.js'
import {
  deleteSession,
  getSession,
  saveSession,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  ClaudeSession,
  CodexSession,
  GrokSession,
  ProviderId,
  SessionMap,
  StoredSession,
} from './auth/store.js'
import { TokenManager, validateModels } from './providers/common.js'
import type { ModelEntry, ProviderUsage } from './providers/common.js'
import { catalogStore } from './providers/catalog-store.js'
import {
  CodexAdapter,
  codexFlow,
  CODEX_PREEMPT_MS,
  codexProfileClaims,
  exchangeCodexCode,
  fetchCodexUsage,
  isCodexPermanentRefreshError,
  refreshCodex,
} from './providers/codex.js'
import {
  ClaudeAdapter,
  claudeFlow,
  CLAUDE_PREEMPT_MS,
  exchangeClaudeCode,
  fetchClaudeUsage,
  isClaudePermanentRefreshError,
  refreshClaude,
} from './providers/claude.js'
import {
  GrokAdapter,
  grokFlow,
  GROK_PREEMPT_MS,
  exchangeGrokCode,
  fetchGrokUsage,
  isGrokPermanentRefreshError,
  refreshGrok,
} from './providers/grok.js'
import { createXSearchTool } from './tools/x-search.js'
import { createImageGenerateTool } from './tools/image-generate.js'

export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js'
export type { ProviderStatus } from './auth/rpc.js'
export type { ClaudeSession, CodexSession, GrokSession, ProviderId } from './auth/store.js'

export const name = 'dsh-plugin-subscriptions'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Provider routes to register; defaults to all three. */
  providers?: ProviderId[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Advisory model catalogs overriding the built-in defaults, per provider. */
  models?: {
    codex?: ModelEntry[]
    claude?: ModelEntry[]
    grok?: ModelEntry[]
  }
}

const providerIdSchema = z.union(['codex', 'claude', 'grok'])
const modelEntrySchema: z<ModelEntry> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
})

export const Config: z<Config> = z.object({
  providers: z.array(providerIdSchema).default(['codex', 'claude', 'grok']),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  models: z.object({
    codex: z.array(modelEntrySchema),
    claude: z.array(modelEntrySchema),
    grok: z.array(modelEntrySchema),
  }),
})

/** Built-in catalogs used when the config does not override a provider's models. */
const DEFAULT_MODELS: Record<ProviderId, ModelEntry[]> = {
  codex: [
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
  claude: [
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'claude-fable-5', name: 'Claude Fable 5' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', maxTokens: 64_000 },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  ],
  grok: [
    { id: 'grok-4', name: 'Grok 4' },
    { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning' },
    { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
  ],
}

/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {
  const resolve = (provider: ProviderId): ModelEntry[] => {
    // Schemastery injects `[]` for omitted array fields, so an empty list
    // cannot be told apart from an absent one: both mean the built-ins.
    const configured = models?.[provider]
    const entries = configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODELS[provider]
    return validateModels(entries, `${name}: models.${provider}`)
  }
  return { codex: resolve('codex'), claude: resolve('claude'), grok: resolve('grok') }
}

/** The display account of a stored session, for the status endpoint. */
function accountOf(provider: ProviderId, session: StoredSession | undefined): string | undefined {
  if (session === undefined) return undefined
  switch (provider) {
    case 'codex': {
      const codex = session as CodexSession
      // Sessions stored before identity claims were persisted still carry the
      // id token: decode the email on the fly instead of forcing a re-login.
      return codex.emailAddress ?? codexProfileClaims(codex.idToken).emailAddress ?? codex.accountId
    }
    case 'claude': return (session as ClaudeSession).emailAddress
    case 'grok': return (session as GrokSession).account
  }
}

/** Per-provider usage lookup; providers without a usage endpoint are absent. */
type UsageFetchers = Partial<Record<ProviderId, (signal: AbortSignal) => Promise<ProviderUsage>>>

/**
 * Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
 * OAuth attempts in the background, feed pasted codes, cancel, log out, and
 * answer usage lookups.
 */
class SubscriptionsAuthController implements AuthController {
  /** Last login failure per provider, surfaced as `detail` until the next success. */
  private lastError = new Map<ProviderId, string>()

  constructor(
    private readonly flows: OAuthFlowManager,
    /** Announces a provider's auth-state change so catalog readers re-query (fires `llm/adapters-updated`). */
    private readonly onAuthChanged: (provider: ProviderId) => void,
    /** Lazy attachment-store lookup for the `image` endpoint. */
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    /** Usage lookups for providers that expose a usage endpoint. */
    private readonly usageFetchers: UsageFetchers = {},
  ) {}

  usage(provider: ProviderId, signal: AbortSignal): Promise<ProviderUsage> {
    const fetcher = this.usageFetchers[provider]
    if (fetcher === undefined) return Promise.resolve({ supported: false })
    return fetcher(signal)
  }

  async readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult> {
    const attachments = this.resolveAttachments()
    if (attachments === undefined) {
      throw new Error('no attachment service is mounted; generated-image bytes are unavailable')
    }
    const stored = await attachments.readImage(ref, signal)
    return { mediaType: stored.ref.mediaType, dataBase64: Buffer.from(stored.data).toString('base64') }
  }

  async status(provider: ProviderId): Promise<ProviderStatus> {
    const session = await getSession(provider)
    const account = accountOf(provider, session)
    // The plan name is shown by the usage section, so `detail` only carries errors.
    const detail = this.lastError.get(provider)
    return {
      loggedIn: session !== undefined,
      busy: this.flows.isBusy(provider),
      ...session === undefined ? {} : { expiresAt: session.expiresAt },
      ...account === undefined ? {} : { account },
      ...detail === undefined ? {} : { detail },
    }
  }

  async login(provider: ProviderId): Promise<{ authorizeUrl: string }> {
    // Grok's authorize URL comes from OIDC discovery, so its spec is async.
    const spec = provider === 'grok' ? await grokFlow() : provider === 'claude' ? claudeFlow : codexFlow
    const attempt = await this.flows.start(provider, spec)
    void this.complete(provider, attempt)
    return { authorizeUrl: attempt.authorizeUrl }
  }

  /** Drive one attempt to a stored session; records failures for the status endpoint. */
  private async complete(provider: ProviderId, attempt: OAuthAttempt): Promise<void> {
    try {
      const code = await attempt.waitCode()
      const session = await this.exchange(provider, code, attempt)
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider)
    } catch (error) {
      // A user-cancelled attempt is not a failure worth surfacing.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    }
  }

  private exchange(provider: ProviderId, code: string, attempt: OAuthAttempt): Promise<StoredSession> {
    switch (provider) {
      case 'codex':
        return exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri)
      case 'claude':
        return exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state)
      case 'grok':
        return exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge)
    }
  }

  private persist(provider: ProviderId, session: StoredSession): Promise<void> {
    // The switch keeps the generic key and the session type aligned.
    switch (provider) {
      case 'codex': return saveSession('codex', session as SessionMap['codex'] & object)
      case 'claude': return saveSession('claude', session as SessionMap['claude'] & object)
      case 'grok': return saveSession('grok', session as SessionMap['grok'] & object)
    }
  }

  manual(provider: ProviderId, input: string): Promise<void> {
    const attempt = this.flows.pending(provider)
    if (attempt === undefined) {
      return Promise.reject(new Error(`no ${provider} login attempt is in progress`))
    }
    attempt.manual(input)
    return Promise.resolve()
  }

  cancel(provider: ProviderId): Promise<void> {
    this.flows.pending(provider)?.cancel()
    return Promise.resolve()
  }

  async logout(provider: ProviderId): Promise<void> {
    this.flows.pending(provider)?.cancel()
    await deleteSession(provider)
    this.lastError.delete(provider)
    this.onAuthChanged(provider)
  }
}

export function apply(ctx: Context, config: Config): void {
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const catalog = resolveCatalog(config.models)
  // A non-empty configured catalog is an explicit override: it wins over live
  // discovery entirely (schemastery injects [] for omitted arrays, so only a
  // non-empty list counts as configured).
  const overridden = new Set<ProviderId>(
    PROVIDER_IDS.filter(provider => (config.models?.[provider]?.length ?? 0) > 0),
  )
  const flows = new OAuthFlowManager()
  const onWarn = (message: string): void => {
    ctx.logger.warn(`dsh-plugin-subscriptions: ${message}`)
  }
  // Optional: resolves ImageBlock references to bytes for vision-capable
  // models. Resolved per request — the attachments service may start after
  // this plugin's apply, so a one-time capture would stay undefined forever.
  const resolveAttachments = (): AttachmentStore | undefined =>
    ctx.get('attachments') as AttachmentStore | undefined

  // Registration handles are kept so an auth-state change can re-announce the
  // route (`replace` fires `llm/adapters-updated`), which makes the web model
  // picker re-query `listModels` and show/hide the provider.
  const handles = new Map<ProviderId, AdapterRegistrationHandle>()
  const authChanged = (provider: ProviderId): void => {
    handles.get(provider)?.replace([provider])
  }
  // Token managers double as the tools' credential source, so they are
  // captured beside the registrations for the inject block below.
  let codexTokens: TokenManager<CodexSession> | undefined
  let grokTokens: TokenManager<GrokSession> | undefined
  // Usage lookups resolve the session through the refresh-aware path, so an
  // expired access token renews instead of failing the lookup.
  const usageFetchers: UsageFetchers = {}

  for (const provider of providers) {
    switch (provider) {
      case 'codex': {
        const tokens = new TokenManager<CodexSession>({
          displayName: 'ChatGPT (Codex)',
          preemptMs: CODEX_PREEMPT_MS,
          load: () => getSession('codex'),
          save: session => saveSession('codex', session),
          remove: () => deleteSession('codex'),
          refresh: refreshCodex,
          isPermanent: isCodexPermanentRefreshError,
          onRemoved: () => { authChanged('codex') },
        })
        codexTokens = tokens
        usageFetchers.codex = async signal => fetchCodexUsage(await tokens.session(), fetch, signal)
        handles.set('codex', ctx.llm.registerAdapter(['codex'], new CodexAdapter({
          models: catalog.codex,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('codex'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('codex'),
        })))
        break
      }
      case 'claude': {
        const tokens = new TokenManager<ClaudeSession>({
          displayName: 'Claude (Subscription)',
          preemptMs: CLAUDE_PREEMPT_MS,
          load: () => getSession('claude'),
          save: session => saveSession('claude', session),
          remove: () => deleteSession('claude'),
          refresh: refreshClaude,
          isPermanent: isClaudePermanentRefreshError,
          onRemoved: () => { authChanged('claude') },
        })
        usageFetchers.claude = async signal => fetchClaudeUsage(await tokens.session(), fetch, signal)
        handles.set('claude', ctx.llm.registerAdapter(['claude'], new ClaudeAdapter({
          models: catalog.claude,
          streamIdleTimeoutMs,
          tokens,
          resolveAttachments,
        })))
        break
      }
      case 'grok': {
        const tokens = new TokenManager<GrokSession>({
          displayName: 'Grok (Subscription)',
          preemptMs: GROK_PREEMPT_MS,
          load: () => getSession('grok'),
          save: session => saveSession('grok', session),
          remove: () => deleteSession('grok'),
          refresh: refreshGrok,
          isPermanent: isGrokPermanentRefreshError,
          onRemoved: () => { authChanged('grok') },
        })
        grokTokens = tokens
        usageFetchers.grok = async signal => fetchGrokUsage(await tokens.session(), fetch, signal)
        handles.set('grok', ctx.llm.registerAdapter(['grok'], new GrokAdapter({
          models: catalog.grok,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('grok'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('grok'),
        })))
        break
      }
    }
  }

  registerAuthRpc(ctx, new SubscriptionsAuthController(flows, authChanged, resolveAttachments, usageFetchers))

  // `tools` is optional (headless/minimal compositions may not mount it), so
  // registration waits for the service instead of injecting it at load.
  // x_search follows the grok provider, image_generate the codex provider.
  ctx.inject(['tools'], (toolsCtx) => {
    if (grokTokens !== undefined) toolsCtx.tools.register(createXSearchTool({ tokens: grokTokens }))
    if (codexTokens !== undefined) {
      toolsCtx.tools.register(createImageGenerateTool({
        tokens: codexTokens,
        resolveAttachments,
        resolveLlm: () => ctx.get('llm'),
      }))
    }
  })
}
