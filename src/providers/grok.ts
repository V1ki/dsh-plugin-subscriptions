/**
 * Grok (X Premium / xAI) subscription provider: OIDC-discovered OAuth against
 * auth.x.ai with the Grok CLI client id, and streaming against the xAI
 * Responses-style endpoint.
 */

import { createHash } from 'node:crypto'
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
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { decodeJwtPayload } from '../auth/jwt.js'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { GrokSession } from '../auth/store.js'
import type { ProviderId } from '../auth/store.js'
import type { PoolAdapter } from './pool.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import {
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
import { GROK_ESCALATION_POLICY } from './grok-auto-policy.js'
import type {
  ApprovalReviewAgent,
  ApprovalReviewDecision,
  ApprovalReviewRequest,
  ApprovalReviewer,
} from '../auto-review.js'

export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'
export const GROK_API_URL = 'https://api.x.ai/v1/responses'
/** Cheap dedicated reviewer; never inherit the session model or effort. */
export const GROK_AUTO_REVIEW_MODEL = 'grok-4-fast-reasoning'
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const GROK_CALLBACK_PATH = '/callback'
const GROK_CONTEXT_WINDOW = 256_000
const GROK_DEFAULT_MAX_TOKENS = 32_000
/** Refresh when the access token has less than this much life left. */
export const GROK_PREEMPT_MS = 2 * 60_000

/** Body fields xAI uses to name a delay or reset. */
const GROK_RESET_FIELDS = ['retry_after', 'retry_after_seconds', 'resets_at', 'reset_at'] as const

/**
 * Reads the reset instant of the xAI window that rejected a request.
 *
 * Body only. xAI serves the OpenAI-compatible `x-ratelimit-reset-*` family,
 * whose values are rollover durations (`6m0s`) present on every response, one
 * per bucket — on a 429 the earliest of them is usually a bucket with room
 * (`0s` for the request bucket while the token bucket is the one exhausted),
 * which would burn the whole retry budget in seconds. They reach the operator
 * through `rateLimitDiagnostics` instead.
 */
export const grokRateLimitReset: RateLimitResetReader = (_response, body, now) =>
  resetFromFields(jsonBody(body), GROK_RESET_FIELDS, now)

/** Discovered OIDC endpoints for the xAI authorization server. */
export interface GrokDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
}

/** A discovered URL must be https on x.ai or a subdomain; anything else is a hostile document. */
function assertXaiEndpoint(url: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`grok OIDC discovery returned an invalid ${field}`)
  }
  if (parsed.protocol !== 'https:'
    || (parsed.hostname !== 'x.ai' && !parsed.hostname.endsWith('.x.ai'))) {
    throw new Error(`grok OIDC discovery returned a non-x.ai ${field}: ${url}`)
  }
  return url
}

let discoveryCache: GrokDiscovery | undefined

/**
 * Resolve the xAI OIDC endpoints (cached after the first fetch).
 * @returns validated authorization and token endpoints.
 */
export async function grokDiscovery(): Promise<GrokDiscovery> {
  if (discoveryCache !== undefined) return discoveryCache
  const response = await proxiedFetch(GROK_DISCOVERY_URL)
  if (!response.ok) throw await oauthEndpointError(response, 'grok OIDC discovery')
  const document = await response.json() as {
    authorization_endpoint?: string
    token_endpoint?: string
  }
  if (typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string') {
    throw new Error('grok OIDC discovery document is missing endpoints')
  }
  discoveryCache = {
    authorizationEndpoint: assertXaiEndpoint(document.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: assertXaiEndpoint(document.token_endpoint, 'token_endpoint'),
  }
  return discoveryCache
}

/**
 * Build the grok flow facts for the OAuth flow engine (async because the
 * authorize URL comes from OIDC discovery).
 * @returns the flow spec for one attempt.
 */
export async function grokFlow(): Promise<FlowSpec> {
  const discovery = await grokDiscovery()
  return {
    callbackPath: GROK_CALLBACK_PATH,
    listen: { host: '127.0.0.1', ports: [56121] },
    buildAuthorizeUrl({ redirectUri, state, pkce, nonce }) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: GROK_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: GROK_SCOPE,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        plan: 'generic',
        referrer: 'dsh-plugin-subscriptions',
      })
      return `${discovery.authorizationEndpoint}?${params.toString()}`
    },
  }
}

/** Token endpoint response shape (subset). */
interface GrokTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  scope?: string
}

/**
 * Display names for the numeric `tier` claim xAI stamps on OAuth access
 * tokens (the `prod_auth.SubscriptionTier` proto enum; the mapping mirrors
 * grok-build's `jwt_tier_claim`). Unknown values fall through to the raw
 * number so a future tier still shows something.
 */
const GROK_TIER_NAMES: Record<number, string> = {
  0: 'Free',
  1: 'SuperGrok',
  2: 'X Basic',
  3: 'X Premium',
  4: 'X Premium+',
  5: 'SuperGrok Heavy',
  6: 'SuperGrok Lite',
  7: 'SuperGrok Plus',
}

/**
 * The subscription tier encoded in a grok access token's `tier` claim (no
 * verification — same trust posture as the other claim reads).
 * @param accessToken - the stored access token.
 * @returns the display tier name, or undefined when the claim is absent.
 */
