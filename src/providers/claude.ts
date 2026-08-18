/**
 * Claude Pro/Max subscription provider: OAuth against claude.ai /
 * platform.claude.com with the Claude Code client id, and streaming against
 * the Anthropic Messages API with the Claude Code identity headers.
 */

import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { ClaudeSession } from '../auth/store.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import {
  streamAnthropic,
  toAnthropicMessages,
  toAnthropicSystem,
  toAnthropicTools,
} from '../translate/anthropic.js'
import {
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  oauthEndpointError,
  OAuthEndpointError,
  TokenManager,
} from './common.js'
import type { FetchFn, ModelEntry, ProviderUsage, UsageWindow } from './common.js'

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages?beta=true'
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CLAUDE_SCOPE = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const CLAUDE_CALLBACK_PATH = '/callback'
const CLAUDE_CONTEXT_WINDOW = 200_000
const CLAUDE_DEFAULT_MAX_TOKENS = 32_000
/**
 * Reasoning effort maps to Anthropic extended thinking: the wire has no
 * `effort` field, it has a token budget. Flat table on purpose — the tiers are
 * a product choice, not a computed value.
 */
const CLAUDE_THINKING_BUDGETS: Readonly<Record<string, number>> = {
  low: 4_096,
  medium: 12_288,
  high: 24_576,
}
/** Headroom for the answer itself once the thinking budget is reserved. */
const CLAUDE_ANSWER_HEADROOM = 4_096
const CLAUDE_EFFORTS = [
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
]
const CLAUDE_DEFAULT_EFFORT = ReasoningEffortId('medium')
/** Refresh when the access token has less than this much life left. */
export const CLAUDE_PREEMPT_MS = 5 * 60_000

/**
 * The subscription endpoint only serves requests presenting as Claude Code,
 * so these headers impersonate the CLI; the harness attribution user-agent
 * cannot be sent here (one user-agent slot, and the CLI's wins).
 */
const CLAUDE_CLI_USER_AGENT = 'claude-cli/2.1.97 (external, cli)'
const CLAUDE_BETA_FLAGS = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27'

/** Static claude flow facts for the OAuth flow engine. */
export const claudeFlow: FlowSpec = {
  callbackPath: CLAUDE_CALLBACK_PATH,
  // The redirect URI embeds the port, so it must be an ephemeral one.
  listen: { host: 'localhost', ports: [0] },
  buildAuthorizeUrl({ redirectUri, state, pkce }) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: CLAUDE_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
    })
    return `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`
  },
}

/** Token endpoint response shape (subset). */
interface ClaudeTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

/** Best-effort account profile; login must not fail when this does. */
async function fetchClaudeProfile(accessToken: string): Promise<Pick<ClaudeSession, 'emailAddress' | 'subscriptionType'>> {
  try {
    const response = await fetch(CLAUDE_PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) return {}
    const profile = await response.json() as Record<string, unknown>
    const account = typeof profile.account === 'object' && profile.account !== null
      ? profile.account as Record<string, unknown>
      : {}
    const email = profile.emailAddress ?? profile.email ?? account.email_address ?? account.email
    const subscription = profile.subscriptionType ?? profile.subscription_type ?? account.subscription_type
    return {
      ...typeof email === 'string' && email.length > 0 ? { emailAddress: email } : {},
      ...typeof subscription === 'string' && subscription.length > 0 ? { subscriptionType: subscription } : {},
    }
  } catch {
    // Profile lookup is decorative; only the token exchange owns login success.
    return {}
  }
}

/** Build a session from a token response. */
async function claudeSession(
  tokens: ClaudeTokenResponse,
  fallbackRefreshToken: string | undefined,
  withProfile: boolean,
): Promise<ClaudeSession> {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('claude token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken
  if (refreshToken === undefined) throw new Error('claude token endpoint returned no refresh token')
  if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
    throw new Error('claude token endpoint returned no usable expiry')
  }
  const profile = withProfile ? await fetchClaudeProfile(tokens.access_token) : {}
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scopes: tokens.scope ?? CLAUDE_SCOPE,
    ...profile,
  }
}

/**
 * Exchange an authorization code for a claude session (JSON grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param state - the attempt's state (echoed to the token endpoint).
 * @returns the session to store.
 */
export async function exchangeClaudeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  state: string,
): Promise<ClaudeSession> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'claude')
  return claudeSession(await response.json() as ClaudeTokenResponse, undefined, true)
}

/**
 * Refresh a claude session (JSON grant echoing the issued scope).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshClaude(session: ClaudeSession): Promise<ClaudeSession> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
      scope: session.scopes,
    }),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'claude')
  const next = await claudeSession(await response.json() as ClaudeTokenResponse, session.refreshToken, false)
  return {
    ...next,
    ...session.emailAddress === undefined ? {} : { emailAddress: session.emailAddress },
    ...session.subscriptionType === undefined ? {} : { subscriptionType: session.subscriptionType },
  }
}

/**
 * Whether a claude refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isClaudePermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && (error.oauthCode === 'invalid_grant' || error.oauthCode === 'invalid_token')
}

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** RFC3339 `resets_at` value → epoch ms, or undefined when absent/unparsable. */
function claudeResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Map one legacy `{utilization, resets_at}` bucket; undefined when null or unusable. */
function claudeLegacyWindow(value: unknown, kind: UsageWindow['kind'], scope?: string): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const bucket = value as { utilization?: number; resets_at?: string }
  if (typeof bucket.utilization !== 'number' || !Number.isFinite(bucket.utilization)) return undefined
  const resetsAt = claudeResetsAt(bucket.resets_at)
  return {
    kind,
    ...scope === undefined ? {} : { scope },
    usedPercent: bucket.utilization,
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/** One entry of the modern `limits` array (subset). */
interface ClaudeLimitEntry {
  kind?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string } }
}

