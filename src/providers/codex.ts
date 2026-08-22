/**
 * ChatGPT/Codex subscription provider: OAuth against auth.openai.com with the
 * Codex CLI client id, and streaming against the ChatGPT backend Responses
 * endpoint.
 */

import { randomUUID } from 'node:crypto'
import { attributionHeaders, EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { decodeJwtPayload } from '../auth/jwt.js'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { CodexSession } from '../auth/store.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import type { ResponsesRequestInput } from '../translate/responses.js'
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
  ProviderUsage,
  UsageWindow,
} from './common.js'
import {
  DEFAULT_RATE_LIMIT_WAIT,
  DEFAULT_RETRY,
  earliestReset,
  jsonBody,
  resetFromFields,
  resetInstantFromHeader,
  subscriptionRetryPolicy,
} from './rate-limit.js'
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses'
const CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
const CODEX_CALLBACK_PATH = '/auth/callback'
const CODEX_CONTEXT_WINDOW = 400_000
const CODEX_DEFAULT_MAX_TOKENS = 128_000
/** Refresh when the access token has less than this much life left. */
export const CODEX_PREEMPT_MS = 5 * 60_000

/**
 * The rate-limit snapshot headers the ChatGPT backend attaches to a Codex
 * response, one per window (the same primary/secondary split the usage
 * endpoint reports).
 */
const CODEX_RESET_HEADERS = [
  'x-codex-primary-reset-after-seconds',
  'x-codex-secondary-reset-after-seconds',
] as const

/**
 * Body fields the backend uses to name a reset. A window-exhaustion rejection
 * carries `usage_limit_reached` with the seconds left on the window — the case
 * that used to classify as a terminal quota and never be retried at all.
 */
const CODEX_RESET_FIELDS = ['resets_in_seconds', 'reset_after_seconds', 'resets_at', 'reset_at'] as const

/** Reads the reset instant of the Codex window that rejected a request. */
export const codexRateLimitReset: RateLimitResetReader = (response, body, now) => {
  // Body first: it names the window that actually rejected the request, while
  // the snapshot headers describe every window including ones with room left.
  const fromBody = resetFromFields(jsonBody(body), CODEX_RESET_FIELDS, now)
  if (fromBody !== undefined) return fromBody
  return earliestReset(...CODEX_RESET_HEADERS.map(header => resetInstantFromHeader(response, header, now)))
}

/** Default instruction when the request carries no system prompt. */
const DEFAULT_CODEX_INSTRUCTIONS = 'You are Codex, a coding agent based on GPT-5. '
  + 'Help the user with their software engineering tasks.'

/** Refresh-grant rejections that mean the login is gone for good. */
const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
])

const CODEX_EFFORTS = [
  { id: ReasoningEffortId('minimal'), name: 'Minimal' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'Extra High' },
] as const
const CODEX_DEFAULT_EFFORT = ReasoningEffortId('high')
/** Every gpt-5.x codex model accepts image input. */
const CODEX_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/**
 * Fast tier (the codex CLI's "fast mode"): the Responses `service_tier` wire
 * value for priority processing, mirroring codex-rs
 * `ServiceTier::Fast.request_value()`. The legacy catalog spelling is the
 * `additional_speed_tiers` entry "fast".
 */
export const CODEX_FAST_SERVICE_TIER = 'priority'
const CODEX_FAST_SPEED_TIER = 'fast'

/** One session's speed choice: standard routing or the fast (priority) tier. */
export type CodexSpeedTier = 'standard' | 'fast'

/** Static codex flow facts for the OAuth flow engine. */
export const codexFlow: FlowSpec = {
  callbackPath: CODEX_CALLBACK_PATH,
  listen: { host: 'localhost', ports: [1455, 1457] },
  buildAuthorizeUrl({ redirectUri, state, pkce }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: CODEX_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    })
    return `${CODEX_AUTHORIZE_URL}?${params.toString()}`
  },
}

/** Token endpoint response shape (subset). */
interface CodexTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