export function grokTierName(accessToken: string): string | undefined {
  const tier = decodeJwtPayload(accessToken)?.tier
  if (typeof tier !== 'number' || !Number.isInteger(tier)) return undefined
  return GROK_TIER_NAMES[tier] ?? String(tier)
}

/** Pick a display account from an id token's claims. */
function grokAccount(idToken: string | undefined): string | undefined {
  const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  const claim = payload?.email ?? payload?.preferred_username ?? payload?.name ?? payload?.sub
  return typeof claim === 'string' && claim.length > 0 ? claim : undefined
}

/** Build a session from a token response. */
function grokSession(
  tokens: GrokTokenResponse,
  tokenEndpoint: string,
  fallbackRefreshToken?: string,
): GrokSession {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('grok token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken
  if (refreshToken === undefined) throw new Error('grok token endpoint returned no refresh token')
  if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
    throw new Error('grok token endpoint returned no usable expiry')
  }
  const account = grokAccount(tokens.id_token)
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    tokenEndpoint,
    ...typeof tokens.scope === 'string' ? { scopes: tokens.scope } : {},
    ...account === undefined ? {} : { account },
  }
}

/**
 * Exchange an authorization code for a grok session (form-encoded grant that
 * echoes the PKCE challenge as well as the verifier, per the xAI flow).
 * A 403 here means the X plan lacks the API OAuth entitlement.
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param challenge - the PKCE challenge sent at authorize time.
 * @returns the session to store.
 */
export async function exchangeGrokCode(
  code: string,
  verifier: string,
  redirectUri: string,
  challenge: string,
): Promise<GrokSession> {
  const discovery = await grokDiscovery()
  const response = await proxiedFetch(discovery.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GROK_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString(),
  })
  if (response.status === 403) {
    throw new OAuthEndpointError(
      'grok token endpoint refused the exchange (HTTP 403): your X plan does not include '
      + 'the API OAuth entitlement; an X Premium or xAI subscription with API access is required',
      403,
    )
  }
  if (!response.ok) throw await oauthEndpointError(response, 'grok')
  return grokSession(await response.json() as GrokTokenResponse, discovery.tokenEndpoint)
}

/**
 * Refresh a grok session (form-encoded grant).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshGrok(session: GrokSession): Promise<GrokSession> {
  const response = await proxiedFetch(session.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GROK_CLIENT_ID,
      refresh_token: session.refreshToken,
    }).toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'grok')
  const next = grokSession(await response.json() as GrokTokenResponse, session.tokenEndpoint, session.refreshToken)
  return {
    ...next,
    ...session.account === undefined ? {} : { account: session.account },
    ...next.scopes === undefined && session.scopes !== undefined ? { scopes: session.scopes } : {},
  }
}

/**
 * Whether a grok refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isGrokPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError && error.oauthCode === 'invalid_grant'
}

/**
 * The Grok Build CLI chat proxy's billing endpoint (the source of the CLI's
 * `/usage` "Usage limit" panel; see xai-org/grok-build
 * `extensions/billing.rs`). Forwards to the backend `GetGrokCreditsConfig`.
 */
export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

/** RFC3339 timestamp → epoch ms, or undefined when absent/unparsable. */
function grokResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The billing payload subset this plugin reads (both credits-config shapes). */
interface GrokBillingConfig {
  /** Included credit usage as a percentage of the allowance (0–100; newer shape). */
  creditUsagePercent?: number
  /** Current usage period; `type` is e.g. `USAGE_PERIOD_TYPE_WEEKLY`, `end` the reset time. */
  currentPeriod?: { type?: string; start?: string; end?: string }
  /** Deprecated shape: included credit budget in USD cents. */
  monthlyLimit?: { val?: number }
  /** Deprecated shape: credits used this period in USD cents. */
  used?: { val?: number }
  /** Deprecated shape: RFC3339 end of the billing period. */
  billingPeriodEnd?: string
}

/**
 * Fetch the grok subscription usage from the Grok Build CLI chat proxy. The
 * newer credits config carries a ready-made percentage plus the current
 * (typically weekly) period; the legacy shape carries cent-valued
 * `monthlyLimit`/`used`, from which the percentage is derived.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchGrokUsage(
  session: GrokSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const response = await fetchFn(GROK_BILLING_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      // The proxy only honors bearer tokens presented as the Grok CLI.
      'x-xai-token-auth': 'xai-grok-cli',
      'accept': 'application/json',
      ...attributionHeaders(),
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'grok billing')
  const payload = await response.json() as { config?: GrokBillingConfig | null; subscriptionTier?: string }
  const config = typeof payload.config === 'object' && payload.config !== null ? payload.config : {}
  const windows: UsageWindow[] = []
  if (typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)) {
    const kind: UsageWindow['kind'] = config.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY'
      ? 'weekly'
      : 'other'
    const resetsAt = grokResetsAt(config.currentPeriod?.end)
    windows.push({ kind, usedPercent: config.creditUsagePercent, ...resetsAt === undefined ? {} : { resetsAt } })
  } else if (typeof config.monthlyLimit?.val === 'number' && config.monthlyLimit.val > 0) {
    const used = typeof config.used?.val === 'number' ? config.used.val : 0
    const resetsAt = grokResetsAt(config.billingPeriodEnd)
    windows.push({
      kind: 'other',
      usedPercent: (used / config.monthlyLimit.val) * 100,
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }
  // The upstream billing response rarely carries `subscriptionTier` (the CLI
  // enriches it locally from its settings cache), so the access token's
  // `tier` claim is the working fallback.
  const plan = typeof payload.subscriptionTier === 'string' && payload.subscriptionTier.length > 0
    ? payload.subscriptionTier
    : grokTierName(session.accessToken)
  return {
    supported: true,
    windows,
    ...plan === undefined ? {} : { plan },
  }
}

export const GROK_MODELS_URL = 'https://api.x.ai/v1/models'

/**
 * Input modalities for one grok model: chat models (grok-4 family) accept
 * images; code and embedding models are text-only.
 */
