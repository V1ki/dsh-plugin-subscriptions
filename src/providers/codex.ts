/**
 * ChatGPT/Codex subscription provider: OAuth against auth.openai.com with the
 * Codex CLI client id, and streaming against the ChatGPT backend Responses
 * endpoint.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  attributionHeaders,
  BlockAssembler,
  createAssistantMessage,
  createUserMessage,
  EMPTY_RESPONSE_CODE,
  errorChain,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ContentBlock,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { decodeJwtPayload } from '../auth/jwt.js'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { CodexSession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import type { PoolAdapter } from './pool.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import type { ResponsesRequestInput } from '../translate/responses.js'
import {
  effortDisplayName,
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  mergeReasoning,
  ModelCatalogCache,
  discoverAcrossAccounts,
  discoverOrRetryAuth,
  isDiscoveryAborted,
  isMissingOrInvalidCredential,
  oauthEndpointError,
  OAuthEndpointError,
} from './common.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import type {
  CatalogPersistence,
  DiscoveredModel,
  FetchFn,
  ModelEntry,
  ProviderUsage,
  UsageWindow,
} from './common.js'
import { proxiedFetch } from '../http.js'
import {
  DEFAULT_RATE_LIMIT_WAIT,
  DEFAULT_RETRY,
  jsonBody,
  resetFromFields,
  subscriptionRetryPolicy,
} from './rate-limit.js'
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js'
import { CODEX_GUARDIAN_POLICY } from './codex-guardian-policy.js'
import type {
  ApprovalReviewAgent,
  ApprovalReviewRequest,
  ApprovalReviewer,
  AutoReviewDecision,
} from '../auto-review.js'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses'
/** Auto-review model identifier from Codex CLI 0.151.0. */
export const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review'
const CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
const CODEX_CALLBACK_PATH = '/auth/callback'
const CODEX_CONTEXT_WINDOW = 400_000
const CODEX_DEFAULT_MAX_TOKENS = 128_000
/** Refresh when the access token has less than this much life left. */
export const CODEX_PREEMPT_MS = 5 * 60_000

/**
 * Body fields the backend uses to name a reset. A window-exhaustion rejection
 * carries `usage_limit_reached` with the seconds left on the window — the case
 * that used to classify as a terminal quota and never be retried at all.
 */
const CODEX_RESET_FIELDS = ['resets_in_seconds', 'reset_after_seconds', 'resets_at', 'reset_at'] as const

/**
 * Reads the reset instant of the Codex window that rejected a request.
 *
 * Body only. The `x-codex-{primary,secondary}-reset-after-seconds` headers are
 * rollover snapshots the backend attaches to every response, one per window,
 * so they say nothing about which window refused: a burst 429 that would clear
 * in seconds still carries a primary rollover hours out, and reading it would
 * park the turn for those hours. They reach the operator through
 * `rateLimitDiagnostics` instead.
 */
