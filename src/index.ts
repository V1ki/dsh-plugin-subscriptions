/**
 * dsh-plugin-subscriptions: register OAuth-subscription LLM providers
 * (ChatGPT/Codex, Claude, Grok, GitHub Copilot) on `ctx.llm`, and expose the `/subscriptions-auth`
 * RPC channel the web Settings page uses to run the logins. The token store
 * lives at `~/.dsh/plugins/subscriptions/auth.json`; the channel registers only when
 * a host `connection` service exists, so headless compositions load fine.
 * @module dsh-plugin-subscriptions
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  LlmAdapter,
  LlmModelInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
// Type-only: activates the `ctx.tools` Context merge for the inject block.
import type {} from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { DeviceFlowManager, type DeviceAttempt } from './auth/device-flow.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readClaudeCodeCredentials, refreshClaudeSynced } from './auth/claude-code-creds.js'
import { BadRequest, registerAuthRpc } from './auth/rpc.js'
import type {
  AuthController,
  AutoReviewController,
  AutoReviewMode,
  ImageBytesResult,
  LoginMethod,
  ModelDefaultsCatalog,
  ModelDefaultsController,
  ModelDefaultView,
  ProviderStatus,
  SpeedController,
  SpeedTier,
  VideoBytesResult,
} from './auth/rpc.js'
import {
  defaultEffortOf,
  loadModelDefaults,
  setDefaultEffort,
} from './model-defaults.js'
import {
  accountKeyOf,
  deleteAccountSession,
  listAccounts,
  saveAccountSession,
  setDefaultAccount,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  ClaudeSession,
  CodexSession,
  CopilotSession,
  GrokSession,
  ProviderId,
  StoredSession,
} from './auth/store.js'
import { DISCOVERY_TIMEOUT_MS, validateModels, withTimeout } from './providers/common.js'
import type { ModelEntry, ProviderUsage } from './providers/common.js'
import { AccountTokenManager } from './providers/accounts.js'
import type { AccountAwareAdapter } from './providers/accounts.js'
import { DEFAULT_RATE_LIMIT_MAX_WAIT_MS, resolveRateLimitWait } from './providers/rate-limit.js'
import type { RateLimitConfig } from './providers/rate-limit.js'
import { catalogStore } from './providers/catalog-store.js'
import { PoolAdapter } from './providers/pool.js'
import { buildAccountPools, poolKey } from './providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef } from './providers/pool-family.js'
import { PoolHealthRegistry } from './providers/pool-health.js'
import { PoolUsageTracker } from './providers/pool-usage.js'
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
import {
  CopilotAdapter,
  COPILOT_PREEMPT_MS,
  completeCopilotLogin,
  copilotDeviceFlow,
  isCopilotPermanentRefreshError,
  refreshCopilot,
} from './providers/copilot.js'
import { createXSearchTool } from './tools/x-search.js'
import { createImageGenerateTool } from './tools/image-generate.js'
import { createVideoGenerateTool, videosDirectory } from './tools/video-generate.js'
import { proxiedFetch, proxyGetConfig, proxySetConfig, proxyTestConnection } from './http.js'
import {
  ApprovalReviewRouter,
  installAutoReview,
  type ApprovalReviewer,
} from './auto-review.js'
import { AutoReviewDefaultStore } from './auto-review-default.js'
import { inheritedSessionSetting } from './session-settings.js'

export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js'
export type { RateLimitConfig, RateLimitWait } from './providers/rate-limit.js'
export type { ProviderStatus } from './auth/rpc.js'
export type { ClaudeSession, CodexSession, CopilotSession, GrokSession, ProviderId } from './auth/store.js'

export const name = 'dsh-plugin-subscriptions'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Bound on one pool quota poll — member selection must not hang on a usage endpoint. */
export const POOL_USAGE_TIMEOUT_MS = DISCOVERY_TIMEOUT_MS
export { withTimeout } from './providers/common.js'

/** Plugin config, validated by the same-named schemastery schema. */
type ConfiguredAutoReviewMode = 'none' | 'codex'

export interface Config {
  /** Provider routes to register; defaults to all four. */
  providers?: ProviderId[]
  /** Reviewer for sandbox-boundary escalation requests; `none` keeps manual approvals only. */
  autoReview?: ConfiguredAutoReviewMode
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Whether and how long a route waits out a closed rate-limit window. */
  rateLimit?: RateLimitConfig
  /** Advisory model catalogs overriding the built-in defaults, per provider. */
  models?: {
    codex?: ModelEntry[]
    claude?: ModelEntry[]
    grok?: ModelEntry[]
    copilot?: ModelEntry[]
  }
  /** Same-subscription account pools (and optional extra tier models). */
  pool?: {
    /** Enable account pooling (default true; needs ≥2 accounts of one provider). */
    enabled?: boolean
    /** Member selection: plain priority failover, or quota-aware urgency scheduling. */
    strategy?: 'priority' | 'quota_aware'
    /** A challenger must out-score the sticky member by this factor to take over (default 2). */
    switchMargin?: number
    /** Auto-pool every catalog model across a provider's logged-in accounts (default true). */
    autoAccounts?: boolean
    /** @deprecated Use {@link autoAccounts}. */
    autoFamilies?: boolean
    /** Explicit account lists for one catalog model (same provider); replaces the auto pool. */
    families?: Record<string, PoolMemberRef[]>
    /** Extra picker entries with heterogeneous fallbacks, listed under the first member's provider. */
    tiers?: Record<string, PoolMemberRef[]>
  }
}