function grokModalities(id: string): readonly ('text' | 'image')[] {
  return /code|embed/i.test(id) ? ['text'] : ['text', 'image']
}

/**
 * The Grok Build CLI chat proxy's model catalog — the only grok endpoint that
 * advertises reasoning capability. The `api.x.ai/v1/models` and
 * `/v1/language-models` payloads carry pricing, context, and aliases only, so
 * effort metadata must come from here (the same source the official CLI's
 * picker uses).
 */
export const GROK_CLI_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models'

/** The CLI catalog `/v1/models` entry subset this plugin reads. */
interface GrokCliWireModel {
  id?: string
  name?: string
  description?: string
  context_window?: number
  supports_reasoning_effort?: boolean
  reasoning_effort?: string
  reasoning_efforts?: { value?: string; label?: string; description?: string }[]
}

/** Per-model metadata the CLI catalog contributes to a discovered model. */
type GrokCliModelMeta = Partial<Pick<DiscoveredModel, 'name' | 'description' | 'contextWindow' | 'reasoning'>>

/** Map one CLI catalog entry's reasoning fields, or undefined when unsupported. */
function grokCliReasoning(entry: GrokCliWireModel): NonNullable<DiscoveredModel['reasoning']> | undefined {
  if (entry.supports_reasoning_effort !== true) return undefined
  const efforts = (entry.reasoning_efforts ?? [])
    .filter(level => typeof level.value === 'string' && level.value.length > 0)
    .map(level => ({
      id: ReasoningEffortId(level.value as string),
      name: typeof level.label === 'string' && level.label.length > 0 ? level.label : (level.value as string),
      ...typeof level.description === 'string' && level.description.length > 0
        ? { description: level.description }
        : {},
    }))
  if (efforts.length === 0) return undefined
  // The per-entry `default` flags are unreliable (the live catalog marks
  // several levels default at once), so the top-level `reasoning_effort`
  // field is the trusted default.
  const defaultEffort = typeof entry.reasoning_effort === 'string'
      && efforts.some(effort => effort.id === ReasoningEffortId(entry.reasoning_effort as string))
    ? ReasoningEffortId(entry.reasoning_effort)
    : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/**
 * Fetch the CLI catalog and index its per-model metadata by model id.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns model id → contributed metadata.
 */
export async function fetchGrokCliCatalog(
  session: GrokSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<Map<string, GrokCliModelMeta>> {
  const response = await fetchFn(GROK_CLI_MODELS_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      // The proxy only honors bearer tokens presented as the Grok CLI.
      'x-xai-token-auth': 'xai-grok-cli',
      'accept': 'application/json',
      ...attributionHeaders(),
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'grok CLI catalog')
  const payload = await response.json() as { data?: GrokCliWireModel[] }
  if (!Array.isArray(payload.data)) throw new Error('grok CLI catalog returned no data array')
  const catalog = new Map<string, GrokCliModelMeta>()
  for (const entry of payload.data) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    const reasoning = grokCliReasoning(entry)
    catalog.set(entry.id, {
      ...typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {},
      ...typeof entry.description === 'string' && entry.description.length > 0
        ? { description: entry.description }
        : {},
      ...typeof entry.context_window === 'number' && entry.context_window > 0
        ? { contextWindow: entry.context_window }
        : {},
      ...reasoning === undefined ? {} : { reasoning },
    })
  }
  return catalog
}

/**
 * The /v1/models list also serves generation models that cannot chat
 * (grok-imagine-image*, grok-imagine-video*) and embedding models; the picker
 * must not offer them. Heuristic over the id substring, verified against the
 * live catalog (grok-build-0.1 and the grok-4 family pass).
 */
function isChatModel(id: string): boolean {
  return !/imagine|image-|video|embed/i.test(id)
}

/**
 * CLI-contributed fields carried forward from a previously discovered model.
 * @param prior - the last-known entry for this id, if any.
 * @returns enrichment to apply when the live CLI catalog cannot contribute.
 */
function grokPriorMeta(prior: DiscoveredModel | undefined): GrokCliModelMeta {
  if (prior === undefined) return {}
  return {
    ...(prior.name.length > 0 ? { name: prior.name } : {}),
    ...(prior.description === undefined ? {} : { description: prior.description }),
    ...(prior.contextWindow === undefined ? {} : { contextWindow: prior.contextWindow }),
    ...(prior.reasoning === undefined ? {} : { reasoning: prior.reasoning }),
  }
}

/**
 * Fetch the live grok model list, enriched with the CLI catalog's per-model
 * metadata (display name, context window, reasoning efforts). The api.x.ai
 * list stays authoritative for which models exist; the CLI catalog is
 * enrichment only, so its failure degrades to a plain list instead of taking
 * discovery down. When enrichment is missing, last-known capability metadata
 * is carried forward so a transient CLI outage cannot strip efforts a
 * session already selected.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param onWarn - warning sink for a failed CLI catalog fetch.
 * @param previous - last-known catalog used to keep enrichment when the CLI
 *   catalog is down or omits a model.
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns discovered chat models in endpoint order.
 */
export async function fetchGrokModels(
  session: GrokSession,
  fetchFn: FetchFn = proxiedFetch,
  onWarn?: (message: string) => void,
  previous?: readonly DiscoveredModel[],
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const previousById = previous === undefined || previous.length === 0
    ? undefined
    : new Map(previous.map(model => [model.id, model]))
  const [response, cliCatalog] = await Promise.all([
    fetchFn(GROK_MODELS_URL, {
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'accept': 'application/json',
        ...attributionHeaders(),
      },
      ...signal === undefined ? {} : { signal },
    }),
    fetchGrokCliCatalog(session, fetchFn, signal).catch((error: unknown) => {
      if (isDiscoveryAborted(error, signal)) throw error
      onWarn?.(previousById === undefined
        ? `grok CLI catalog fetch failed; reasoning efforts are unavailable (${errorChain(error)})`
        : `grok CLI catalog fetch failed; keeping last-known reasoning efforts (${errorChain(error)})`)
      return undefined
    }),
  ])
  if (!response.ok) throw await oauthEndpointError(response, 'grok models')
  const payload = await response.json() as { data?: { id?: string }[] }
  if (!Array.isArray(payload.data)) throw new Error('grok models endpoint returned no data array')
  const seen = new Set<string>()
  const discovered: DiscoveredModel[] = []
  for (const entry of payload.data) {
    if (typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id)) continue
    if (!isChatModel(entry.id)) continue
    seen.add(entry.id)
    const cli = cliCatalog?.get(entry.id)
    discovered.push({
      id: entry.id,
      name: entry.id,
      ...(cli ?? grokPriorMeta(previousById?.get(entry.id))),
    })
  }
  // An empty catalog from a 200 response is treated as a discovery failure so
  // the adapter falls back to the static catalog instead of vanishing from
  // the picker.
  if (discovered.length === 0) throw new Error('grok models endpoint returned an empty catalog')
  return discovered
}

