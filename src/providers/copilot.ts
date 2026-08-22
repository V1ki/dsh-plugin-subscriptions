/**
 * GitHub Copilot subscription provider: OAuth device-authorization flow with
 * the VS Code Copilot Chat client id, a GitHub-token → Copilot-token exchange
 * against `copilot_internal/v2/token`, and streaming against two upstream
 * protocols chosen per model: the OpenAI-compatible chat completions endpoint
 * for models whose catalog entry lists `/chat/completions`, and the Responses
 * endpoint for the newer model families (gpt-5.5/5.6, …) that only list
 * `/responses`. Both upstreams are stream-only.
 *
 * Two token generations are in play: the long-lived GitHub OAuth token (kept
 * as the session's `refreshToken`) and the ~30-minute Copilot API token it
 * exchanges into (the session's `accessToken`). A TokenManager "refresh" is a
 * fresh exchange, so the standard preempt/401-retry machinery applies
 * unchanged.
 */

import { EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { DeviceFlowSpec } from '../auth/device-flow.js'
import type { CopilotSession } from '../auth/store.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import {
  streamChatCompletions,
  toChatMessages,
  toChatTools,
} from '../translate/chat-completions.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import type { ResponsesRequestInput, ResponsesStreamEvent } from '../translate/responses.js'
import {
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  ModelCatalogCache,
  oauthEndpointError,
  OAuthEndpointError,
  TokenManager,
} from './common.js'
import type {
  CatalogPersistence,
  DiscoveredModel,
  FetchFn,
  ModelEntry,
} from './common.js'

/**
 * Client id of the VS Code Copilot Chat GitHub App (pi-mono and
 * copilot2api-go use the same value): the app is pre-authorized for the
 * Copilot internal token exchange, a self-registered OAuth App is not.
 */
export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
export const COPILOT_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const COPILOT_DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
export const GITHUB_USER_URL = 'https://api.github.com/user'
export const COPILOT_API_URL = 'https://api.githubcopilot.com/chat/completions'
/** Responses endpoint for models whose catalog entry only lists `/responses`. */
export const COPILOT_RESPONSES_URL = 'https://api.githubcopilot.com/responses'
export const COPILOT_MODELS_URL = 'https://api.githubcopilot.com/models'
const COPILOT_SCOPE = 'read:user'
const COPILOT_CONTEXT_WINDOW = 128_000
const COPILOT_DEFAULT_MAX_TOKENS = 16_000
/** Refresh when the Copilot API token has less than this much life left. */
export const COPILOT_PREEMPT_MS = 5 * 60_000

/**
 * The VS Code update feed answers a JSON array of version strings, latest
 * stable first. The Copilot API rejects requests whose Editor-Version is too
 * old with `401 IDE token expired`, so the version is resolved live (cached
 * for a day) instead of hardcoded — a stale hardcode bricks every request.
 */
export const VSCODE_RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable'
/** Last-known-good VS Code version when the feed is unreachable. */
export const FALLBACK_VSCODE_VERSION = '1.107.0'
const VSCODE_VERSION_TTL_MS = 24 * 3_600_000

let vscodeVersionCache: { version: string; at: number } | undefined
let vscodeVersionInflight: Promise<string> | undefined

/**
 * Resolve the VS Code version presented as Editor-Version: the latest stable
 * from the update feed, cached for a day, falling back to a pinned version
 * when the feed fails. Concurrent resolves coalesce behind one fetch.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param forceRefresh - bypass the cache (a 401 `IDE token expired` retry).
 * @returns a `major.minor.patch` version string.
 */