/** Map the modern `limits` array; empty when absent or carrying nothing usable. */
function claudeLimitsWindows(value: unknown): UsageWindow[] {
  if (!Array.isArray(value)) return []
  const windows: UsageWindow[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as ClaudeLimitEntry
    if (typeof entry.percent !== 'number' || !Number.isFinite(entry.percent)) continue
    const kind: UsageWindow['kind'] = entry.kind === 'session'
      ? 'session'
      : entry.kind === 'weekly_all' || entry.kind === 'weekly_scoped' ? 'weekly' : 'other'
    const scope = entry.scope?.model?.display_name
    const resetsAt = claudeResetsAt(entry.resets_at)
    windows.push({
      kind,
      ...typeof scope === 'string' && scope.length > 0 ? { scope } : {},
      usedPercent: entry.percent,
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }
  return windows
}

/**
 * Fetch the claude subscription usage from the OAuth usage endpoint (the
 * source of Claude Code's `/usage` screen). Newer responses carry a
 * structured `limits` array; older ones the flat `five_hour`/`seven_day*`
 * buckets — both shapes are read, the array winning when it has entries.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchClaudeUsage(
  session: ClaudeSession,
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const response = await fetchFn(CLAUDE_USAGE_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      // Unrecognized clients are aggressively rate-limited on this endpoint,
      // so it presents as the CLI like every other subscription request.
      'user-agent': CLAUDE_CLI_USER_AGENT,
      'accept': 'application/json',
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'claude usage')
  const payload = await response.json() as Record<string, unknown>
  const modern = claudeLimitsWindows(payload.limits)
  if (modern.length > 0) return { supported: true, windows: modern }
  const windows: UsageWindow[] = []
  const legacy = [
    claudeLegacyWindow(payload.five_hour, 'session'),
    claudeLegacyWindow(payload.seven_day, 'weekly'),
    claudeLegacyWindow(payload.seven_day_opus, 'weekly', 'Opus'),
    claudeLegacyWindow(payload.seven_day_sonnet, 'weekly', 'Sonnet'),
  ]
  for (const window of legacy) {
    if (window !== undefined) windows.push(window)
  }
  return { supported: true, windows }
}

/** Constructor dependencies for {@link ClaudeAdapter}. */
export interface ClaudeAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: TokenManager<ClaudeSession>
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** The Claude 4.5 family accepts image input. */
const CLAUDE_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/** Claude wire adapter: one instance serves the `claude` provider route. */
export class ClaudeAdapter extends LlmAdapter {
  constructor(private readonly options: ClaudeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude (Subscription)' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Not logged in → empty catalog, so the web picker drops the provider.
    // Claude has no subscription model-list endpoint, so the static catalog
    // is the whole answer when logged in.
    if (!await this.options.tokens.hasSession()) return []
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? CLAUDE_MODALITIES,
    }))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      inputModalities: configured?.inputModalities ?? CLAUDE_MODALITIES,
      context: { contextWindow: configured?.contextWindow ?? CLAUDE_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
      // The subscription endpoint does serve extended thinking (verified live:
      // `thinking` / `thinking_delta` blocks stream back with the Claude Code
      // beta flags this provider already sends), so the route advertises the
      // same effort selector the codex and grok routes have.
      reasoning: { efforts: CLAUDE_EFFORTS, defaultEffort: CLAUDE_DEFAULT_EFFORT },
    })
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
      if (!response.ok) throw await httpLlmError(response, 'claude API')
      if (response.body === null) {
        throw new LlmError('claude API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamAnthropic(response.body, () => { watchdog.pulse() })
    } catch (error: unknown) {
      throw mapFetchFailure('claude API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private async request(options: GenerateOptions, session: ClaudeSession, signal: AbortSignal): Promise<Response> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    const thinkingBudget = options.reasoningEffort === undefined
      ? undefined
      : CLAUDE_THINKING_BUDGETS[String(options.reasoningEffort)]
    const maxTokens = options.maxTokens
      ?? this.options.models.find(entry => entry.id === options.model)?.maxTokens
      ?? CLAUDE_DEFAULT_MAX_TOKENS
    const body = {
      model: options.model,
      // max_tokens covers the thinking budget too: below it the request is
      // rejected, and at exactly the budget there is nothing left to answer with.
      max_tokens: thinkingBudget === undefined
        ? maxTokens
        : Math.max(maxTokens, thinkingBudget + CLAUDE_ANSWER_HEADROOM),
      system: toAnthropicSystem(options.system, messages),
      messages: toAnthropicMessages(messages),
      ...options.tools !== undefined && options.tools.length > 0
        ? { tools: toAnthropicTools(options.tools) }
        : {},
      ...thinkingBudget === undefined
        ? {}
        : { thinking: { type: 'enabled', budget_tokens: thinkingBudget } },
      stream: true,
      ...options.sessionId !== undefined ? { metadata: { user_id: String(options.sessionId) } } : {},
    }
    return fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': CLAUDE_BETA_FLAGS,
        'user-agent': CLAUDE_CLI_USER_AGENT,
        'x-app': 'cli',
        'anthropic-dangerous-direct-browser-access': 'true',
        'accept': 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  }
}