/** Constructor dependencies for {@link GrokAdapter}. */
export interface GrokAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<GrokSession>
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
  /**
   * Per-model default reasoning effort override (the Settings page's picker).
   * Returns the user-configured default for one model, or undefined to follow
   * the provider's own default.
   */
  defaultEffortOf?: (model: string) => string | undefined
  /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
  rateLimit?: RateLimitWait
}

const GROK_REVIEW_TIMEOUT_MS = 90_000
const GROK_REVIEW_MAX_ATTEMPTS = 3
const GROK_REVIEW_MAX_OUTPUT_TOKENS = 2_048
const GROK_REVIEW_MAX_CONSECUTIVE_DENIALS = 3
const GROK_REVIEW_RETRY_INITIAL_DELAY_MS = 250
const GROK_REVIEW_HISTORY_MAX_MESSAGES = 16
/**
 * Mirror Codex Guardian budgets: one token is four UTF-8 bytes, 10k per
 * transcript lane, 2k per user entry, 1k per tool entry, 16k for the action,
 * 512 for the approval reason, and 40 recent tool rows.
 */
const GROK_REVIEW_APPROX_BYTES_PER_TOKEN = 4
const GROK_REVIEW_MESSAGE_BUDGET_BYTES = 10_000 * GROK_REVIEW_APPROX_BYTES_PER_TOKEN
const GROK_REVIEW_TOOL_BUDGET_BYTES = 10_000 * GROK_REVIEW_APPROX_BYTES_PER_TOKEN
const GROK_REVIEW_MESSAGE_ENTRY_BYTES = 2_000 * GROK_REVIEW_APPROX_BYTES_PER_TOKEN
const GROK_REVIEW_TOOL_ENTRY_BYTES = 1_000 * GROK_REVIEW_APPROX_BYTES_PER_TOKEN
const GROK_REVIEW_ACTION_BYTES = 16_000 * GROK_REVIEW_APPROX_BYTES_PER_TOKEN
const GROK_REVIEW_APPROVAL_REASON_BYTES = 512 * GROK_REVIEW_APPROX_BYTES_PER_TOKEN
const GROK_REVIEW_RECENT_TOOL_LIMIT = 40
const GROK_REVIEW_SHELL_HEADS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const GROK_REVIEW_WRAPPER_HEADS = new Set(['sudo', 'env', 'command', 'nice', 'nohup'])
const GROK_REVIEW_OUTCOMES = ['allow', 'deny'] as const
const GROK_REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    thinking: { type: 'string' },
    outcome: { type: 'string', enum: GROK_REVIEW_OUTCOMES },
    reason: { type: 'string' },
  },
  required: ['outcome'],
} as const

class RetryableGrokReviewError extends Error {}

type GrokApprovalDecision = ApprovalReviewDecision & { readonly decision: 'allow' | 'deny' }