export const codexRateLimitReset: RateLimitResetReader = (_response, body, now) =>
  resetFromFields(jsonBody(body), CODEX_RESET_FIELDS, now)

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
  const response = await proxiedFetch(CODEX_TOKEN_URL, {
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
  const response = await proxiedFetch(CODEX_TOKEN_URL, {
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
  fetchFn: FetchFn = proxiedFetch,
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
 * the range of current codex CLI releases. This is also the source version
 * used by the Guardian compatibility constants below.
 */
export const CODEX_CLIENT_VERSION = '0.151.0'

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
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns discovered models: hidden entries dropped, sorted by priority.
 */
export async function fetchCodexModels(
  session: CodexSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const url = `${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`
  const response = await fetchFn(url, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'chatgpt-account-id': session.accountId,
      'originator': 'codex_cli_rs',
      'accept': 'application/json',
      ...attributionHeaders(),
    },
    ...signal === undefined ? {} : { signal },
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
        name: effortDisplayName(level.effort as string),
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
  tokens: AccountTokenManager<CodexSession>
  /** Late-bound pool facade (wired after adapter construction); pools list under their first member's provider. */
  pool?: () => PoolAdapter | undefined
  /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
  discovery: boolean
  /** Warning sink for discovery failures that fall back to the static catalog. */
  onWarn?: (message: string) => void
  /** Fetch implementation for discovery (defaults to global fetch). */
  fetchFn?: FetchFn
  /** Approval-review transport seam for deterministic provider tests. */
  reviewFetchFn?: FetchFn
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Durable catalog store seeding capability metadata across restarts. */
  catalogStore?: CatalogPersistence
  /** Per-account catalog bound for the picker union (defaults to {@link DISCOVERY_TIMEOUT_MS}). */
  discoveryTimeoutMs?: number
  /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
  rateLimit?: RateLimitWait
  /**
   * Per-model default reasoning effort override (the Settings page's picker).
   * Returns the user-configured default for one model, or undefined to follow
   * the provider's own default.
   */
  defaultEffortOf?: (model: string) => string | undefined
  /**
   * Per-request speed lookup (the composer Speed toggle's host half). Returns
   * whether this session's current choice sends the model on the fast tier;
   * absent means every request stays on standard routing.
   */
  speedFor?: (sessionId: string | undefined, model: string) => Promise<boolean> | boolean
}

const CODEX_CALL_ID_MAX_LENGTH = 64
const CODEX_CALL_ID_PREFIX = 'call_'

/**
 * Bound tool-call ids at the Codex wire boundary without changing the shared
 * Responses translation used by Grok. Short ids stay verbatim. Oversized ids
 * become deterministic hashes, and every id already present in this request
 * is reserved first so a generated id cannot collide with a legitimate short
 * one (or another oversized id).
 */
function normalizeCodexCallIds(input: ResponsesRequestInput['input']): ResponsesRequestInput['input'] {
  const mapping = new Map<string, string>()
  const used = new Set<string>()
  const callId = (item: Record<string, unknown>): string | undefined =>
    (item.type === 'function_call' || item.type === 'function_call_output') && typeof item.call_id === 'string'
      ? item.call_id
      : undefined

  for (const item of input) {
    const id = callId(item)
    if (id !== undefined && id.length <= CODEX_CALL_ID_MAX_LENGTH) {
      mapping.set(id, id)
      used.add(id)
    }
  }

  for (const item of input) {
    const id = callId(item)
    if (id === undefined || mapping.has(id)) continue
    let attempt = 0
    let normalized: string
    do {
      const hash = createHash('sha256')
      if (attempt > 0) hash.update(String(attempt)).update('\0')
      const digest = hash.update(id).digest('hex')
      normalized = `${CODEX_CALL_ID_PREFIX}${digest.slice(0, CODEX_CALL_ID_MAX_LENGTH - CODEX_CALL_ID_PREFIX.length)}`
      attempt += 1
    } while (used.has(normalized))
    mapping.set(id, normalized)
    used.add(normalized)
  }

  return input.map((item) => {
    const id = callId(item)
    if (id === undefined) return item
    const normalized = mapping.get(id) ?? id
    return normalized === id ? item : { ...item, call_id: normalized }
  })
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
    input: normalizeCodexCallIds(resolved.input),
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

/**
 * Exact Codex 0.151.0 Guardian execution limits.
 * Sources: `core/src/guardian/mod.rs` (`GUARDIAN_REVIEW_TIMEOUT`) and
 * `core/src/guardian/review.rs` (`GUARDIAN_REVIEW_MAX_ATTEMPTS`).
 */
const CODEX_REVIEW_TIMEOUT_MS = 90_000
const CODEX_REVIEW_MAX_ATTEMPTS = 3

/**
 * Codex budgets Guardian in approximate tokens and defines one token as four
 * UTF-8 bytes (`utils/string/src/truncate.rs`). These are exact byte
 * conversions of the caps in `core/src/guardian/mod.rs` and `prompt.rs`:
 * 10k per transcript lane, 2k per message, 1k per tool entry, 16k for the
 * action, and 512 for the approval reason. Messages and tools have separate
 * lanes so verbose tool output cannot evict the human authorization context.
 */
const CODEX_REVIEW_APPROX_BYTES_PER_TOKEN = 4
const CODEX_REVIEW_MESSAGE_BUDGET_BYTES = 10_000 * CODEX_REVIEW_APPROX_BYTES_PER_TOKEN
const CODEX_REVIEW_TOOL_BUDGET_BYTES = 10_000 * CODEX_REVIEW_APPROX_BYTES_PER_TOKEN
const CODEX_REVIEW_MESSAGE_ENTRY_BYTES = 2_000 * CODEX_REVIEW_APPROX_BYTES_PER_TOKEN
const CODEX_REVIEW_TOOL_ENTRY_BYTES = 1_000 * CODEX_REVIEW_APPROX_BYTES_PER_TOKEN
const CODEX_REVIEW_ACTION_BYTES = 16_000 * CODEX_REVIEW_APPROX_BYTES_PER_TOKEN
const CODEX_REVIEW_APPROVAL_REASON_BYTES = 512 * CODEX_REVIEW_APPROX_BYTES_PER_TOKEN

/** Exact Codex 0.151.0 transcript recency cap (`GUARDIAN_RECENT_ENTRY_LIMIT`). */
const CODEX_REVIEW_RECENT_NON_USER_LIMIT = 40

/**
 * Exact standard-model denial breaker from Codex 0.151.0 Guardian: interrupt
 * after 3 consecutive denials or 10 denials in the latest 50 reviews of one
 * turn. Cyber-model thresholds are intentionally absent because DSH does not
 * expose Codex's `model_specialty` on the approval request.
 */
const CODEX_REVIEW_MAX_CONSECUTIVE_DENIALS = 3
const CODEX_REVIEW_MAX_RECENT_DENIALS = 10
const CODEX_REVIEW_DENIAL_WINDOW = 50

const CODEX_REVIEW_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const
const CODEX_REVIEW_AUTHORIZATION_LEVELS = ['unknown', 'low', 'medium', 'high'] as const
const CODEX_REVIEW_OUTCOMES = ['allow', 'deny'] as const

/** Exact structured result vocabulary consumed by Codex Guardian 0.151.0. */
const CODEX_REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    risk_level: { type: 'string', enum: CODEX_REVIEW_RISK_LEVELS },
    user_authorization: { type: 'string', enum: CODEX_REVIEW_AUTHORIZATION_LEVELS },
    outcome: { type: 'string', enum: CODEX_REVIEW_OUTCOMES },
    rationale: { type: 'string' },
  },
  required: ['outcome'],
} as const

type CodexTranscriptKind = 'user' | 'assistant' | 'tool'

interface CodexTranscriptEntry {
  readonly kind: CodexTranscriptKind
  readonly ordinal: number
  readonly text: string
}

interface CodexTranscriptSnapshot {
  readonly nodes: number[]
  readonly entries: CodexTranscriptEntry[]
}

interface CodexApprovalReviewSession {
  readonly parentThreadId: string
  readonly promptCacheKey: string
  readonly transportSessionId: string
  readonly reviewThreadId: string
  readonly windowId: string
  readonly messages: Message[]
  surfaceNodes: number[]
  tail: Promise<void>
  denialTurnId?: string
  consecutiveDenials: number
  recentDenials: boolean[]
  interruptionScheduled: boolean
}

interface ParsedCodexReview {
  readonly decision: CodexApprovalDecision
  readonly raw: string
}

type CodexApprovalDecision = AutoReviewDecision & { readonly decision: 'allow' | 'deny' }

class RetryableCodexReviewError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringEnum<const T extends readonly string[]>(
  value: unknown,
  options: T,
): value is T[number] {
  return typeof value === 'string' && options.includes(value)
}

function utf8Prefix(text: string, maxBytes: number): string {
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1
  return text.slice(0, end)
}

function utf8Suffix(text: string, maxBytes: number): string {
  let start = Math.max(0, text.length - maxBytes)
  while (start < text.length && Buffer.byteLength(text.slice(start), 'utf8') > maxBytes) start += 1
  return text.slice(start)
}

/** Preserve both ends, as Codex's Guardian truncator does, on UTF-8 boundaries. */
function bounded(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const marker = '\n[truncated]\n'
  const retainedBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  const prefixBytes = Math.ceil(retainedBytes / 2)
  return `${utf8Prefix(text, prefixBytes)}${marker}${utf8Suffix(text, retainedBytes - prefixBytes)}`
}

function renderBlocks(value: readonly ContentBlock[]): { messages: string[]; tools: string[] } {
  const messages: string[] = []
  const tools: string[] = []
  for (const block of value) {
    if (block.type === 'text' && block.text.trim().length > 0) {
      messages.push(block.text.trim())
    } else if (block.type === 'tool-call') {
      tools.push(`${block.name}(${block.arguments})`)
    } else if (block.type === 'tool-result') {
      const nested = renderBlocks(block.content)
      tools.push(`result ${block.toolCallId}${block.isError === true ? ' (error)' : ''}: ${[
        ...nested.messages,
        ...nested.tools,
      ].join('\n')}`)
    } else if (block.type === 'image') {
      messages.push('[image omitted from approval transcript]')
    }
    // Hidden reasoning is intentionally excluded, matching Codex Guardian.
  }
  return { messages, tools }
}

/** Collect direct user intent plus recent visible assistant/tool evidence from the DSH surface. */
function codexTranscriptSnapshot(agent: ApprovalReviewAgent, startNode = 0): CodexTranscriptSnapshot {
  const { events, surface } = agent.session
  const nodes = [...surface.nodes]
  const entries: CodexTranscriptEntry[] = []
  let ordinal = 0
  for (const node of nodes.slice(startNode)) {
    const event = events[node]
    if (event === undefined) continue
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      const rendered = renderBlocks(event.data.content)
      if (rendered.messages.length > 0) {
        entries.push({ kind: 'user', ordinal: ordinal++, text: rendered.messages.join('\n') })
      }
      continue
    }
    if (event.type === 'assistant/message') {
      const rendered = renderBlocks(event.data.message.content)
      if (rendered.messages.length > 0) {
        entries.push({ kind: 'assistant', ordinal: ordinal++, text: rendered.messages.join('\n') })
      }
      for (const tool of rendered.tools) entries.push({ kind: 'tool', ordinal: ordinal++, text: tool })
      continue
    }
    if (event.type === 'tool/result') {
      const rendered = renderBlocks(event.data.message.content)
      const text = [...rendered.messages, ...rendered.tools].join('\n')
      if (text.length > 0) entries.push({ kind: 'tool', ordinal: ordinal++, text })
    }
  }
  return { nodes, entries }
}

/** Mirror Codex's bounded transcript policy: user anchors first, then recent assistant/tool evidence. */
function selectCodexTranscript(entries: readonly CodexTranscriptEntry[]): string[] {
  const rendered = entries.map(entry => {
    const cap = entry.kind === 'tool' ? CODEX_REVIEW_TOOL_ENTRY_BYTES : CODEX_REVIEW_MESSAGE_ENTRY_BYTES
    const text = `[${entry.ordinal + 1}] ${entry.kind.toUpperCase()}: ${bounded(entry.text, cap)}`
    return { entry, text, size: Buffer.byteLength(text, 'utf8') }
  })
  const included = new Set<number>()
  let messageBytes = 0
  let toolBytes = 0
  const users = rendered
    .map((entry, index) => ({ ...entry, index }))
    .filter(item => item.entry.kind === 'user')
  const includeUser = (item: typeof users[number] | undefined): void => {
    if (item === undefined || included.has(item.index)) return
    if (messageBytes + item.size > CODEX_REVIEW_MESSAGE_BUDGET_BYTES) return
    included.add(item.index)
    messageBytes += item.size
  }
  includeUser(users[0])
  includeUser(users.at(-1))
  for (const user of [...users].reverse()) includeUser(user)

  let recentNonUser = 0
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const item = rendered[index]
    if (item === undefined || item.entry.kind === 'user'
      || recentNonUser >= CODEX_REVIEW_RECENT_NON_USER_LIMIT) continue
    const fits = item.entry.kind === 'tool'
      ? toolBytes + item.size <= CODEX_REVIEW_TOOL_BUDGET_BYTES
      : messageBytes + item.size <= CODEX_REVIEW_MESSAGE_BUDGET_BYTES
    if (!fits) continue
    included.add(index)
    recentNonUser += 1
    if (item.entry.kind === 'tool') toolBytes += item.size
    else messageBytes += item.size
  }
  return rendered.filter((_entry, index) => included.has(index)).map(entry => entry.text)
}

function isNodePrefix(prefix: readonly number[], nodes: readonly number[]): boolean {
  return prefix.length <= nodes.length && prefix.every((node, index) => nodes[index] === node)
}

function guardianPromptCacheKey(parentThreadId: string): string {
  const direct = `guardian:${parentThreadId}`
  if (direct.length <= 64) return direct
  return `guardian:${createHash('sha256').update(parentThreadId).digest('hex').slice(0, 55)}`
}

function approvalTurnId(agent: ApprovalReviewAgent): string {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'turn/start') return String(event.data.turn)
  }
  return '<unknown-turn>'
}