export async function latestVsCodeVersion(fetchFn: FetchFn = fetch, forceRefresh = false): Promise<string> {
  if (!forceRefresh && vscodeVersionCache !== undefined
    && Date.now() - vscodeVersionCache.at < VSCODE_VERSION_TTL_MS) {
    return vscodeVersionCache.version
  }
  vscodeVersionInflight ??= (async () => {
    try {
      const response = await fetchFn(VSCODE_RELEASES_URL, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const releases: unknown = await response.json()
      const version = Array.isArray(releases)
        ? releases.find(entry => typeof entry === 'string' && /^\d+\.\d+\.\d+$/.test(entry))
        : undefined
      if (version === undefined) throw new Error('no version string in the feed')
      vscodeVersionCache = { version: version as string, at: Date.now() }
      return version as string
    } catch {
      // A feed failure must never break provider traffic: serve the stale
      // cache, else the pinned fallback.
      return vscodeVersionCache?.version ?? FALLBACK_VSCODE_VERSION
    }
  })().finally(() => { vscodeVersionInflight = undefined })
  return vscodeVersionInflight
}

/**
 * The device-flow facts for the auth controller's DeviceFlowManager.
 * @returns the flow spec for one attempt.
 */
export function copilotDeviceFlow(): DeviceFlowSpec {
  return {
    clientId: COPILOT_CLIENT_ID,
    scope: COPILOT_SCOPE,
    deviceCodeUrl: COPILOT_DEVICE_CODE_URL,
    tokenUrl: COPILOT_DEVICE_TOKEN_URL,
  }
}

/**
 * Header set presenting requests as the VS Code Copilot Chat extension; the
 * Copilot API rejects traffic without an editor identity.
 * @param hasVision - whether the request carries image input.
 * @param vscodeVersion - Editor-Version value from {@link latestVsCodeVersion}.
 * @returns headers to merge into Copilot API requests.
 */
export function copilotHeaders(hasVision = false, vscodeVersion = FALLBACK_VSCODE_VERSION): Record<string, string> {
  return {
    'user-agent': 'GitHubCopilotChat/0.35.0',
    'editor-version': `vscode/${vscodeVersion}`,
    'editor-plugin-version': 'copilot-chat/0.35.0',
    'copilot-integration-id': 'vscode-chat',
    'openai-intent': 'conversation-edits',
    'x-github-api-version': '2026-06-01',
    ...hasVision ? { 'copilot-vision-request': 'true' } : {},
  }
}

/** Copilot token-exchange response shape (subset). */
interface CopilotTokenWire {
  token?: string
  /** Epoch SECONDS at which the Copilot API token expires. */
  expires_at?: number
}

/** The freshly exchanged Copilot API token half of a session. */
interface CopilotTokenPair {
  accessToken: string
  expiresAt: number
}

/**
 * Exchange a long-lived GitHub OAuth token for a short-lived Copilot API
 * token. A 401/403 means the GitHub token is revoked or the account lost its
 * Copilot subscription — permanent, re-login required.
 * @param githubToken - the GitHub OAuth token from the device flow.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the Copilot API token and its expiry.
 */
export async function exchangeCopilotToken(
  githubToken: string,
  fetchFn: FetchFn = fetch,
): Promise<CopilotTokenPair> {
  const response = await fetchFn(COPILOT_TOKEN_URL, {
    headers: {
      'authorization': `Bearer ${githubToken}`,
      'accept': 'application/json',
      ...copilotHeaders(false, await latestVsCodeVersion(fetchFn)),
    },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'copilot')
  const wire = await response.json() as CopilotTokenWire
  if (typeof wire.token !== 'string' || wire.token.length === 0) {
    throw new Error('copilot token endpoint returned no token')
  }
  return {
    accessToken: wire.token,
    // A missing expiry falls back to a conservative 25 minutes (the tokens
    // typically live ~30).
    expiresAt: typeof wire.expires_at === 'number' && wire.expires_at > 0
      ? wire.expires_at * 1000
      : Date.now() + 25 * 60_000,
  }
}

/**
 * Complete a device-flow login: exchange the GitHub token for a Copilot API
 * token and read the GitHub login name for the status display.
 * @param githubToken - the GitHub OAuth token the device flow released.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the session to store.
 */
export async function completeCopilotLogin(
  githubToken: string,
  fetchFn: FetchFn = fetch,
): Promise<CopilotSession> {
  const pair = await exchangeCopilotToken(githubToken, fetchFn)
  let account: string | undefined
  try {
    const response = await fetchFn(GITHUB_USER_URL, {
      headers: {
        'authorization': `Bearer ${githubToken}`,
        'accept': 'application/json',
        // api.github.com only demands a user agent; no editor disguise needed.
        'user-agent': 'GitHubCopilotChat/0.35.0',
      },
    })
    if (response.ok) {
      const profile = await response.json() as { login?: string }
      if (typeof profile.login === 'string' && profile.login.length > 0) account = profile.login
    }
  } catch {
    // A profile lookup failure must not fail the login; the session works without a display name.
  }
  return {
    accessToken: pair.accessToken,
    refreshToken: githubToken,
    expiresAt: pair.expiresAt,
    ...account === undefined ? {} : { account },
  }
}

/**
 * Refresh a copilot session: re-exchange the long-lived GitHub token for a
 * fresh Copilot API token.
 * @param session - the stored session.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the fresh session to store.
 */
export async function refreshCopilot(session: CopilotSession, fetchFn: FetchFn = fetch): Promise<CopilotSession> {
  const pair = await exchangeCopilotToken(session.refreshToken, fetchFn)
  return {
    accessToken: pair.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: pair.expiresAt,
    ...session.account === undefined ? {} : { account: session.account },
  }
}

/**
 * Whether a copilot refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix (GitHub token revoked or the subscription lost).
 */
export function isCopilotPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError && (error.status === 401 || error.status === 403)
}

/** The /models catalog entry subset this plugin reads. */
interface CopilotWireModel {
  id?: string
  name?: string
  model_picker_enabled?: boolean
  policy?: { state?: string }
  supported_endpoints?: string[]
  capabilities?: {
    supports?: {
      vision?: boolean
      tool_calls?: boolean
      /** Supported reasoning efforts, present only on models that reason. */
      reasoning_effort?: string[] | null
    }
    limits?: { max_context_window_tokens?: number }
  }
}

/** Display name for one Copilot wire reasoning-effort value. */
function copilotEffortName(effort: string): string {
  return effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * Map a catalog entry's `supports.reasoning_effort` array into selectable
 * efforts. The endpoint discloses no default effort, so none is claimed
 * (absence preserves the provider's own default). Duplicates and non-string
 * entries are dropped: the harness rejects duplicate effort ids outright.
 */
function copilotReasoning(entry: CopilotWireModel): { efforts: { id: ReasoningEffortId; name: string }[] } | undefined {
  const wire = entry.capabilities?.supports?.reasoning_effort
  if (!Array.isArray(wire)) return undefined
  const seen = new Set<string>()
  const efforts: { id: ReasoningEffortId; name: string }[] = []
  for (const value of wire) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    efforts.push({ id: ReasoningEffortId(value), name: copilotEffortName(value) })
  }
  return efforts.length > 0 ? { efforts } : undefined
}

/**
 * Fetch the live Copilot model list. Models hidden from the picker or
 * disabled by policy are excluded, as are models able to speak neither
 * protocol this adapter knows: an entry listing `/chat/completions` speaks
 * the chat wire, one listing only `/responses` (the newer GPT families,
 * e.g. gpt-5.6) speaks the Responses wire, and the choice is recorded on the
 * discovered entry so requests pick the matching endpoint; an entry listing
 * BOTH endpoints additionally records `/responses` availability, which
 * {@link copilotRequestWire} uses to reroute tools+effort requests. Vision
 * support from the catalog becomes the model's input modalities, and a
 * non-empty `supports.reasoning_effort` array becomes the model's selectable
 * reasoning efforts (the endpoint discloses no default, so none is claimed).
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns discovered chat models in endpoint order.
 */
export async function fetchCopilotModels(
  session: CopilotSession,
  fetchFn: FetchFn = fetch,
): Promise<DiscoveredModel[]> {
  const response = await fetchFn(COPILOT_MODELS_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'accept': 'application/json',
      ...copilotHeaders(false, await latestVsCodeVersion(fetchFn)),
    },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'copilot models')
  const payload = await response.json() as { data?: CopilotWireModel[] }
  if (!Array.isArray(payload.data)) throw new Error('copilot models endpoint returned no data array')
  const seen = new Set<string>()
  const discovered: DiscoveredModel[] = []
  for (const entry of payload.data) {
    if (typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id)) continue
    if (entry.model_picker_enabled !== true || entry.policy?.state === 'disabled') continue
    let wire: 'chat-completions' | 'responses' | undefined
    let responsesSupported = false
    if (Array.isArray(entry.supported_endpoints)) {
      responsesSupported = entry.supported_endpoints.includes('/responses')
      if (entry.supported_endpoints.includes('/chat/completions')) wire = 'chat-completions'
      else if (responsesSupported) wire = 'responses'
      else continue
    }
    seen.add(entry.id)
    const reasoning = copilotReasoning(entry)
    discovered.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
      ...typeof entry.capabilities?.limits?.max_context_window_tokens === 'number'
        && entry.capabilities.limits.max_context_window_tokens > 0
        ? { contextWindow: entry.capabilities.limits.max_context_window_tokens }
        : {},
      inputModalities: entry.capabilities?.supports?.vision === true ? ['text', 'image'] : ['text'],
      ...reasoning === undefined ? {} : { reasoning },
      ...wire === undefined ? {} : { copilotWire: wire },
      ...responsesSupported ? { copilotResponses: true } : {},
    })
  }
  // An empty catalog from a 200 response is treated as a discovery failure so
  // the adapter falls back to the static catalog instead of vanishing from
  // the picker.
  if (discovered.length === 0) throw new Error('copilot models endpoint returned an empty catalog')
  return discovered
}