/** Pull `chatgpt_account_id` out of an id token payload. */
function accountIdOf(idToken: string | undefined): string {
  const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  const auth = payload?.['https://api.openai.com/auth']
  const accountId = typeof auth === 'object' && auth !== null
    ? (auth as Record<string, unknown>).chatgpt_account_id
    : undefined
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('codex login did not return a chatgpt account id; cannot use the subscription')
  }
  return accountId
}

/** User identity claims decoded from a codex id token. */
export interface CodexProfileClaims {
  emailAddress?: string
  planType?: string
}

/**
 * Decode the user-identity claims of a codex id token (pure, cheap — no
 * verification, same trust posture as {@link accountIdOf}). Claim paths
 * mirror codex-rs `login/src/token_data.rs`: the email is the top-level
 * `email` claim, falling back to `https://api.openai.com/profile`.email; the
 * plan is `https://api.openai.com/auth`.chatgpt_plan_type.
 * @param idToken - a stored or freshly issued id token, when present.
 * @returns whichever claims the token carried; empty when undecodable.
 */
export function codexProfileClaims(idToken: string | undefined): CodexProfileClaims {
  const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  if (payload === undefined) return {}
  const profile = payload['https://api.openai.com/profile']
  const profileEmail = typeof profile === 'object' && profile !== null
    ? (profile as Record<string, unknown>).email
    : undefined
  const email = payload.email ?? profileEmail
  const auth = payload['https://api.openai.com/auth']
  const plan = typeof auth === 'object' && auth !== null
    ? (auth as Record<string, unknown>).chatgpt_plan_type
    : undefined
  return {
    ...typeof email === 'string' && email.length > 0 ? { emailAddress: email } : {},
    ...typeof plan === 'string' && plan.length > 0 ? { planType: plan } : {},
  }
}

/** Build a session from a token response; expires_in wins, JWT exp is the fallback. */
function codexSession(tokens: CodexTokenResponse, fallback?: CodexSession): CodexSession {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('codex token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallback?.refreshToken
  if (refreshToken === undefined) throw new Error('codex token endpoint returned no refresh token')
  let expiresAt: number | undefined
  if (typeof tokens.expires_in === 'number' && tokens.expires_in > 0) {
    expiresAt = Date.now() + tokens.expires_in * 1000
  } else {
    const exp = decodeJwtPayload(tokens.access_token)?.exp
    if (typeof exp === 'number' && exp > 0) expiresAt = exp * 1000
  }
  if (expiresAt === undefined) throw new Error('codex token endpoint returned no usable expiry')
  // Identity claims come from the freshest id token; a refresh that omits
  // one keeps the claims the stored session already had.
  const idToken = tokens.id_token ?? fallback?.idToken
  const claims = {
    ...fallback?.emailAddress === undefined ? {} : { emailAddress: fallback.emailAddress },
    ...fallback?.planType === undefined ? {} : { planType: fallback.planType },
    ...codexProfileClaims(tokens.id_token),
  }
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt,
    accountId: tokens.id_token === undefined && fallback !== undefined
      ? fallback.accountId
      : accountIdOf(tokens.id_token),
    ...idToken === undefined ? {} : { idToken },
    ...claims,
  }
}

/**
 * Exchange an authorization code for a codex session (form-encoded grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @returns the session to store.
 */
export async function exchangeCodexCode(code: string, verifier: string, redirectUri: string): Promise<CodexSession> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex')
  return codexSession(await response.json() as CodexTokenResponse)
}

/**
 * Refresh a codex session (JSON grant — unlike the code exchange).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshCodex(session: CodexSession): Promise<CodexSession> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    }),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex')
  return codexSession(await response.json() as CodexTokenResponse, session)
}

/**
 * Whether a codex refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isCodexPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && error.oauthCode !== undefined
    && PERMANENT_REFRESH_CODES.has(error.oauthCode)
}

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** One `rate_limit.*_window` object of the wham/usage payload (subset). */
interface CodexUsageWindow {
  used_percent?: number
  /** Window duration in seconds (18000 = 5 hours, 604800 = 7 days). */
  limit_window_seconds?: number
  /** Unix seconds at which the window resets. */
  reset_at?: number
  /** Seconds until the window resets (fallback when `reset_at` is absent). */
  reset_after_seconds?: number
}