const providerIdSchema = z.union(['codex', 'claude', 'grok', 'copilot'])
const modelEntrySchema: z<ModelEntry> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
  wire: z.union(['chat-completions', 'responses']),
})

const poolMemberSchema: z<PoolMemberRef> = z.object({
  provider: providerIdSchema.required(),
  account: z.string(),
  model: z.string().required(),
})

export const Config: z<Config> = z.object({
  providers: z.array(providerIdSchema).default(['codex', 'claude', 'grok', 'copilot']),
  autoReview: z.union([
    z.const('none').description('None'),
    z.const('codex').description('Codex'),
  ])
    .default('none')
    .description('Automatic reviewer for sandbox escalation requests. None uses manual approvals only.'),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  rateLimit: z.object({
    wait: z.boolean().default(true),
    maxWaitMs: z.number().min(1).default(DEFAULT_RATE_LIMIT_MAX_WAIT_MS),
  }),
  models: z.object({
    codex: z.array(modelEntrySchema),
    claude: z.array(modelEntrySchema),
    grok: z.array(modelEntrySchema),
    copilot: z.array(modelEntrySchema),
  }),
  pool: z.object({
    enabled: z.boolean().default(true),
    strategy: z.union(['priority', 'quota_aware']).default('quota_aware'),
    switchMargin: z.number().min(1).default(2),
    autoAccounts: z.boolean().default(true),
    autoFamilies: z.boolean(),
    families: z.dict(z.array(poolMemberSchema)),
    tiers: z.dict(z.array(poolMemberSchema)),
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
    { id: 'claude-opus-5', name: 'Claude Opus 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', maxTokens: 64_000 },
  ],
  grok: [
    { id: 'grok-4', name: 'Grok 4' },
    { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning' },
    { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
  ],
  // Static fallback only: the live /models catalog (with per-model vision
  // flags and context windows) wins whenever discovery succeeds.
  copilot: [
    { id: 'gpt-4.1', name: 'GPT-4.1', inputModalities: ['text', 'image'] },
    { id: 'gpt-4o', name: 'GPT-4o', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', inputModalities: ['text', 'image'] },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', inputModalities: ['text', 'image'] },
  ],
}

/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {  const resolve = (provider: ProviderId): ModelEntry[] => {
    // Schemastery injects `[]` for omitted array fields, so an empty list
    // cannot be told apart from an absent one: both mean the built-ins.
    const configured = models?.[provider]
    const entries = configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODELS[provider]
    return validateModels(entries, `${name}: models.${provider}`)
  }
  return { codex: resolve('codex'), claude: resolve('claude'), grok: resolve('grok'), copilot: resolve('copilot') }
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
    case 'copilot': return (session as CopilotSession).account
  }
}

/** The plan name a stored session carries, when the provider told us. */
function planOf(provider: ProviderId, session: StoredSession): string | undefined {
  switch (provider) {
    case 'codex': return (session as CodexSession).planType
    case 'claude': return (session as ClaudeSession).subscriptionType
    case 'grok': return undefined
    case 'copilot': return undefined
  }
}

/** Per-provider per-account usage lookup; providers without a usage endpoint are absent. */
type UsageFetchers = Partial<Record<ProviderId, (account: string, signal: AbortSignal) => Promise<ProviderUsage>>>

/**
 * Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
 * OAuth attempts in the background, feed pasted codes, cancel, log out, and
 * answer usage lookups.
 *
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export class SubscriptionsAuthController implements AuthController {
  /** Last login failure per provider, surfaced as `detail` until the next success. */
  private lastError = new Map<ProviderId, string>()
  /**
   * Device-flow logins whose poll already settled but whose token exchange +
   * persist is still running. Between those two moments the attempt is gone
   * from the flow manager (busy=false) while no session exists yet
   * (loggedIn=false) — counting this window as busy keeps the Settings page
   * polling until the card can show the real outcome.
   */
  private finalizing = new Set<ProviderId>()

  /** In-flight OAuth completions, one per provider at most. */
  private completions = new Map<ProviderId, Promise<void>>()

  /**
   * Per-provider claim counter. Everything that takes ownership of a
   * provider's session — starting a login, importing Claude Code credentials,
   * cancelling, logging out — bumps it, and a session write carrying an older
   * number has been superseded and is dropped.
   *
   * The counter is what makes a late OAuth completion safe: an attempt leaves
   * `OAuthFlowManager`'s pending map the moment its callback delivers the
   * code, while the token exchange that follows can still run for seconds. For
   * that whole window `pending(provider)?.cancel()` is a no-op, so ownership
   * cannot be read off the flow manager.
   */
  private claims = new Map<ProviderId, number>()

  constructor(
    private readonly flows: OAuthFlowManager,
    /** Device-flow attempts (copilot); polled in the background like the loopback flows. */
    private readonly deviceFlows: DeviceFlowManager,
    /** Announces an auth-state change so catalog readers re-query (fires `llm/adapters-updated`). */
    private readonly onAuthChanged: (provider: ProviderId, account?: string) => void,
    /** Lazy attachment-store lookup for the `image` endpoint. */
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    /** Usage lookups for providers that expose a usage endpoint. */
    private readonly usageFetchers: UsageFetchers = {},
    /**
     * Reads the Claude Code session from its own store. Constructor-injected so
     * tests can drive both login paths without a real credential store; the
     * plugin itself always uses the default.
     */
    private readonly readClaudeCreds: () => ClaudeSession | undefined = readClaudeCodeCredentials,
    /**
     * The pool's usage cache, when the pool is enabled. Routing `usage`
     * through it (instead of the raw fetcher) means the Settings page shares
     * the same negative cache as `quota_aware` selection — reopening the
     * page can no longer re-hit an endpoint that is still cooling down from
     * a 429.
     */
    private readonly poolUsage: PoolUsageTracker | undefined = undefined,
  ) {}

  usage(provider: ProviderId, account: string, signal: AbortSignal, force = false): Promise<ProviderUsage> {
    const fetcher = this.usageFetchers[provider]
    if (fetcher === undefined) return Promise.resolve({ supported: false })
    if (this.poolUsage === undefined) return fetcher(account, signal)
    return this.poolUsage.snapshotFor(provider, account, force)
  }

  async readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult> {
    const attachments = this.resolveAttachments()
    if (attachments === undefined) {
      throw new Error('no attachment service is mounted; generated-image bytes are unavailable')
    }
    const stored = await attachments.readImage(ref, signal)
    return { mediaType: stored.ref.mediaType, dataBase64: Buffer.from(stored.data).toString('base64') }
  }

  async readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult> {
    // The RPC layer validated `name` down to a bare file name, so this join
    // cannot escape the videos directory.
    const data = await readFile(join(videosDirectory(), name), { signal })
    return { mediaType: 'video/mp4', dataBase64: data.toString('base64') }
  }

  async status(provider: ProviderId): Promise<ProviderStatus> {
    const entries = await listAccounts(provider)
    // The plan name is shown by the usage section, so `detail` only carries errors.
    const detail = this.lastError.get(provider)
    return {
      busy: this.flows.isBusy(provider) || this.deviceFlows.isBusy(provider) || this.finalizing.has(provider),
      accounts: entries.map(({ key, session }, index) => {
        const account = accountOf(provider, session)
        const plan = planOf(provider, session)
        return {
          key,
          isDefault: index === 0,
          expiresAt: session.expiresAt,
          ...account === undefined ? {} : { account },
          ...plan === undefined ? {} : { plan },
        }
      }),
      ...detail === undefined ? {} : { detail },
    }
  }

  async login(provider: ProviderId, method?: LoginMethod): Promise<{ authorizeUrl: string; userCode?: string }> {
    if (provider === 'claude' && method !== 'oauth') {
      const imported = this.readClaudeCreds()
      if (imported !== undefined) {
        // An OAuth attempt may be in flight from an earlier click — the user
        // logged in through the CLI meanwhile. Claiming supersedes it whether
        // it is still waiting for its code or already exchanging one; the
        // cancel on top of that frees the listener, so `busy` clears and the
        // still-open browser tab cannot finish the flow.
        this.claim('claude')
        this.flows.pending('claude')?.cancel()
        // Keychain imports are bound: only they sync refreshes back to
        // Claude Code's credential store.
        const session: ClaudeSession = { ...imported, keychainBound: true }
        await this.persist('claude', session)
        this.lastError.delete('claude')
        this.onAuthChanged('claude', accountKeyOf('claude', session))
        return { authorizeUrl: '' }
      }
      if (method === 'keychain') {
        throw new Error('no Claude Code credentials found; run `claude` and log in first, or choose the browser flow')
      }
      // No Claude Code CLI / credential store — fall back to interactive OAuth.
      const attempt = await this.flows.start('claude', claudeFlow)
      this.completions.set('claude', this.complete('claude', attempt, this.claim('claude')))
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'claude') {
      // Explicit browser flow: skip the credential import entirely.
      const attempt = await this.flows.start('claude', claudeFlow)
      this.completions.set('claude', this.complete('claude', attempt, this.claim('claude')))
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'copilot') {
      // Device flow: no redirect URI — the UI shows the user code while the
      // background task polls GitHub for the token.
      const attempt = await this.deviceFlows.start(provider, copilotDeviceFlow())
      this.finalizing.add(provider)
      void this.completeDevice(provider, attempt)
      return { authorizeUrl: attempt.verificationUrl, userCode: attempt.userCode }
    }
    const spec = provider === 'grok' ? await grokFlow() : codexFlow
    const attempt = await this.flows.start(provider, spec)
    // Claimed only once the attempt exists: a rejected `start()` (one attempt
    // per provider) must not supersede the attempt already running.
    this.completions.set(provider, this.complete(provider, attempt, this.claim(provider)))
    return { authorizeUrl: attempt.authorizeUrl }
  }

  /**
   * Take ownership of a provider's session, superseding every older claim.
   * @param provider - the provider route.
   * @returns the claim number a later write checks itself against.
   */
  private claim(provider: ProviderId): number {
    const next = (this.claims.get(provider) ?? 0) + 1
    this.claims.set(provider, next)
    return next
  }

  /**
   * Drive one attempt to a stored session; records failures for the status
   * endpoint. The exchange runs unsupervised — the attempt is gone from the
   * flow manager as soon as its code arrives — so the result is stored only
   * while `claim` still owns the provider's session.
   */
  private async complete(provider: ProviderId, attempt: OAuthAttempt, claim: number): Promise<void> {
    try {
      const code = await attempt.waitCode()
      const session = await this.exchange(provider, code, attempt)
      // Whoever claimed the session while the exchange ran owns it now, and
      // this result is stale. The check and the store call sit in one
      // synchronous stretch, and the store queues a write the moment it is
      // called, so a claim arriving after the check is ordered after this
      // write too.
      if (this.claims.get(provider) !== claim) return
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session))
    } catch (error) {
      // A failure is as stale as a success would have been: whoever claimed
      // the session while the exchange ran owns what the card shows, so a
      // superseded attempt must not put an error on a provider that has since
      // been imported, logged in again, or logged out.
      if (this.claims.get(provider) !== claim) return
      // A user-cancelled attempt is not a failure worth surfacing. Every
      // in-tree canceller claims first, so the guard above already covers
      // this; the check stands on its own so the invariant does not depend on
      // callers ordering the two.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    }
  }

  /** Drive one device-flow attempt to a stored session (the copilot path of {@link complete}). */
  private async completeDevice(provider: ProviderId, attempt: DeviceAttempt): Promise<void> {
    try {
      const githubToken = await attempt.waitToken()
      const session = await completeCopilotLogin(githubToken)
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session))
    } catch (error) {
      // A user-cancelled attempt is not a failure worth surfacing.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    } finally {
      this.finalizing.delete(provider)
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
      case 'copilot':
        // Device flow: exchange happens in completeDevice, never here.
        return Promise.reject(new Error('copilot uses the device flow; no authorization code to exchange'))
    }
  }

  private persist(provider: ProviderId, session: StoredSession): Promise<void> {
    // Keyed by the account's stable identity: re-logging the same account
    // updates in place, a different account appends.
    return saveAccountSession(provider, accountKeyOf(provider, session), session as never)
  }

  /**
   * Settle once no OAuth completion is running for a provider.
   *
   * @internal Exported for tests only: a login's token exchange outlives the
   * `login()` call that started it, and a test asserting on what it stored
   * would otherwise have to guess at a timeout.
   */
  async settled(provider: ProviderId): Promise<void> {
    await this.completions.get(provider)
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
    // Claiming covers the attempt whose code already arrived: it is no longer
    // pending, but its token exchange may still be on its way to a store write.
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    return Promise.resolve()
  }

  async logout(provider: ProviderId, account: string): Promise<void> {
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    await deleteAccountSession(provider, account)
    this.lastError.delete(provider)
    this.onAuthChanged(provider, account)
  }

  async setDefault(provider: ProviderId, account: string): Promise<void> {
    await setDefaultAccount(provider, account)
    this.onAuthChanged(provider, account)
  }
}