function safeActionJson(request: ApprovalReviewRequest): string {
  let serialized: string
  try {
    serialized = JSON.stringify({
      tool: request.action.name,
      call_id: request.action.callId,
      arguments: request.action.arguments,
      ...request.reason === undefined
        ? {}
        : { approval_reason: bounded(request.reason, CODEX_REVIEW_APPROVAL_REASON_BYTES) },
    }, null, 2)
  } catch {
    serialized = JSON.stringify({
      tool: request.action.name,
      call_id: request.action.callId,
      arguments: '[unserializable arguments]',
      ...request.reason === undefined
        ? {}
        : { approval_reason: bounded(request.reason, CODEX_REVIEW_APPROVAL_REASON_BYTES) },
    }, null, 2)
  }
  return bounded(serialized, CODEX_REVIEW_ACTION_BYTES)
}

function codexReviewPrompt(
  request: ApprovalReviewRequest,
  state: CodexApprovalReviewSession,
): { prompt: string; nodes: number[] } {
  const current = codexTranscriptSnapshot(request.agent)
  const delta = state.messages.length > 0 && isNodePrefix(state.surfaceNodes, current.nodes)
  const snapshot = delta ? codexTranscriptSnapshot(request.agent, state.surfaceNodes.length) : current
  const transcript = selectCodexTranscript(snapshot.entries)
  return {
    nodes: current.nodes,
    prompt: [
      delta
        ? 'Transcript entries added since the previous approval review:'
        : 'Compact transcript for authorization and local context:',
      transcript.length > 0 ? transcript.join('\n') : '<no new retained transcript entries>',
      '>>> APPROVAL REQUEST START',
      'Assess the exact planned action below.',
      safeActionJson(request),
      '>>> APPROVAL REQUEST END',
    ].join('\n'),
  }
}