interface GrokTranscriptEntry {
  readonly kind: 'user' | 'tool'
  readonly text: string
}

interface GrokApprovalReviewSession {
  readonly promptCacheKey: string
  readonly messages: Message[]
  surfaceNodes: number[]
  tail: Promise<void>
  denialTurnId?: string
  consecutiveDenials: number
  interruptionScheduled: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function grokReviewCacheKey(parentId: string): string {
  const direct = `grok-review:${parentId}`
  if (direct.length <= 64) return direct
  return `grok-review:${createHash('sha256').update(parentId).digest('hex').slice(0, 51)}`
}

function approvalTurnId(agent: ApprovalReviewAgent): string {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'turn/start') return String(event.data.turn)
  }
  return '<unknown-turn>'
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

function bounded(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const marker = '\n[truncated]\n'
  const retainedBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  const prefixBytes = Math.ceil(retainedBytes / 2)
  return `${utf8Prefix(text, prefixBytes)}${marker}${utf8Suffix(text, retainedBytes - prefixBytes)}`
}

function neutralizeTranscriptLine(line: string): string {
  const heading = line.trimStart()
  if (heading.startsWith('#') || /^(USER|TOOL):/i.test(heading)) {
    return `${line.slice(0, line.length - heading.length)}\\${heading}`
  }
  return line
}

function formatLabeledEntry(kind: GrokTranscriptEntry['kind'], text: string): string {
  const label = kind === 'user' ? 'USER' : 'TOOL'
  const lines = text.split('\n').map(neutralizeTranscriptLine)
  return [`${label}: ${lines[0] ?? ''}`, ...lines.slice(1).map(line => `  ${line}`)].join('\n')
}

async function waitForGrokReviewRetry(attempt: number, signal: AbortSignal): Promise<void> {
  const delayMs = GROK_REVIEW_RETRY_INITIAL_DELAY_MS * (2 ** (attempt - 1))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function shellWords(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(word => word.length > 0)
}

function commandHead(word: string): string {
  const base = word.split(/[/\\]/).pop() ?? word
  return base.toLowerCase()
}

function unquoteWord(word: string): string {
  if (word.length >= 2) {
    const start = word[0]
    const end = word[word.length - 1]
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) return word.slice(1, -1)
  }
  return word
}

function skipCommandWrappers(words: readonly string[]): string[] {
  let index = 0
  while (index < words.length && GROK_REVIEW_WRAPPER_HEADS.has(commandHead(words[index] ?? ''))) {
    index += 1
  }
  return words.slice(index)
}

function isRootRm(segment: string): boolean {
  const words = skipCommandWrappers(shellWords(segment))
  if (words.length === 0 || commandHead(words[0] ?? '') !== 'rm') return false
  return words.slice(1).some(word => {
    const target = unquoteWord(word)
    return target === '/' || target === '/*'
  })
}