/** Seconds of the canonical 5-hour session and 7-day weekly windows. */
const SESSION_WINDOW_SECONDS = 5 * 60 * 60
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

/** Whether a reported duration approximately matches the expected window length. */
function matchesWindow(seconds: number, expected: number): boolean {
  return seconds >= expected * 0.95 && seconds <= expected * 1.05
}

/**
 * Classify a wham/usage window by its reported duration. The backend has been
 * observed to place the weekly lane in `primary_window` with no secondary
 * window, so slot position alone is unreliable; the caller's positional
 * fallback applies only when the duration is absent.
 */
function codexWindowKind(window: CodexUsageWindow, fallback: UsageWindow['kind']): UsageWindow['kind'] {
  const seconds = window.limit_window_seconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback
  if (matchesWindow(seconds, SESSION_WINDOW_SECONDS)) return 'session'
  if (matchesWindow(seconds, WEEKLY_WINDOW_SECONDS)) return 'weekly'
  return 'other'
}

/** Map one wham/usage window into a {@link UsageWindow}; undefined when unusable. */
function codexUsageWindow(value: unknown, fallbackKind: UsageWindow['kind']): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const window = value as CodexUsageWindow
  if (typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) return undefined
  let resetsAt: number | undefined
  if (typeof window.reset_at === 'number' && window.reset_at > 0) {
    resetsAt = window.reset_at * 1000
  } else if (typeof window.reset_after_seconds === 'number' && window.reset_after_seconds > 0) {
    resetsAt = Date.now() + window.reset_after_seconds * 1000
  }
  return {
    kind: codexWindowKind(window, fallbackKind),
    usedPercent: window.used_percent,
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/**
 * Fetch the codex subscription usage from the ChatGPT backend wham/usage
 * endpoint (the source of the codex CLI `/status` rate-limit lines). The
 * windows are classified by their reported duration (`limit_window_seconds`)
 * rather than by slot, since the backend has been observed to report the
 * weekly lane as `primary_window` without a secondary window; slot order is
 * kept only as a fallback when the duration is absent. The lookup itself
 * consumes no rate-limit budget.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchCodexUsage(
  session: CodexSession,
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const response = await fetchFn(CODEX_USAGE_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'chatgpt-account-id': session.accountId,
      'originator': 'codex_cli_rs',
      'accept': 'application/json',
      ...attributionHeaders(),
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex usage')
  const payload = await response.json() as {
    plan_type?: string
    rate_limit?: { primary_window?: unknown; secondary_window?: unknown }
  }
  const windows: UsageWindow[] = []
  const primary = codexUsageWindow(payload.rate_limit?.primary_window, 'session')
  const secondary = codexUsageWindow(payload.rate_limit?.secondary_window, 'weekly')
  if (primary !== undefined) windows.push(primary)
  if (secondary !== undefined) windows.push(secondary)
  return {
    supported: true,
    windows,
    ...typeof payload.plan_type === 'string' && payload.plan_type.length > 0
      ? { plan: payload.plan_type }
      : {},
  }
}

export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

/**
 * Client version sent on the /models catalog request. The backend gates the
 * visible model list by client version: versions below ~0.101 get an empty
 * list, while current codex CLI releases get the full catalog — keep this in
 * the range of current codex CLI releases.
 */
export const CODEX_CLIENT_VERSION = '0.147.0'

/** The codex `/models` entry shape this plugin reads (subset of codex-rs `ModelInfo`). */
interface CodexWireModel {
  slug?: string
  display_name?: string
  description?: string | null
  context_window?: number | null
  supported_reasoning_levels?: { effort?: string; description?: string }[]
  default_reasoning_level?: string | null
  service_tiers?: { id?: string; name?: string; description?: string }[]
  additional_speed_tiers?: string[]
  visibility?: string
  priority?: number
}

/** Display name for a wire reasoning-effort value. */
function effortName(effort: string): string {
  return effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * Whether a catalog entry advertises the fast tier. Mirrors codex-rs
 * `ModelPreset::supports_fast_mode`: a `service_tiers` id matching the fast
 * wire value, or the legacy `additional_speed_tiers` "fast" entry.
 */
function supportsFastTier(entry: CodexWireModel): boolean {
  return (entry.service_tiers ?? []).some(tier => tier.id === CODEX_FAST_SERVICE_TIER)
    || (entry.additional_speed_tiers ?? []).includes(CODEX_FAST_SPEED_TIER)
}

/**
 * Fetch the live codex model catalog with the session's auth headers.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns discovered models: hidden entries dropped, sorted by priority.
 */
export async function fetchCodexModels(session: CodexSession, fetchFn: FetchFn = fetch): Promise<DiscoveredModel[]> {
  const url = `${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`
  const response = await fetchFn(url, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'chatgpt-account-id': session.accountId,
      'originator': 'codex_cli_rs',
      'accept': 'application/json',
      ...attributionHeaders(),
    },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'codex models')
  const payload = await response.json() as { models?: CodexWireModel[] }
  if (!Array.isArray(payload.models)) throw new Error('codex models endpoint returned no models array')
  const discovered: DiscoveredModel[] = []
  for (const entry of payload.models) {
    if (typeof entry.slug !== 'string' || entry.slug.length === 0) continue
    // codex-rs ModelVisibility: only "list" is picker-visible; hide/none are
    // dropped, and an absent or unknown value is included (in doubt, include).
    if (entry.visibility === 'hide' || entry.visibility === 'none') continue
    const efforts = (entry.supported_reasoning_levels ?? [])
      .filter(level => typeof level.effort === 'string' && level.effort.length > 0)
      .map(level => ({
        id: ReasoningEffortId(level.effort as string),
        name: effortName(level.effort as string),
        ...level.description === undefined ? {} : { description: level.description },
      }))
    const defaultEffort = typeof entry.default_reasoning_level === 'string'
        && entry.default_reasoning_level.length > 0
        && efforts.some(effort => effort.id === ReasoningEffortId(entry.default_reasoning_level as string))
      ? ReasoningEffortId(entry.default_reasoning_level)
      : undefined
    const model: DiscoveredModel = {
      id: entry.slug,
      name: typeof entry.display_name === 'string' && entry.display_name.length > 0
        ? entry.display_name
        : entry.slug,
      ...typeof entry.description === 'string' && entry.description.length > 0
        ? { description: entry.description }
        : {},
      ...typeof entry.context_window === 'number' && entry.context_window > 0
        ? { contextWindow: entry.context_window }
        : {},
      ...typeof entry.priority === 'number' ? { priority: entry.priority } : {},
      ...efforts.length > 0
        ? { reasoning: { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } } }
        : {},
      ...supportsFastTier(entry) ? { fastTier: true } : {},
    }
    discovered.push(model)
  }
  discovered.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
  // An empty catalog from a 200 response means the backend gated us out (e.g.
  // client_version too old): surface it as a discovery failure so the adapter
  // falls back to the static catalog instead of vanishing from the picker.
  if (discovered.length === 0) {
    throw new Error(`codex models endpoint returned an empty catalog (client_version ${CODEX_CLIENT_VERSION})`)
  }
  return discovered
}