function codexReviewRequestBody(
  messages: Message[],
  state: CodexApprovalReviewSession,
  installationId: string,
): Record<string, unknown> {
  const options: GenerateOptions = {
    provider: 'codex',
    model: CODEX_AUTO_REVIEW_MODEL,
    reasoningEffort: ReasoningEffortId('low'),
    messages,
    sessionId: state.promptCacheKey as NonNullable<GenerateOptions['sessionId']>,
  }
  return {
    ...codexRequestBody(options, toResponsesInput(messages, CODEX_GUARDIAN_POLICY), false),
    parallel_tool_calls: false,
    text: {
      format: {
        type: 'json_schema',
        // Basic Guardian sessions explicitly disable strict schema validation
        // (`core/src/session/turn.rs` in Codex 0.151.0). Its schema intentionally
        // requires only `outcome`; the diagnostic fields remain optional.
        strict: false,
        name: 'codex_output_schema',
        schema: CODEX_REVIEW_OUTPUT_SCHEMA,
      },
    },
    client_metadata: {
      'x-codex-installation-id': installationId,
      'session_id': state.transportSessionId,
      'thread_id': state.reviewThreadId,
      'x-codex-window-id': state.windowId,
      'x-openai-subagent': 'guardian',
      'x-codex-parent-thread-id': state.parentThreadId,
    },
  }
}