function isShellSubstitutedDownload(command: string): boolean {
  const words = skipCommandWrappers(shellWords(command))
  if (words.length === 0 || !GROK_REVIEW_SHELL_HEADS.has(commandHead(words[0] ?? ''))) return false
  if (!words.includes('-c')) return false
  return /(?:\$\(|`)\s*(?:sudo\s+)?(?:curl|wget)\b/i.test(command)
}

function isDownloaderToShell(command: string): boolean {
  if (/\b(curl|wget)\b/i.test(command) && /<\(/.test(command)) return true
  if (isShellSubstitutedDownload(command)) return true
  const pieces = command.split('|')
  let sawDownloader = false
  for (const piece of pieces) {
    const head = commandHead(skipCommandWrappers(shellWords(piece))[0] ?? '')
    if (head === 'curl' || head === 'wget') sawDownloader = true
    if (sawDownloader && GROK_REVIEW_SHELL_HEADS.has(head)) return true
  }
  return false
}

function hardDeniedCommand(command: string): boolean {
  const blob = command.toLowerCase()
  if (blob.includes('mkfs') || blob.includes('dd if=') || blob.includes(':(){ :|:& };:')) return true
  if (isDownloaderToShell(command)) return true
  for (const segment of command.split(/(?:&&|\|\||;|\n)/)) {
    for (const piece of segment.split('|')) {
      if (isRootRm(piece)) return true
    }
  }
  return false
}

function actionCommand(request: ApprovalReviewRequest): string {
  if (!isRecord(request.action.arguments)) return ''
  const command = request.action.arguments.command
  return typeof command === 'string' ? command : ''
}

function sandboxMode(request: ApprovalReviewRequest): string {
  if (!isRecord(request.action.arguments)) return 'unspecified'
  const mode = request.action.arguments.sandbox_permissions
  return typeof mode === 'string' && mode.length > 0 ? mode : 'unspecified'
}

function recordedDecisions(agent: ApprovalReviewAgent): string[] {
  const records: string[] = []
  for (const event of agent.session.events) {
    if (event.type !== 'approval/decided') continue
    const id = String(event.data.id)
    if (id.startsWith('auto-review-')) continue
    records.push(JSON.stringify({
      id,
      decision: event.data.outcome,
    }))
  }
  return records
}

function grokTranscriptSnapshot(agent: ApprovalReviewAgent, startNode = 0): {
  nodes: number[]
  entries: GrokTranscriptEntry[]
} {
  const nodes = [...agent.session.surface.nodes]
  const entries: GrokTranscriptEntry[] = []
  for (const node of nodes.slice(startNode)) {
    const event = agent.session.events[node]
    if (event === undefined) continue
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      const text = event.data.content
        .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
        .map(block => block.text.trim())
        .filter(part => part.length > 0)
        .join('\n')
      if (text.length > 0) entries.push({ kind: 'user', text })
      continue
    }
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type !== 'tool-call') continue
      entries.push({
        kind: 'tool',
        text: `${block.name}(${block.arguments})`,
      })
    }
  }
  return { nodes, entries }
}

function isNodePrefix(prefix: readonly number[], nodes: readonly number[]): boolean {
  return prefix.length <= nodes.length && prefix.every((node, index) => nodes[index] === node)
}

function selectGrokTranscript(entries: readonly GrokTranscriptEntry[]): string[] {
  const rendered = entries.map(entry => {
    const cap = entry.kind === 'tool' ? GROK_REVIEW_TOOL_ENTRY_BYTES : GROK_REVIEW_MESSAGE_ENTRY_BYTES
    const text = formatLabeledEntry(entry.kind, bounded(entry.text, cap))
    return { entry, text, size: Buffer.byteLength(text, 'utf8') }
  })
  const included = new Set<number>()
  let messageBytes = 0
  let toolBytes = 0
  const users = rendered
    .map((item, index) => ({ ...item, index }))
    .filter(item => item.entry.kind === 'user')
  const includeUser = (item: typeof users[number] | undefined): void => {
    if (item === undefined || included.has(item.index)) return
    if (messageBytes + item.size > GROK_REVIEW_MESSAGE_BUDGET_BYTES) return
    included.add(item.index)
    messageBytes += item.size
  }
  includeUser(users[0])
  includeUser(users.at(-1))
  for (const user of [...users].reverse()) includeUser(user)

  let recentTools = 0
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const item = rendered[index]
    if (item === undefined || item.entry.kind !== 'tool' || recentTools >= GROK_REVIEW_RECENT_TOOL_LIMIT) {
      continue
    }
    if (toolBytes + item.size > GROK_REVIEW_TOOL_BUDGET_BYTES) continue
    included.add(index)
    recentTools += 1
    toolBytes += item.size
  }
  return rendered.filter((_item, index) => included.has(index)).map(item => item.text)
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
        : { approval_reason: bounded(request.reason, GROK_REVIEW_APPROVAL_REASON_BYTES) },
    }, null, 2)
  } catch {
    serialized = JSON.stringify({
      tool: request.action.name,
      call_id: request.action.callId,
      arguments: '[unserializable arguments]',
      ...request.reason === undefined
        ? {}
        : { approval_reason: bounded(request.reason, GROK_REVIEW_APPROVAL_REASON_BYTES) },
    }, null, 2)
  }
  return bounded(serialized, GROK_REVIEW_ACTION_BYTES)
}

function grokReviewPrompt(
  request: ApprovalReviewRequest,
  state: GrokApprovalReviewSession,
): { prompt: string; nodes: number[] } {
  const current = grokTranscriptSnapshot(request.agent)
  const delta = state.messages.length > 0 && isNodePrefix(state.surfaceNodes, current.nodes)
  const snapshot = delta ? grokTranscriptSnapshot(request.agent, state.surfaceNodes.length) : current
  const transcript = selectGrokTranscript(snapshot.entries)
  const decisions = recordedDecisions(request.agent)
  return {
    nodes: current.nodes,
    prompt: [
      decisions.length > 0
        ? `Harness-recorded permission decisions (trusted):\n${decisions.join('\n')}`
        : '',
      '## Recent conversation',
      delta ? 'New transcript entries since the previous approval review follow.' : '',
      transcript.length > 0 ? transcript.join('\n') : '<no new retained transcript entries>',
      '## End conversation',
      '## Trusted harness findings',
      `- sandbox_escalation: this action already reached native approval after a sandbox boundary. requested_mode=${sandboxMode(request)}. Evaluate the unsandboxed action, not the retry event.`,
      '## Proposed action',
      safeActionJson(request),
    ].filter(part => part.length > 0).join('\n'),
  }
}

/** Parse Grok escalation JSON. Never infer allow from a loose shouldBlock substring. */
export function parseGrokApprovalReview(raw: string): GrokApprovalDecision | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      value = JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
  if (!isRecord(value)) return undefined
  const outcome = value.outcome
  if (outcome !== 'allow' && outcome !== 'deny') return undefined
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  return {
    decision: outcome,
    reason: reason.length > 0
      ? reason
      : outcome === 'allow'
        ? 'Auto-review allowed this sandbox escalation.'
        : 'Auto-review denied this sandbox escalation.',
  }
}

/** Grok wire adapter: one instance serves the `grok` provider route. */
export class GrokAdapter extends LlmAdapter implements ApprovalReviewer {
  readonly reviewerId = 'grok'
  readonly reviewerLabel = 'Grok'
  readonly failClosed = true
  private readonly catalog: ModelCatalogCache
  /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
  private readonly accountCatalogs = new Map<string, ModelCatalogCache>()
  /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
  private catalogOwner: string | undefined
  private readonly approvalReviewSessions = new WeakMap<ApprovalReviewAgent, GrokApprovalReviewSession>()

  constructor(private readonly options: GrokAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  /** Discovery fetcher: resolves the session through the refresh-aware path. */
  private async fetchCatalog(account?: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const lastKnown = account === undefined || account === await this.options.tokens.defaultAccount()
      ? this.catalog.lastKnown()
      : this.accountCatalogs.get(account)?.lastKnown()
    return fetchGrokModels(
      await this.options.tokens.session(account),
      this.options.fetchFn,
      this.options.onWarn,
      lastKnown,
      signal,
    )
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

  private listed(provider: string, discovered: readonly DiscoveredModel[]): LlmModelInfo[] {
    return discovered.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: grokModalities(model.id),
    }))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Grok (Subscription)' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `grok: provider "${provider}" retryPolicy`,
    )
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? grokModalities(model.id),
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
        { timeoutMs: DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } },
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
      return this.listed(provider, await discoverOrRetryAuth(
        force => this.options.tokens.session(account, force),
        catalog,
        () => catalog.get(() => this.fetchCatalog(account, signal)),
      ))
    } catch (error: unknown) {
      if (isDiscoveryAborted(error, signal)) throw error
      // A permanent refresh failure deletes the stored session: the provider
      // is logged out, so hide it instead of showing a stale static catalog.
      if (isMissingOrInvalidCredential(error)) return []
      this.options.onWarn?.(
        `grok model discovery failed; using the built-in catalog (${errorChain(error)})`,
      )
      return this.staticModels(provider)
    }
  }

  /**
   * The discovered entry for one model. Resolved through the cache's
   * stale-while-revalidate path: capability metadata must stay stable across
   * a long conversation — a session that selected a reasoning effort calls
   * this on EVERY step, and forgetting the efforts just because the TTL
   * lapsed mid-turn would fail the call with UNSUPPORTED_REASONING_EFFORT
   * before provider I/O.
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

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(provider as ProviderId, model)) {
      return pool.resolveModel(provider, model)
    }
    return this.resolveOwnModel(provider, model)
  }

  /** Capability resolution of the provider's own models (the pool resolves members here). */
  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const discovered = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    // Efforts come from the discovered CLI catalog; models it does not
    // cover expose none, so the harness rejects explicit efforts before
    // provider I/O instead of the API 400ing. A configured default effort
    // still merges in: the picker then preselects it even for models the
    // CLI catalog does not cover.
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: configured?.inputModalities ?? grokModalities(model),
      context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? GROK_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  /** Hide Grok from the selector when no account is logged in. */
  isAvailable(): Promise<boolean> {
    return this.options.tokens.hasSession()
  }

  /**
   * Review one native approval request. Transport, parse, and login failures
   * throw so the gate can record `unavailable` without a human prompt.
   */
  reviewApproval(request: ApprovalReviewRequest): Promise<ApprovalReviewDecision | undefined> {
    let state = this.approvalReviewSessions.get(request.agent)
    if (state === undefined) {
      state = {
        promptCacheKey: grokReviewCacheKey(request.agent.id),
        messages: [],
        surfaceNodes: [],
        tail: Promise.resolve(),
        consecutiveDenials: 0,
        interruptionScheduled: false,
      }
      this.approvalReviewSessions.set(request.agent, state)
    }
    const review = state.tail.then(() => this.runApprovalReview(request, state))
    state.tail = review.then(() => undefined, () => undefined)
    return review.catch((error: unknown) => {
      if (!request.signal.aborted) {
        this.options.onWarn?.(
          `grok auto-review unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      throw error
    })
  }

  private async runApprovalReview(
    request: ApprovalReviewRequest,
    state: GrokApprovalReviewSession,
  ): Promise<GrokApprovalDecision> {
    if (hardDeniedCommand(actionCommand(request))) {
      const denied = {
        decision: 'deny' as const,
        reason: 'Hard-denied a known-dangerous command pattern.',
      }
      this.recordApprovalReviewDecision(request, state, 'deny')
      return denied
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(GROK_REVIEW_TIMEOUT_MS)])
    const { prompt, nodes } = grokReviewPrompt(request, state)
    const userMessage = createUserMessage({
      source: { kind: 'plugin', plugin: 'dsh-plugin-subscriptions' },
      content: [{ type: 'text', text: prompt }],
    })
    const messages = [...state.messages, userMessage]
    let parsed: { decision: GrokApprovalDecision; raw: string } | undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= GROK_REVIEW_MAX_ATTEMPTS; attempt += 1) {
      try {
        parsed = await this.performApprovalReview(messages, state, signal)
        break
      } catch (error) {
        lastError = error
        if (signal.aborted || attempt === GROK_REVIEW_MAX_ATTEMPTS
          || (!(error instanceof RetryableGrokReviewError) && !(error instanceof TypeError))) {
          throw error
        }
        await waitForGrokReviewRetry(attempt, signal)
      }
    }
    if (parsed === undefined) {
      throw lastError ?? new Error('Grok approval review failed')
    }
    state.messages.push(
      userMessage,
      createAssistantMessage({
        source: { provider: 'grok', model: GROK_AUTO_REVIEW_MODEL },
        content: [{ type: 'text', text: parsed.raw }],
      }),
    )
    while (state.messages.length > GROK_REVIEW_HISTORY_MAX_MESSAGES) {
      state.messages.splice(0, 2)
    }
    state.surfaceNodes = nodes
    this.recordApprovalReviewDecision(request, state, parsed.decision.decision)
    return parsed.decision
  }

  private recordApprovalReviewDecision(
    request: ApprovalReviewRequest,
    state: GrokApprovalReviewSession,
    decision: GrokApprovalDecision['decision'],
  ): void {
    const turnId = approvalTurnId(request.agent)
    if (state.denialTurnId !== turnId) {
      state.denialTurnId = turnId
      state.consecutiveDenials = 0
      state.interruptionScheduled = false
    }
    const denied = decision === 'deny'
    state.consecutiveDenials = denied ? state.consecutiveDenials + 1 : 0
    if (!denied || state.interruptionScheduled
      || state.consecutiveDenials < GROK_REVIEW_MAX_CONSECUTIVE_DENIALS) return
    state.interruptionScheduled = true
    const cancel = request.agent.cancel
    setTimeout(() => {
      try {
        Reflect.apply(cancel, request.agent, [{
          kind: 'hook',
          reason: 'Automatic approval review rejected too many requests in this turn.',
        }])
      } catch {
        // A disappearing agent must not turn a valid denial into a prompt.
      }
    }, 0)
  }

  private async performApprovalReview(
    messages: Message[],
    state: GrokApprovalReviewSession,
    signal: AbortSignal,
  ): Promise<{ decision: GrokApprovalDecision; raw: string }> {
    let session = await this.options.tokens.session()
    let response = await this.requestApprovalReview(messages, session, state, signal)
    if (response.status === 401) {
      session = await this.options.tokens.session(undefined, true)
      response = await this.requestApprovalReview(messages, session, state, signal)
    }
    if (!response.ok) {
      const error = await httpLlmError(response, 'grok approval review API', {
        rateLimitReset: grokRateLimitReset,
        ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
      })
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new RetryableGrokReviewError(error.message)
      }
      throw error
    }
    if (response.body === null) throw new RetryableGrokReviewError('grok approval review API returned no response body')
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of streamResponses(response.body)) assembler.push(chunk)
    } catch (error) {
      throw new RetryableGrokReviewError(error instanceof Error ? error.message : String(error))
    }
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new RetryableGrokReviewError(finish.failure.message)
    }
    if (finish.kind === 'max-tokens') {
      throw new RetryableGrokReviewError('grok approval review API exhausted its output limit')
    }
    const raw = assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
      .trim()
    const decision = parseGrokApprovalReview(raw)
    if (decision === undefined) throw new RetryableGrokReviewError('grok approval review API returned malformed JSON')
    return { decision, raw }
  }

  private requestApprovalReview(
    messages: Message[],
    session: GrokSession,
    state: GrokApprovalReviewSession,
    signal: AbortSignal,
  ): Promise<Response> {
    const { instructions, input } = toResponsesInput(messages, GROK_ESCALATION_POLICY)
    const body = {
      model: GROK_AUTO_REVIEW_MODEL,
      ...instructions === undefined ? {} : { instructions },
      input,
      parallel_tool_calls: false,
      prompt_cache_key: state.promptCacheKey,
      max_output_tokens: GROK_REVIEW_MAX_OUTPUT_TOKENS,
      text: {
        format: {
          type: 'json_schema',
          // Optional thinking/reason fields; strict mode 400s on some Responses paths.
          strict: false,
          name: 'grok_escalation_review',
          schema: GROK_REVIEW_OUTPUT_SCHEMA,
        },
      },
      store: false,
      stream: true,
    }
    return (this.options.reviewFetchFn ?? proxiedFetch)(GROK_API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    })
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
        throw await httpLlmError(response, 'grok API', {
          rateLimitReset: grokRateLimitReset,
          ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
        })
      }
      if (response.body === null) {
        throw new LlmError('grok API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamResponses(response.body, () => { watchdog.pulse() })
    } catch (error: unknown) {
      throw mapFetchFailure('grok API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private async request(options: GenerateOptions, session: GrokSession, signal: AbortSignal): Promise<Response> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    const { instructions, input } = toResponsesInput(messages, options.system)
    const body = {
      model: options.model,
      ...instructions === undefined ? {} : { instructions },
      input,
      ...options.tools !== undefined && options.tools.length > 0
        ? { tools: toResponsesTools(options.tools) }
        : {},
      tool_choice: 'auto',
      parallel_tool_calls: true,
      ...options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {},
      // The harness only passes an effort the resolved model advertised (the
      // CLI catalog's), so this never reaches a model that rejects it.
      ...options.reasoningEffort !== undefined
        ? { reasoning: { effort: String(options.reasoningEffort) } }
        : {},
      // Cache-affinity hint (mirrors codex): xAI caches prompts per server,
      // and `prompt_cache_key` is the Responses-API signal that routes repeat
      // requests back to the cache-holding shard — without it every turn's
      // cache hit is shard-routing luck. The session id is the stable key
      // xAI's own docs recommend.
      ...options.sessionId !== undefined ? { prompt_cache_key: String(options.sessionId) } : {},
      store: false,
      stream: true,
    }
    return proxiedFetch(GROK_API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    })
  }
}
