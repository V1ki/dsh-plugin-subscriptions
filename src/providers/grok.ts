/**
 * Grok (X Premium / xAI) subscription provider: OIDC-discovered OAuth against
 * auth.x.ai with the Grok CLI client id, and streaming against the xAI
 * Responses-style endpoint.
 */

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
import type { GrokSession } from '../auth/store.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
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

export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'
export const GROK_API_URL = 'https://api.x.ai/v1/responses'
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const GROK_CALLBACK_PATH = '/callback'
const GROK_CONTEXT_WINDOW = 256_000
const GROK_DEFAULT_MAX_TOKENS = 32_000
/** Refresh when the access token has less than this much life left. */
export const GROK_PREEMPT_MS = 2 * 60_000

/**
 * xAI serves the OpenAI-compatible rate-limit header family, whose reset
 * values are durations (`6m0s`) rather than instants.
 */
const GROK_RESET_HEADERS = [
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
] as const

/** Body fields xAI uses to name a delay or reset. */
const GROK_RESET_FIELDS = ['retry_after', 'retry_after_seconds', 'resets_at', 'reset_at'] as const

/** Reads the reset instant of the xAI window that rejected a request. */
export const grokRateLimitReset: RateLimitResetReader = (response, body, now) => {
  const headers = earliestReset(
    ...GROK_RESET_HEADERS.map(header => resetInstantFromHeader(response, header, now)),
  )
  if (headers !== undefined) return headers
  return resetFromFields(jsonBody(body), GROK_RESET_FIELDS, now)
}

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
  const response = await fetch(GROK_DISCOVERY_URL)
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
  const response = await fetch(discovery.tokenEndpoint, {
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
  const response = await fetch(session.tokenEndpoint, {
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
  fetchFn: FetchFn = fetch,
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
 * @returns model id → contributed metadata.
 */
export async function fetchGrokCliCatalog(
  session: GrokSession,
  fetchFn: FetchFn = fetch,
): Promise<Map<string, GrokCliModelMeta>> {
  const response = await fetchFn(GROK_CLI_MODELS_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      // The proxy only honors bearer tokens presented as the Grok CLI.
      'x-xai-token-auth': 'xai-grok-cli',
      'accept': 'application/json',
      ...attributionHeaders(),
    },
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
 * Fetch the live grok model list, enriched with the CLI catalog's per-model
 * metadata (display name, context window, reasoning efforts). The api.x.ai
 * list stays authoritative for which models exist; the CLI catalog is
 * enrichment only, so its failure degrades to a plain list instead of taking
 * discovery down — models it does not cover simply expose no efforts.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param onWarn - warning sink for a failed CLI catalog fetch.
 * @returns discovered chat models in endpoint order.
 */
export async function fetchGrokModels(
  session: GrokSession,
  fetchFn: FetchFn = fetch,
  onWarn?: (message: string) => void,
): Promise<DiscoveredModel[]> {
  const [response, cliCatalog] = await Promise.all([
    fetchFn(GROK_MODELS_URL, {
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'accept': 'application/json',
        ...attributionHeaders(),
      },
    }),
    fetchGrokCliCatalog(session, fetchFn).catch((error: unknown) => {
      onWarn?.(`grok CLI catalog fetch failed; reasoning efforts are unavailable (${errorChain(error)})`)
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
    discovered.push({ id: entry.id, name: entry.id, ...cliCatalog?.get(entry.id) })
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
  tokens: TokenManager<GrokSession>
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
}

/** Grok wire adapter: one instance serves the `grok` provider route. */
export class GrokAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache

  constructor(private readonly options: GrokAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  /** Discovery fetcher: resolves the session through the refresh-aware path. */
  private async fetchCatalog(): Promise<DiscoveredModel[]> {
    return fetchGrokModels(await this.options.tokens.session(), this.options.fetchFn, this.options.onWarn)
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
        inputModalities: grokModalities(model.id),
      }))
    } catch (error: unknown) {
      // A permanent refresh failure deletes the stored session: the provider
      // is logged out, so hide it instead of showing a stale static catalog.
      if (error instanceof LlmError
        && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')) return []
      if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate()
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
      inputModalities: configured?.inputModalities ?? grokModalities(model),
      context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? GROK_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
      // Efforts come from the discovered CLI catalog; models it does not
      // cover expose none, so the harness rejects explicit efforts before
      // provider I/O instead of the API 400ing.
      ...discovered?.reasoning === undefined ? {} : { reasoning: discovered.reasoning },
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
      store: false,
      stream: true,
    }
    return fetch(GROK_API_URL, {
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