/** Parse exactly like Codex Guardian: tolerate one prose wrapper and optional detail fields. */
export function parseCodexApprovalReview(raw: string): CodexApprovalDecision | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      value = JSON.parse(raw.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
  if (!isRecord(value)) return undefined
  if (!isStringEnum(value.outcome, CODEX_REVIEW_OUTCOMES)) return undefined
  if (value.risk_level !== undefined && !isStringEnum(value.risk_level, CODEX_REVIEW_RISK_LEVELS)) {
    return undefined
  }
  if (value.user_authorization !== undefined
    && !isStringEnum(value.user_authorization, CODEX_REVIEW_AUTHORIZATION_LEVELS)) return undefined
  if (value.rationale !== undefined && typeof value.rationale !== 'string') return undefined
  const rationale = value.rationale?.trim()
  const reason = rationale === undefined || rationale.length === 0
    ? value.outcome === 'allow'
      ? 'Auto-review returned a low-risk allow decision.'
      : 'Auto-review returned a deny decision without a rationale.'
    : rationale
  return { decision: value.outcome, reason }
}

/** Codex wire adapter: one instance serves the `codex` provider route. */
export class CodexAdapter extends LlmAdapter implements ApprovalReviewer {
  readonly reviewerId = 'codex'
  readonly reviewerLabel = 'Codex'
  private readonly installationId = randomUUID()
  private readonly catalog: ModelCatalogCache
  /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
  private readonly accountCatalogs = new Map<string, ModelCatalogCache>()
  /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
  private catalogOwner: string | undefined
  /** One locked, reusable Guardian conversation per parent agent session. */
  private readonly approvalReviewSessions = new WeakMap<ApprovalReviewAgent, CodexApprovalReviewSession>()