/** Which upstream protocol one Copilot model speaks. */
export type CopilotWire = 'chat-completions' | 'responses'

/**
 * The wire protocol for one model: the discovered catalog entry's recorded
 * choice, defaulting to chat completions for unknown models (static-catalog
 * and no-discovery configurations, and models listing both endpoints).
 * @param entry - the discovered catalog entry, when known.
 * @returns the protocol the request for this model must speak.
 */
export function copilotWireFor(entry: DiscoveredModel | undefined): CopilotWire {
  return entry?.copilotWire === 'responses' ? 'responses' : 'chat-completions'
}

/**
 * The upstream protocol for ONE REQUEST: the model's default wire, except
 * that a dual-protocol model defaulting to chat completions must reroute to
 * Responses when the request combines function tools with a reasoning effort
 * — Copilot rejects exactly that combination on /chat/completions with
 * HTTP 400 invalid_request_body ("Function tools with reasoning_effort are
 * not supported … use /v1/responses or set reasoning_effort to 'none'",
 * observed on gpt-5.4) while /responses serves it. Effort 'none' stays on
 * the chat wire (the API allows the combination there), and models not
 * listing /responses never reroute.
 * @param entry - the discovered catalog entry, when known.
 * @param options - the harness generate options (tools + effort only).
 * @returns the protocol the request for this model must speak.
 */