export function apply(ctx: Context, config: Config): void {
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const rateLimit = resolveRateLimitWait(config.rateLimit, `${name}: rateLimit`)
  const catalog = resolveCatalog(config.models)
  // A non-empty configured catalog is an explicit override: it wins over live
  // discovery entirely (schemastery injects [] for omitted arrays, so only a
  // non-empty list counts as configured).
  const overridden = new Set<ProviderId>(
    PROVIDER_IDS.filter(provider => (config.models?.[provider]?.length ?? 0) > 0),
  )
  const flows = new OAuthFlowManager()
  const deviceFlows = new DeviceFlowManager()
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
  const handles = new Map<string, AdapterRegistrationHandle>()
  // The constructed adapters, for the pool route to fail over between.
  const adapters = new Map<ProviderId, AccountAwareAdapter>()
  // Provider-owned approval reviewers. Adding another implementation means
  // registering it here; the approval hook and router remain unchanged.
  const approvalReviewers: ApprovalReviewer[] = []
  // Per-provider account token managers; also the pool's account lists.
  const accountTokens = new Map<ProviderId, AccountTokenManager<StoredSession>>()
  // Pool state, assigned when the pool route registers below; read here so an
  // auth change immediately recovers the account's cooling members and
  // refreshes its quota snapshot.
  let poolHealth: PoolHealthRegistry | undefined
  let poolUsage: PoolUsageTracker | undefined
  let poolAdapter: PoolAdapter | undefined
  const authChanged = (provider: ProviderId, account?: string): void => {
    // Login, logout, and credential death all pass through here; a copilot
    // auth transition also drops the adapter's captured reasoning replay
    // state (isolation is already account-scoped — this is memory hygiene).
    if (provider === 'copilot') copilotAdapter?.clearReplayState()
    adapters.get(provider)?.clearAccountCatalog(account)
    poolHealth?.clear(provider, account)
    poolUsage?.invalidate(provider, account)
    poolAdapter?.invalidate()
    // Pool membership follows the accounts: re-announce every route so the
    // picker re-queries (the changed provider's own catalog may shift too).
    for (const [route, handle] of handles) handle.replace([route])
  }
  // Per-model default effort overrides: start the load so the adapters'
  // synchronous `defaultEffortOf` callbacks see the persisted state as soon
  // as the model picker resolves; a load failure leaves the overrides empty.
  void loadModelDefaults()
  // Token managers double as the tools' credential source, so they are
  // captured beside the registrations for the inject block below.
  let codexTokens: AccountTokenManager<CodexSession> | undefined
  let claudeTokens: AccountTokenManager<ClaudeSession> | undefined
  let grokTokens: AccountTokenManager<GrokSession> | undefined
  // Usage lookups resolve the session through the refresh-aware path, so an
  // expired access token renews instead of failing the lookup.
  const usageFetchers: UsageFetchers = {}
  // The composer Speed toggle's state: per-session, in-memory (a restart
  // restores standard routing), gated per request on the model's discovered
  // fast-tier support so a stale choice cannot leak onto a plain model.
  const speedBySession = new Map<string, SpeedTier>()
  const autoReviewBySession = new Map<string, AutoReviewMode>()
  interface SessionLineageRegistry {
    get(id: string): { readonly session: { readonly header?: { readonly parentSession?: string } } } | undefined
  }
  const parentSessionOf = (sessionId: string): string | undefined => {
    const agents = ctx.get('agents') as SessionLineageRegistry | undefined
    const parent = agents?.get(sessionId)?.session.header?.parentSession
    return parent === undefined ? undefined : String(parent)
  }
  const sessionSetting = <T>(values: ReadonlyMap<string, T>, sessionId: string): T | undefined =>
    inheritedSessionSetting(values, sessionId, parentSessionOf)
  let codexAdapter: CodexAdapter | undefined
  // Dropped on every copilot auth transition so replay state (captured
  // reasoning) never survives an account switch in memory.
  let copilotAdapter: CopilotAdapter | undefined
  for (const provider of providers) {
    switch (provider) {
      case 'codex': {
        const tokens = new AccountTokenManager<CodexSession>({
          provider: 'codex',
          displayName: 'ChatGPT (Codex)',
          makeOptions: () => ({
            preemptMs: CODEX_PREEMPT_MS,
            refresh: refreshCodex,
            isPermanent: isCodexPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('codex', account) },
        })
        codexTokens = tokens
        accountTokens.set('codex', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.codex = async (account, signal) =>
          fetchCodexUsage(await tokens.session(account), proxiedFetch, signal)
        let adapter!: CodexAdapter
        adapter = new CodexAdapter({
          models: catalog.codex,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('codex'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('codex'),
          defaultEffortOf: (model: string) => defaultEffortOf('codex', model),
          pool: () => poolAdapter,
          speedFor: (sessionId: string | undefined, model: string): boolean | Promise<boolean> =>
            sessionId !== undefined
            && sessionSetting(speedBySession, sessionId) === 'fast'
            && adapter.supportsFastTier(model),
        })
        codexAdapter = adapter
        approvalReviewers.push(adapter)
        adapters.set('codex', adapter)
        handles.set('codex', ctx.llm.registerAdapter(['codex'], adapter))
        break
      }
      case 'claude': {
        const tokens = new AccountTokenManager<ClaudeSession>({
          provider: 'claude',
          displayName: 'Claude (Subscription)',
          makeOptions: () => ({
            preemptMs: CLAUDE_PREEMPT_MS,
            // Only keychain-imported accounts sync with Claude Code's own
            // credential store; OAuth accounts refresh standalone so several
            // accounts never fight over the Keychain entry.
            refresh: session =>
              session.keychainBound === true ? refreshClaudeSynced(session, refreshClaude) : refreshClaude(session),
            isPermanent: isClaudePermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('claude', account) },
        })
        claudeTokens = tokens
        accountTokens.set('claude', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.claude = async (account, signal) =>
          fetchClaudeUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new ClaudeAdapter({
          models: catalog.claude,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('claude'),
          onWarn,
          resolveAttachments,
          catalogStore: catalogStore('claude'),
          defaultEffortOf: (model: string) => defaultEffortOf('claude', model),
          pool: () => poolAdapter,
        })
        adapters.set('claude', adapter)
        handles.set('claude', ctx.llm.registerAdapter(['claude'], adapter))
        break
      }
      case 'grok': {
        const tokens = new AccountTokenManager<GrokSession>({
          provider: 'grok',
          displayName: 'Grok (Subscription)',
          makeOptions: () => ({
            preemptMs: GROK_PREEMPT_MS,
            refresh: refreshGrok,
            isPermanent: isGrokPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('grok', account) },
        })
        grokTokens = tokens
        accountTokens.set('grok', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.grok = async (account, signal) =>
          fetchGrokUsage(await tokens.session(account), proxiedFetch, signal)
        const adapter = new GrokAdapter({
          models: catalog.grok,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('grok'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('grok'),
          defaultEffortOf: (model: string) => defaultEffortOf('grok', model),
          pool: () => poolAdapter,
        })
        adapters.set('grok', adapter)
        handles.set('grok', ctx.llm.registerAdapter(['grok'], adapter))
        break
      }
      case 'copilot': {
        const tokens = new AccountTokenManager<CopilotSession>({
          provider: 'copilot',
          displayName: 'GitHub Copilot',
          makeOptions: () => ({
            preemptMs: COPILOT_PREEMPT_MS,
            refresh: refreshCopilot,
            isPermanent: isCopilotPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('copilot', account) },
        })
        accountTokens.set('copilot', tokens as AccountTokenManager<StoredSession>)
        copilotAdapter = new CopilotAdapter({
          models: catalog.copilot,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('copilot'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (per-model vision support,
          // context windows) survives restarts and network failures.
          catalogStore: catalogStore('copilot'),
          defaultEffortOf: (model: string) => defaultEffortOf('copilot', model),
          pool: () => poolAdapter,
        })
        adapters.set('copilot', copilotAdapter)
        handles.set('copilot', ctx.llm.registerAdapter(['copilot'], copilotAdapter))
        break
      }
    }
  }

  // Same-subscription account pools: a catalog model with ≥2 accounts of
  // that provider is served through the pool (same id, same picker group).
  // Configured tiers are extra picker rows. Built whenever enabled; a
  // provider with fewer than two accounts simply has nothing to pool.
  const poolConfig = config.pool
  const autoAccounts = poolConfig?.autoAccounts ?? poolConfig?.autoFamilies ?? true
  if (poolConfig?.enabled !== false && adapters.size >= 1) {
    // Every poll gets a hard timeout: a cold usage cache AWAITS the first
    // fetch during member selection, and a hanging usage endpoint must
    // degrade the strategy (zero urgency), not stall the user's request.
    // Copilot has no usage endpoint, so its accounts resolve no fetcher and
    // score zero urgency — the natural last resort.
    const fetcherFor = (provider: ProviderId, account: string): (() => Promise<ProviderUsage>) | undefined => {
      switch (provider) {
        case 'codex': {
          const tokens = codexTokens
          return tokens === undefined ? undefined : async () =>
            fetchCodexUsage(await tokens.session(account), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
        }
        case 'claude': {
          const tokens = claudeTokens
          return tokens === undefined ? undefined : async () =>
            fetchClaudeUsage(await tokens.session(account), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
        }
        case 'grok': {
          const tokens = grokTokens
          return tokens === undefined ? undefined : async () =>
            fetchGrokUsage(await tokens.session(account), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
        }
        case 'copilot':
          return undefined
      }
    }
    poolHealth = new PoolHealthRegistry()
    poolUsage = new PoolUsageTracker(fetcherFor)
    const families = async (): Promise<Map<string, PoolDefinition>> => {
      const pools = new Map<string, PoolDefinition>()
      if (autoAccounts) {
        // Discover each account's catalog separately: a model only pools the
        // accounts that actually list it (Plus is not asked to serve Pro-only
        // models). A hang or discovery failure sits that account out.
        const sources: Parameters<typeof buildAccountPools>[0] = {}
        await Promise.all([...adapters].map(async ([provider, adapter]) => {
          try {
            const accounts = (await accountTokens.get(provider)?.list() ?? []).map(entry => entry.key)
            if (accounts.length < 2) return
            const catalogs = (await Promise.all(accounts.map(async account => {
              const models = await withTimeout(
                signal => adapter.listOwnModels(provider, account, signal),
                POOL_USAGE_TIMEOUT_MS,
              )
              return models === undefined ? undefined : { account, models }
            }))).filter(entry => entry !== undefined)
            if (catalogs.length >= 2) sources[provider] = { catalogs }
          } catch {
            // Discovery failures are already reported by the owning adapter.
          }
        }))
        for (const [key, definition] of buildAccountPools(sources)) pools.set(key, definition)
      }
      for (const [id, members] of Object.entries(poolConfig?.families ?? {})) {
        if (members.length === 0) continue
        const owner = members[0].provider
        const kept = members.filter(member => member.provider === owner)
        if (kept.length < members.length) {
          onWarn(`pool "${id}": cross-provider members are ignored; only ${owner} accounts are pooled`)
        }
        pools.set(poolKey(owner, id), { members: kept })
      }
      return pools
    }
    poolAdapter = new PoolAdapter({
      adapters: Object.fromEntries(adapters),
      health: poolHealth,
      usage: poolUsage,
      strategy: poolConfig?.strategy ?? 'quota_aware',
      switchMargin: poolConfig?.switchMargin ?? 2,
      defaultAccount: provider => accountTokens.get(provider)?.defaultAccount() ?? Promise.resolve(undefined),
      families,
      tiers: poolConfig?.tiers ?? {},
      onWarn,
    })
  }

  const speed: SpeedController = {
    async speed(sessionId) {
      return {
        tier: sessionSetting(speedBySession, sessionId) ?? 'standard',
        fastModels: await codexAdapter?.fastCapableModels() ?? [],
      }
    },
    async setSpeed(sessionId, tier) {
      speedBySession.delete(sessionId)
      if (tier !== (sessionSetting(speedBySession, sessionId) ?? 'standard')) speedBySession.set(sessionId, tier)
    },
  }
  const autoReviewOptions = approvalReviewers.map(reviewer => ({
    reviewer: reviewer.reviewerId,
    label: reviewer.reviewerLabel,
  }))
  const availableAutoReviewers = new Set(autoReviewOptions.map(option => option.reviewer))
  const configuredAutoReview = config.autoReview ?? 'none'
  const defaultAutoReview = configuredAutoReview === 'none' || availableAutoReviewers.has(configuredAutoReview)
    ? configuredAutoReview
    : 'none'
  if (configuredAutoReview !== defaultAutoReview) {
    onWarn(`automatic reviewer "${configuredAutoReview}" is unavailable; using manual approvals`)
  }
  const autoReviewDefault = new AutoReviewDefaultStore(
    defaultAutoReview,
    reviewer => reviewer === 'none' || availableAutoReviewers.has(reviewer),
    onWarn,
  )
  const autoReview: AutoReviewController = {
    async autoReview(sessionId) {
      return {
        reviewer: sessionSetting(autoReviewBySession, sessionId) ?? await autoReviewDefault.get(),
        reviewers: autoReviewOptions,
      }
    },
    async setAutoReview(sessionId, reviewer) {
      if (reviewer !== 'none' && !availableAutoReviewers.has(reviewer)) return false
      autoReviewBySession.delete(sessionId)
      if (reviewer !== (sessionSetting(autoReviewBySession, sessionId) ?? await autoReviewDefault.get())) {
        autoReviewBySession.set(sessionId, reviewer)
      }
      return true
    },
    async autoReviewDefault() {
      return { reviewer: await autoReviewDefault.get(), reviewers: autoReviewOptions }
    },
    async setAutoReviewDefault(reviewer) {
      if (reviewer !== 'none' && !availableAutoReviewers.has(reviewer)) return undefined
      await autoReviewDefault.set(reviewer)
      return { reviewer, reviewers: autoReviewOptions }
    },
  }
  // Per-model default effort overrides (the Settings page's model pickers).
  // The catalog re-reads the live model info per model — same source as the
  // session model picker, so the offered effort levels match the picker
  // exactly, and the configured default merges in through the adapters.
  const modelDefaults: ModelDefaultsController = {
    async catalog(): Promise<ModelDefaultsCatalog[]> {
      const visible = new Set((await ctx.llm.listProviders()).map(provider => provider.id))
      const catalog: ModelDefaultsCatalog[] = []
      for (const provider of PROVIDER_IDS) {
        if (!visible.has(provider)) continue
        let models: readonly { id: string; name: string }[] = []
        try {
          models = await ctx.llm.listModels(provider)
        } catch {
          continue // provider unregistered or catalog unavailable; leave it out
        }
        // Configured tier rows resolve through the pool, which intersects its
        // members' own capabilities and never consults defaultEffortOf for the
        // tier id — an override on one would save cleanly and do nothing. Leave
        // them out rather than offer a control that cannot take effect.
        let tierIds: ReadonlySet<string> = new Set()
        try {
          const tiers = await poolAdapter?.modelsForProvider(provider)
          if (tiers !== undefined) tierIds = new Set(tiers.map(tier => tier.id))
        } catch {
          // A pool that cannot enumerate leaves every row listed; the worst
          // case is the pre-existing behaviour, not a missing card.
        }
        const views: ModelDefaultView[] = []
        for (const model of models) {
          if (tierIds.has(model.id)) continue
          let info: LlmResolvedModelInfo | undefined
          try {
            info = await ctx.llm.resolveModelInfo(provider, model.id)
          } catch {
            continue // one broken entry must not hide the rest
          }
          if (info === undefined) continue
          // `defaultEffortOf` rather than a bare index: model ids are catalog
          // data, and an id like `toString` would otherwise inherit a function.
          const override = defaultEffortOf(provider, model.id)
          views.push({
            id: model.id,
            name: model.name,
            efforts: info.reasoning?.efforts.map(effort => ({ id: effort.id, name: effort.name })) ?? [],
            ...override === undefined ? {} : { configured: override },
          })
        }
        catalog.push({ provider, models: views })
      }
      return catalog
    },
    async set(provider, model, effort) {
      // Garbage in, garbage out: accept only levels the model's own catalog
      // actually advertises (clearing with `undefined` always passes). A value
      // from elsewhere — a hand-edited store file — would otherwise ride on
      // every request and 400. An unknown effort fails the save instead of
      // silently saving something unusable.
      if (effort !== undefined) {
        let info: LlmResolvedModelInfo | undefined
        try {
          info = await ctx.llm.resolveModelInfo(provider, model)
        } catch {
          // Fall through when the catalog is unavailable: rejecting the save
          // here would make every write fail during an outage.
        }
        const offered = info?.reasoning?.efforts ?? []
        if (offered.length > 0 && !offered.some(entry => entry.id === effort)) {
          throw new BadRequest(`model ${model} does not advertise a "${effort}" reasoning effort`)
        }
      }
      await setDefaultEffort(provider, model, effort)
      // Re-announce the route so the model picker re-queries `listModels` and
      // reflects the new default immediately (same path as auth changes).
      handles.get(provider)?.replace([provider])
    },
  }
  registerAuthRpc(ctx, new SubscriptionsAuthController(
    flows, deviceFlows, authChanged, resolveAttachments, usageFetchers, undefined, poolUsage,
  ), speed, {
    get: () => proxyGetConfig(),
    set: input => proxySetConfig(input),
    test: payload => proxyTestConnection(payload.url, payload.proxy),
  }, modelDefaults, autoReview)

  // Proactively keep keychain-bound Claude accounts synced with Claude Code's
  // own store (Keychain/file) every 5 minutes, so a session left idle between
  // requests does not go stale from a token rotation that happened outside
  // this plugin (the `claude` CLI refreshing on its own, or another
  // consumer). OAuth-only accounts refresh on demand and are not touched.
  if (claudeTokens !== undefined) {
    const tokens = claudeTokens
    const syncTimer = setInterval(() => {
      void tokens.list().then((accounts) => {
        for (const { key, session } of accounts) {
          if (session.keychainBound !== true) continue
          tokens.session(key).catch(() => {
            // Best-effort: TokenManager already surfaces failures via onRemoved.
          })
        }
      }, () => undefined)
    }, 5 * 60_000)
    ctx.effect(() => () => { clearInterval(syncTimer) }, 'dsh-plugin-subscriptions: claude background sync timer')
  }

  // `tools` is optional (headless/minimal compositions may not mount it), so
  // registration waits for the service instead of injecting it at load.
  // The auto-review hooks stay installed even when the configured default is
  // None: capture is model-free, and the router runs only if the native
  // approval service actually asks for a decision.
  // x_search and video_generate follow the grok provider; image_generate
  // prefers the codex provider and falls back to grok.
  ctx.inject(['tools'], (toolsCtx) => {
    const reviewRouter = new ApprovalReviewRouter(approvalReviewers, async (agent) => {
      const selected = sessionSetting(autoReviewBySession, agent.id) ?? await autoReviewDefault.get()
      return selected === 'none' ? undefined : selected
    })
    installAutoReview(toolsCtx, reviewRouter)
    if (grokTokens !== undefined) {
      toolsCtx.tools.register(createXSearchTool({ tokens: grokTokens }))
      toolsCtx.tools.register(createVideoGenerateTool({ tokens: grokTokens }))
    }
    if (codexTokens !== undefined || grokTokens !== undefined) {
      toolsCtx.tools.register(createImageGenerateTool({
        ...codexTokens === undefined ? {} : { codexTokens },
        ...grokTokens === undefined ? {} : { grokTokens },
        resolveAttachments,
        resolveLlm: () => ctx.get('llm'),
      }))
    }
  })
}