  constructor(private readonly options: CodexAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  /** Discovery fetcher: resolves the session through the refresh-aware path. */
  private async fetchCatalog(account?: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    return fetchCodexModels(await this.options.tokens.session(account), this.options.fetchFn, signal)
  }

  /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.accountCatalogs.clear()
    else this.accountCatalogs.delete(account)
    if (account === undefined || this.catalogOwner === account || this.catalogOwner === undefined) {
      this.catalogOwner = undefined
      this.catalog.invalidate()
    }
  }

  /** Persisted cache for the default account; a throwaway cache for any other. */
  private async catalogFor(account?: string): Promise<ModelCatalogCache> {
    const defaultKey = await this.options.tokens.defaultAccount()
    const key = account ?? defaultKey
    if (key === undefined || key === defaultKey) {
      if (this.catalogOwner !== undefined && this.catalogOwner !== defaultKey) {
        this.catalog.invalidate()
      }
      this.catalogOwner = defaultKey
      return this.catalog
    }
    let cache = this.accountCatalogs.get(key)
    if (cache === undefined) {
      cache = new ModelCatalogCache()
      this.accountCatalogs.set(key, cache)
    }
    return cache
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
    const own = await this.listOwnModels(provider)
    const pool = this.options.pool?.()
    if (pool === undefined) return own
    const extra = await pool.modelsForProvider(provider as ProviderId)
    const seen = new Set(own.map(model => model.id))
    // Account pools reuse the catalog row; only configured tiers are extra.
    return [...own, ...extra.filter(model => !seen.has(model.id))]
  }