export function copilotRequestWire(
  entry: DiscoveredModel | undefined,
  options: Pick<GenerateOptions, 'tools' | 'reasoningEffort'>,
): CopilotWire {
  const wire = copilotWireFor(entry)
  if (wire !== 'chat-completions') return wire
  if (entry?.copilotResponses !== true) return wire
  if (options.tools === undefined || options.tools.length === 0) return wire
  if (options.reasoningEffort === undefined || options.reasoningEffort === 'none') return wire
  return 'responses'
}

/**
 * The chat completions request body for one generation. The output cap rides
 * `max_completion_tokens` — the newer OpenAI-family models on Copilot reject
 * the legacy `max_tokens` parameter outright (HTTP 400 "Unsupported
 * parameter"), and the rest of the catalog accepts the new spelling.
 * @param options - the harness generate options.
 * @param messages - translated wire messages (images pre-resolved).
 * @returns the JSON body.
 */
export function copilotChatRequestBody(
  options: GenerateOptions,
  messages: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    model: options.model,
    messages,
    ...options.tools !== undefined && options.tools.length > 0
      ? { tools: toChatTools(options.tools), tool_choice: 'auto' }
      : {},
    ...options.maxTokens !== undefined ? { max_completion_tokens: options.maxTokens } : {},
    // The harness only passes an effort the resolved model advertised (the
    // catalog's reasoning_effort array), and copilotRequestWire keeps the
    // tools+effort combination off this wire for models that reject it.
    ...options.reasoningEffort !== undefined
      ? { reasoning_effort: String(options.reasoningEffort) }
      : {},
    // The upstream is stream-only; usage arrives on the terminal chunk.
    stream: true,
    stream_options: { include_usage: true },
  }
}