/** Constructor dependencies for {@link CodexAdapter}. */
export interface CodexAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: TokenManager<CodexSession>
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
  /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
  rateLimit?: RateLimitWait
  /**
   * Per-request speed lookup (the composer Speed toggle's host half). Returns
   * whether this session's current choice sends the model on the fast tier;
   * absent means every request stays on standard routing.
   */
  speedFor?: (sessionId: string | undefined, model: string) => Promise<boolean> | boolean
}

/**
 * The Responses request body for one generation. A fast-tier request (the
 * composer Speed toggle, the codex CLI's fast mode) carries
 * `service_tier: priority`; the tier field is omitted entirely otherwise,
 * matching the CLI (it never sends an explicit standard tier).
 */
export function codexRequestBody(
  options: GenerateOptions,
  resolved: ResponsesRequestInput,
  fast: boolean,
): Record<string, unknown> {
  return {
    model: options.model,
    instructions: resolved.instructions ?? DEFAULT_CODEX_INSTRUCTIONS,
    input: resolved.input,
    ...options.tools !== undefined && options.tools.length > 0
      ? { tools: toResponsesTools(options.tools) }
      : {},
    tool_choice: 'auto',
    parallel_tool_calls: true,
    ...options.reasoningEffort !== undefined
      ? { reasoning: { effort: String(options.reasoningEffort), summary: 'auto' } }
      : {},
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...options.sessionId !== undefined ? { prompt_cache_key: String(options.sessionId) } : {},
    ...fast ? { service_tier: CODEX_FAST_SERVICE_TIER } : {},
  }
}