  /** The provider's own catalog: union of every account, or one account when named. */
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    if (account === undefined) {
      const accounts = (await this.options.tokens.list()).map(entry => entry.key)
      if (accounts.length === 0) return []
      return unionAccountCatalogs(
        accounts,
        (key, accountSignal) => this.listOwnModels(provider, key, accountSignal),
        { timeoutMs: this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } },
      )
    }
    if (!await this.options.tokens.hasSession(account)) {
      return []
    }
    if (!this.options.discovery) return this.staticModels(provider)
    const catalog = await this.catalogFor(account)
    try {
      // The fetcher runs only on a cache miss, and resolves the session
      // through the refresh-aware path so an expired access token renews here
      // instead of failing discovery into the static fallback.
      const discovered = await discoverOrRetryAuth(
        force => this.options.tokens.session(account, force),
        catalog,
        () => catalog.get(() => this.fetchCatalog(account, signal)),
      )
      return discovered.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: CODEX_MODALITIES,
        ...model.priority === undefined ? {} : { priority: model.priority },
      } as LlmModelInfo))
    } catch (error: unknown) {
      // A cancelled discovery must not fall back to the static catalog — the
      // caller (pool assembly) treats abort as "this account sits out".
      if (isDiscoveryAborted(error, signal)) throw error
      // A permanent refresh failure deletes the stored session: the provider
      // is logged out, so hide it instead of showing a stale static catalog.
      if (isMissingOrInvalidCredential(error)) return []
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
    const accounts = (await this.options.tokens.list()).map(entry => entry.key)
    return discoverAcrossAccounts(accounts, async account => {
      const catalog = await this.catalogFor(account)
      const models = await catalog.resolve(() => this.fetchCatalog(account))
      return models?.find(entry => entry.id === model)
    })
  }

  /** Whether the discovered catalog advertises a fast tier for this model. */
  async supportsFastTier(model: string): Promise<boolean> {
    return (await this.discovered(model))?.fastTier === true
  }

  /** Ids of every discovered model with a fast tier (the Speed toggle's visibility list). */
  async fastCapableModels(): Promise<string[]> {
    if (!this.options.discovery) return []
    // Not logged in → no fast models, so the Speed toggle hides after logout
    // (mirrors the listModels guard above). Union every account: a fast-capable
    // model only the non-default lists (e.g. gpt-5.6-sol) must still show Speed.
    const accounts = (await this.options.tokens.list()).map(entry => entry.key)
    if (accounts.length === 0) return []
    const seen = new Set<string>()
    const ids: string[] = []
    for (const account of accounts) {
      try {
        const catalog = await this.catalogFor(account)
        const models = await catalog.resolve(() => this.fetchCatalog(account))
        for (const model of models ?? []) {
          if (model.fastTier !== true || seen.has(model.id)) continue
          seen.add(model.id)
          ids.push(model.id)
        }
      } catch {
        // sit out
      }
    }
    return ids
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(provider as ProviderId, model)) {
      return pool.resolveModel(provider, model)
    }
    return this.resolveOwnModel(provider, model)
  }

  /** Capability resolution of the provider's own models (the pool resolves members here). */
  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    // Discovered metadata (when discovery is on) wins over the static entry;
    // the static entry wins over the built-in defaults. A configured default
    // effort merges over both.
    const discovered = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    // `extendable` only while falling back to the built-in list: that one is
    // known to trail the backend, so a configured level it omits still has to
    // be selectable. A discovered catalog is the truth about what the model
    // accepts, and a stale override must not be forced onto every request.
    const reasoning = mergeReasoning(
      this.options.defaultEffortOf?.(model),
      discovered?.reasoning ?? { efforts: CODEX_EFFORTS, defaultEffort: CODEX_DEFAULT_EFFORT },
      { extendable: discovered?.reasoning === undefined },
    )
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: configured?.inputModalities ?? CODEX_MODALITIES,
      context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? CODEX_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? CODEX_DEFAULT_MAX_TOKENS,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /**
   * Review one real native approval request with Codex. Calls for the same
   * agent are serialized so the reusable transcript cursor and cached reviewer
   * conversation cannot race.
   */
  reviewApproval(request: ApprovalReviewRequest): Promise<AutoReviewDecision | undefined> {
    let state = this.approvalReviewSessions.get(request.agent)
    if (state === undefined) {
      const identity = request.agent.id
      state = {
        parentThreadId: identity,
        promptCacheKey: guardianPromptCacheKey(identity),
        transportSessionId: randomUUID(),
        reviewThreadId: randomUUID(),
        windowId: randomUUID(),
        messages: [],
        surfaceNodes: [],
        tail: Promise.resolve(),
        consecutiveDenials: 0,
        recentDenials: [],
        interruptionScheduled: false,
      }
      this.approvalReviewSessions.set(request.agent, state)
    }
    const review = state.tail.then(() => this.runApprovalReview(request, state))
    state.tail = review.then(() => undefined, () => undefined)
    return review
  }

  private async runApprovalReview(
    request: ApprovalReviewRequest,
    state: CodexApprovalReviewSession,
  ): Promise<AutoReviewDecision | undefined> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(CODEX_REVIEW_TIMEOUT_MS)])
    const { prompt, nodes } = codexReviewPrompt(request, state)
    const userMessage = createUserMessage({
      source: { kind: 'plugin', plugin: 'dsh-plugin-subscriptions' },
      content: [{ type: 'text', text: prompt }],
    })
    const messages = [...state.messages, userMessage]
    const body = codexReviewRequestBody(messages, state, this.installationId)
    let parsed: ParsedCodexReview | undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= CODEX_REVIEW_MAX_ATTEMPTS; attempt += 1) {
      try {
        parsed = await this.performApprovalReview(body, state, signal)
        break
      } catch (error) {
        lastError = error
        if (signal.aborted || attempt === CODEX_REVIEW_MAX_ATTEMPTS
          || (!(error instanceof RetryableCodexReviewError) && !(error instanceof TypeError))) {
          throw error
        }
      }
    }
    if (parsed === undefined) throw lastError ?? new Error('Codex approval review failed')
    state.messages.push(
      userMessage,
      createAssistantMessage({
        source: { provider: 'codex', model: CODEX_AUTO_REVIEW_MODEL },
        content: [{ type: 'text', text: parsed.raw }],
      }),
    )
    state.surfaceNodes = nodes
    this.recordApprovalReviewDecision(request, state, parsed.decision.decision)
    return parsed.decision
  }

  /** Match Codex Guardian's per-turn 3-consecutive / 10-of-50 denial breaker. */
  private recordApprovalReviewDecision(
    request: ApprovalReviewRequest,
    state: CodexApprovalReviewSession,
    decision: CodexApprovalDecision['decision'],
  ): void {
    const turnId = approvalTurnId(request.agent)
    if (state.denialTurnId !== turnId) {
      state.denialTurnId = turnId
      state.consecutiveDenials = 0
      state.recentDenials = []
      state.interruptionScheduled = false
    }
    const denied = decision === 'deny'
    state.consecutiveDenials = denied ? state.consecutiveDenials + 1 : 0
    state.recentDenials.push(denied)
    if (state.recentDenials.length > CODEX_REVIEW_DENIAL_WINDOW) state.recentDenials.shift()
    const recentDenials = state.recentDenials.filter(Boolean).length
    if (!denied || state.interruptionScheduled
      || (state.consecutiveDenials < CODEX_REVIEW_MAX_CONSECUTIVE_DENIALS
        && recentDenials < CODEX_REVIEW_MAX_RECENT_DENIALS)) return
    state.interruptionScheduled = true
    const cancel = request.agent.cancel
    // Codex schedules the abort after recording the review. Defer here too so
    // the approval service can commit its rejected audit outcome first.
    setTimeout(() => {
      try {
        Reflect.apply(cancel, request.agent, [{
          kind: 'hook',
          reason: 'Automatic approval review rejected too many requests in this turn.',
        }])
      } catch {
        // A disappearing agent must not turn a valid denial into manual fallback.
      }
    }, 0)
  }

  private async performApprovalReview(
    body: Record<string, unknown>,
    state: CodexApprovalReviewSession,
    signal: AbortSignal,
  ): Promise<ParsedCodexReview> {
    let session = await this.options.tokens.session()
    let response = await this.requestApprovalReview(body, session, state, signal)
    if (response.status === 401) {
      session = await this.options.tokens.session(undefined, true)
      response = await this.requestApprovalReview(body, session, state, signal)
    }
    if (!response.ok) {
      const error = await httpLlmError(response, 'codex approval review API', {
        rateLimitReset: codexRateLimitReset,
        ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
      })
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new RetryableCodexReviewError(error.message)
      }
      throw error
    }
    if (response.body === null) throw new RetryableCodexReviewError('codex approval review API returned no response body')
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of streamResponses(response.body)) assembler.push(chunk)
    } catch (error) {
      throw new RetryableCodexReviewError(error instanceof Error ? error.message : String(error))
    }
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new RetryableCodexReviewError(finish.failure.message)
    }
    if (finish.kind === 'max-tokens') {
      throw new RetryableCodexReviewError('codex approval review API exhausted its output limit')
    }
    const raw = assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
      .trim()
    const decision = parseCodexApprovalReview(raw)
    if (decision === undefined) throw new RetryableCodexReviewError('codex approval review API returned malformed JSON')
    return { decision, raw }
  }

  private requestApprovalReview(
    body: Record<string, unknown>,
    session: CodexSession,
    state: CodexApprovalReviewSession,
    signal: AbortSignal,
  ): Promise<Response> {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'chatgpt-account-id': session.accountId,
        'originator': 'codex_cli_rs',
        'session-id': state.transportSessionId,
        'thread-id': state.reviewThreadId,
        'x-client-request-id': state.reviewThreadId,
        'x-openai-subagent': 'guardian',
        'x-codex-installation-id': this.installationId,
        'x-codex-window-id': state.windowId,
        'x-codex-parent-thread-id': state.parentThreadId,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    }
    // Codex routes basic auto-review to /responses by default. The unmetered
    // /guardian route is gated by its private `[features.guardianv2]
    // free_guardian = true` flag plus backend/session/model checks; this plugin
    // exposes no such flag, so claiming that route would diverge from Codex.
    return (this.options.reviewFetchFn ?? proxiedFetch)(CODEX_API_URL, init)
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(options.provider as ProviderId, options.model)) {
      yield* pool.stream(options)
      return
    }
    yield* this.streamCore(options)
  }

  /** Pool seam: stream through one specific account instead of the default. */
  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      let session = await this.options.tokens.session(account)
      let response = await this.request(options, session, watchdog.signal)
      if (response.status === 401) {
        // One forced refresh + retry on an unexpired-but-rejected token.
        session = await this.options.tokens.session(account, true)
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
    return proxiedFetch(CODEX_API_URL, {
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