/**
 * The Responses request body for one generation (the wire the `/responses`-
 * only model families speak). Usage arrives on `response.completed`.
 * @param options - the harness generate options.
 * @param resolved - translated instructions + input (images pre-resolved).
 * @returns the JSON body.
 */
export function copilotResponsesRequestBody(
  options: GenerateOptions,
  resolved: ResponsesRequestInput,
): Record<string, unknown> {
  return {
    model: options.model,
    ...resolved.instructions !== undefined ? { instructions: resolved.instructions } : {},
    input: resolved.input,
    ...options.tools !== undefined && options.tools.length > 0
      ? { tools: toResponsesTools(options.tools), tool_choice: 'auto' }
      : {},
    ...options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {},
    // The Responses wire spells the effort nested; only advertised efforts
    // ever reach this branch (see copilotChatRequestBody).
    ...options.reasoningEffort !== undefined
      ? { reasoning: { effort: String(options.reasoningEffort) } }
      : {},
    stream: true,
  }
}

/**
 * Rewrite Copilot's Responses-gateway item ids into stable per-item keys.
 * Unlike chatgpt.com's Responses backend, the Copilot gateway mints a FRESH
 * opaque `item.id`/`item_id` on every event of one response (the `added`,
 * each delta, and the `done` all differ), which defeats id-keyed block
 * assembly in the shared translator: text fragments would each open their
 * own block, `done` would synthesize duplicates, and a function call whose
 * arguments arrive whole only on `done` (the deltas carry empty strings)
 * would close empty. Events of one item are contiguous on the wire, so the
 * item's ordinal — assigned at `output_item.added` and reused until the next
 * one — is a faithful stable key. Function-call identity additionally rides
 * the gateway-stable `call_id`.
 */
export class CopilotResponsesItemNormalizer {
  private ordinal = 0

  private get key(): string {
    return `copilot-item-${String(this.ordinal)}`
  }

  /**
   * Rewrite one parsed Responses event.
   * @param event - the event as parsed off the wire.
   * @returns the event with a stable item key.
   */
  push(event: ResponsesStreamEvent): ResponsesStreamEvent {
    if (event.type === 'response.output_item.added') {
      this.ordinal += 1
      return event.item === undefined
        ? event
        : { ...event, item: { ...event.item, id: this.key } }
    }
    if (event.type === 'response.output_item.done') {
      return event.item === undefined
        ? event
        : { ...event, item: { ...event.item, id: this.key } }
    }
    if (event.item_id === undefined) return event
    return { ...event, item_id: this.key }
  }
}

/** Constructor dependencies for {@link CopilotAdapter}. */
export interface CopilotAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: TokenManager<CopilotSession>
  /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
  discovery: boolean
  /** Warning sink for discovery failures that fall back to the static catalog. */
  onWarn?: (message: string) => void
  /** Fetch implementation for discovery (defaults to global fetch). */
  fetchFn?: FetchFn
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Durable catalog store seeding capability metadata across restarts. */
  catalogStore?: CatalogPersistence
}