/** Codex wire adapter: one instance serves the `codex` provider route. */
export class CodexAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache

  constructor(private readonly options: CodexAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  /** Discovery fetcher: resolves the session through the refresh-aware path. */
  private async fetchCatalog(): Promise<DiscoveredModel[]> {
    return fetchCodexModels(await this.options.tokens.session(), this.options.fetchFn)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ChatGPT (Codex)' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `codex: provider "${provider}" retryPolicy`,
    )
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? CODEX_MODALITIES,
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
        inputModalities: CODEX_MODALITIES,
      }))
    } catch (error: unknown) {
      // A permanent refresh failure deletes the stored session: the provider
      // is logged out, so hide it instead of showing a stale static catalog.
      if (error instanceof LlmError
        && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) return []
      if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate()
      this.options.onWarn?.(
        `codex model discovery failed; using the built-in catalog (${errorChain(error)})`,
      )
      return this.staticModels(provider)
    }
  }

  /**
   * The discovered entry for one model. Resolved through the cache's
   * stale-while-revalidate path so capability metadata stays stable across a
   * long conversation: a discovered-only effort (one missing from the static
   * CODEX_EFFORTS list) selected by the user must not vanish — and fail the
   * call — just because the TTL lapsed mid-turn.
   */
  private async discovered(model: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const models = await this.catalog.resolve(() => this.fetchCatalog())
    return models?.find(entry => entry.id === model)
  }

  /** Whether the discovered catalog advertises a fast tier for this model. */
  async supportsFastTier(model: string): Promise<boolean> {
    return (await this.discovered(model))?.fastTier === true
  }

  /** Ids of every discovered model with a fast tier (the Speed toggle's visibility list). */
  async fastCapableModels(): Promise<string[]> {
    if (!this.options.discovery) return []
    // Not logged in → no fast models, so the Speed toggle hides after logout
    // (mirrors the listModels guard above).
    const session = await this.options.tokens.peek()
    if (session === undefined) return []
    const models = await this.catalog.resolve(() => this.fetchCatalog())
    return (models ?? []).filter(model => model.fastTier === true).map(model => model.id)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    // Discovered metadata (when discovery is on) wins over the static entry;
    // the static entry wins over the built-in defaults.
    const discovered = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: configured?.inputModalities ?? CODEX_MODALITIES,
      context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? CODEX_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? CODEX_DEFAULT_MAX_TOKENS,
      reasoning: discovered?.reasoning ?? { efforts: CODEX_EFFORTS, defaultEffort: CODEX_DEFAULT_EFFORT },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      let session = await this.options.tokens.session()
      let response = await this.request(options, session, watchdog.signal)
      if (response.status === 401) {
        // One forced refresh + retry on an unexpired-but-rejected token.
        session = await this.options.tokens.session(true)
        response = await this.request(options, session, watchdog.signal)
      }
      if (!response.ok) {
        throw await httpLlmError(response, 'codex API', {
          rateLimitReset: codexRateLimitReset,
          ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
        })
      }
      if (response.body === null) {
        throw new LlmError('codex API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamResponses(response.body, () => { watchdog.pulse() })
    } catch (error: unknown) {
      throw mapFetchFailure('codex API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private async request(options: GenerateOptions, session: CodexSession, signal: AbortSignal): Promise<Response> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    const fast = this.options.speedFor !== undefined
      && await this.options.speedFor(options.sessionId, options.model)
    const body = codexRequestBody(options, toResponsesInput(messages, options.system), fast)
    return fetch(CODEX_API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'chatgpt-account-id': session.accountId,
        'originator': 'codex_cli_rs',
        'session-id': randomUUID(),
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    })
  }
}