/** Copilot wire adapter: one instance serves the `copilot` provider route. */
export class CopilotAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache

  constructor(private readonly options: CopilotAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  /** Discovery fetcher: resolves the session through the refresh-aware path. */
  private async fetchCatalog(): Promise<DiscoveredModel[]> {
    return fetchCopilotModels(await this.options.tokens.session(), this.options.fetchFn)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'GitHub Copilot' }
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? ['text'],
    }))
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Not logged in → empty catalog, so the web picker drops the provider.
    const session = await this.options.tokens.peek()
    if (session === undefined) return []
    if (!this.options.discovery) return this.staticModels(provider)
    try {
      // The fetcher runs only on a cache miss, and resolves the session
      // through the refresh-aware path so an expired access token renews here
      // instead of failing discovery into the static fallback.
      const discovered = await this.catalog.get(() => this.fetchCatalog())
      return discovered.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities },
      }))
    } catch (error: unknown) {
      // A permanent refresh failure deletes the stored session: the provider
      // is logged out, so hide it instead of showing a stale static catalog.
      if (error instanceof LlmError
        && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) return []
      if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate()
      this.options.onWarn?.(
        `copilot model discovery failed; using the built-in catalog (${errorChain(error)})`,
      )
      return this.staticModels(provider)
    }
  }

  /**
   * The discovered entry for one model. Resolved through the cache's
   * stale-while-revalidate path: capability metadata must stay stable across
   * a long conversation — a mid-turn refetch must neither block nor fail the
   * call before provider I/O.
   */
  private async discovered(model: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const models = await this.catalog.resolve(() => this.fetchCatalog())
    return models?.find(entry => entry.id === model)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const discovered = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: discovered?.inputModalities ?? configured?.inputModalities ?? ['text'],
      context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? COPILOT_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? COPILOT_DEFAULT_MAX_TOKENS,
      // Efforts come from the discovered catalog's reasoning_effort array; a
      // model that did not advertise one exposes none, so the harness rejects
      // an explicit effort before provider I/O instead of the API 400ing
      // (Copilot returns invalid_request_body for models that cannot reason).
      ...discovered?.reasoning === undefined ? {} : { reasoning: discovered.reasoning },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      // The discovered catalog decides the protocol: `/responses`-only model
      // families (gpt-5.5/5.6, …) reject /chat/completions outright, and
      // dual-protocol models reroute there once the request combines function
      // tools with a reasoning effort (gpt-5.4 400s on the chat wire then).
      const wire = copilotRequestWire(await this.discovered(options.model), options)
      let session = await this.options.tokens.session()
      let response = await this.request(options, session, watchdog.signal, wire)
      if (response.status === 401) {
        // One forced refresh + retry on an unexpired-but-rejected token. The
        // editor version is force-refreshed too: a 401 `IDE token expired`
        // means GitHub raised its minimum VS Code version, and only a fresh
        // Editor-Version header fixes that (a new token does not).
        await latestVsCodeVersion(this.options.fetchFn ?? fetch, true)
        session = await this.options.tokens.session(true)
        response = await this.request(options, session, watchdog.signal, wire)
      }
      if (!response.ok) throw await httpLlmError(response, 'copilot API')
      if (response.body === null) {
        throw new LlmError('copilot API returned no response body', EMPTY_RESPONSE_CODE)
      }
      const pulse = (): void => { watchdog.pulse() }
      if (wire === 'responses') {
        const normalizer = new CopilotResponsesItemNormalizer()
        yield* streamResponses(response.body, pulse, event => normalizer.push(event))
      } else {
        yield* streamChatCompletions(response.body, pulse)
      }
    } catch (error: unknown) {
      throw mapFetchFailure('copilot API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private async request(
    options: GenerateOptions,
    session: CopilotSession,
    signal: AbortSignal,
    wire: CopilotWire,
  ): Promise<Response> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    const hasVision = messages.some(message => message.content.some(block => block.type === 'image'))
    const body = wire === 'responses'
      ? copilotResponsesRequestBody(options, toResponsesInput(messages, options.system))
      : copilotChatRequestBody(options, toChatMessages(messages, options.system))
    return fetch(wire === 'responses' ? COPILOT_RESPONSES_URL : COPILOT_API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        ...copilotHeaders(hasVision, await latestVsCodeVersion(this.options.fetchFn ?? fetch)),
      },
      body: JSON.stringify(body),
      signal,
    })
  }
}
