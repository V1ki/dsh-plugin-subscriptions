/**
 * dsh-plugin-subscriptions: register OAuth-subscription LLM providers
 * (ChatGPT/Codex, Claude, Grok, GitHub Copilot, Google Antigravity) on `ctx.llm`, and expose the `/subscriptions-auth`
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
  GenerateOptions,
  LlmAdapter,
  LlmModelInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
// Type-only: activates the `ctx.tools` Context merge for the inject block.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: activates the `ctx.web` Context merge for optional registration.
import type {} from '@deepseek-ai/dsh-web'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { DeviceFlowManager, type DeviceAttempt } from './auth/device-flow.js'
import {
  completeKimiLogin,
  fetchKimiModels,
  isKimiPermanentRefreshError,
  KIMI_API_BASE,
  KIMI_PREEMPT_MS,
  kimiDeviceFlow,
  kimiHeaders,
  refreshKimi,
} from './auth/kimi.js'
import {
  isQwenPermanentRefreshError,
  QWEN_STANDARD_BASE,
  QWEN_USER_AGENT,
  qwenSessionFromKey,
  refreshQwen,
} from './auth/qwen.js'
import { isGlmPermanentRefreshError, refreshGlm, startGlmLogin } from './auth/zcode.js'
import { fetchGlmUsage } from './providers/glm-usage.js'
import { fetchGlmModels } from './providers/glm-models.js'
import { fetchKimiUsage } from './providers/kimi-usage.js'
import { exchangeQwenCliToken, listQwenConsoleModels, startQwenConsoleLogin } from './auth/qwen-console.js'
import type { QwenConsoleAttempt } from './auth/qwen-console.js'
import { fetchQwenUsage } from './providers/qwen-usage.js'
import type { GlmLoginAttempt } from './auth/zcode.js'
import { ChatSubscriptionAdapter } from './providers/chat-subscription.js'
import type { ChatSubscriptionDiscovered, ChatSubscriptionReasoning, ChatSubscriptionSession } from './providers/chat-subscription.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readClaudeCodeCredentials, refreshClaudeSynced } from './auth/claude-code-creds.js'
import { ResetRedemption } from './providers/reset-redemption.js'
import { BadRequest, registerAuthRpc } from './auth/rpc.js'
import type {
  AuthController,
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
  getAccountSession,
  listAccounts,
  saveAccountSession,
  setDefaultAccount,
  updateAccountSession,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  ClaudeSession,
  CodexSession,
  CopilotSession,
  AntigravitySession,
  GlmSession,
  GrokSession,
  KimiSession,
  ProviderId,
  QwenSession,
  StoredSession,
} from './auth/store.js'
import { DISCOVERY_TIMEOUT_MS, validateModels, withTimeout } from './providers/common.js'
import { startCatalogRefresh } from './providers/catalog-refresh.js'
import type { ModelEntry, ProviderUsage } from './providers/common.js'
import { AccountTokenManager } from './providers/accounts.js'
import type { AccountAwareAdapter } from './providers/accounts.js'
import { DEFAULT_RATE_LIMIT_MAX_WAIT_MS, resolveRateLimitWait } from './providers/rate-limit.js'
import type { RateLimitConfig } from './providers/rate-limit.js'
import { DEFAULT_PROMPT_CACHE_TTL } from './translate/anthropic.js'
import type { PromptCacheTtl } from './translate/anthropic.js'
import type { HostPathMapper } from './translate/resolved.js'
import { accountCatalogStore, catalogStore } from './providers/catalog-store.js'
import { ClaudeCliVersionCache } from './providers/claude-cli-version.js'
import type { CliVersion, NpmCliVersionCache } from './providers/npm-cli-version.js'
import { CodexClientVersionCache } from './providers/codex-client-version.js'
import { CodexWebSearchProvider } from './providers/codex-search.js'
import { PoolAdapter } from './providers/pool.js'
import { AccountPreferencesAdapter, accountAllowsPool, accountModelId, parseAccountModelId } from './providers/account-preferences.js'
export type { AccountPreferences, ProviderPreferences } from './provider-settings.js'
import { ImageAccountPool } from './providers/image-pool.js'
import { registerWithAlias } from './tools/registration.js'
import { buildAccountPools, poolKey } from './providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef } from './providers/pool-family.js'
import { PoolHealthRegistry } from './providers/pool-health.js'
import { PoolUsageTracker } from './providers/pool-usage.js'
import { observeUsageFetchers, type SnapshotObserver, type UsageFetchers } from './usage/snapshot-hook.js'
import { WindowStore } from './usage/window-store.js'
import type { HostSessionQuery } from './usage/host-events.js'
import { PreTracking } from './usage/pre-tracking.js'
import { UsageService } from './usage/service.js'
import { createUsageHistoryController } from './usage/usage-rpc.js'
import type { RequestEnd } from './providers/replay.js'
import {
  CodexAdapter,
  codexFlow,
  CODEX_PREEMPT_MS,
  codexProfileClaims,
  exchangeCodexCode,
  fetchCodexUsage,
  fetchCodexResetCredits,
  consumeCodexResetCredit,
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
import {
  AntigravityAdapter,
  antigravityFlow,
  ANTIGRAVITY_PREEMPT_MS,
  exchangeAntigravityCode,
  fetchAntigravityUsage,
  isAntigravityPermanentRefreshError,
  refreshAntigravity,
  resolveAntigravityOAuthConfig,
} from './providers/antigravity.js'
import type { AntigravityRuntimeConfig } from './providers/antigravity.js'
import { createXSearchTool } from './tools/x-search.js'
import { createImageGenerateTool } from './tools/image-generate.js'
import { createVideoGenerateTool, videosDirectory } from './tools/video-generate.js'
import { ensureConnectAttemptTimeout, proxiedFetch, proxyGetConfig, proxySetConfig, proxyTestConnection, restoreConnectAttemptTimeout } from './http.js'
import { ProviderSettingsStore, PROVIDER_TOOLS, validatePreferences } from './provider-settings.js'
import { ModelSpeeds } from './model-speeds.js'

export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js'
export type { RateLimitConfig, RateLimitWait } from './providers/rate-limit.js'
export type { ProviderStatus } from './auth/rpc.js'
export type { AntigravitySession, ClaudeSession, CodexSession, CopilotSession, GrokSession, ProviderId } from './auth/store.js'

export const name = 'dsh-plugin-subscriptions'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Bound on one pool quota poll — member selection must not hang on a usage endpoint. */
export const POOL_USAGE_TIMEOUT_MS = DISCOVERY_TIMEOUT_MS
export { withTimeout } from './providers/common.js'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Codex /models client_version override; does not change account entitlements. */
  codexClientVersion?: string
  /** Provider routes to register; defaults to every supported provider. */
  providers?: ProviderId[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /**
   * How long Anthropic keeps the Claude conversation cache after its last use:
   * `'5m'` (default, the API's own default) or `'1h'`. One hour writes cache
   * entries at 2× the input price instead of 1.25×, and pays off when you
   * regularly pause longer than five minutes between messages. Claude only;
   * compaction and session-title requests always stay on five minutes.
   */
  claudePromptCacheTtl?: PromptCacheTtl
  /**
   * Claude only: tool-name patterns sent with `defer_loading: true`, with the
   * server-side tool search tool added, so the model loads those definitions
   * on demand instead of carrying them in every request. A pattern is a
   * literal name or a prefix ending in `*` (`mcp__*`). Default empty: the
   * request body is unchanged.
   */
  claudeDeferTools?: string[]
  /** Whether and how long a route waits out a closed rate-limit window. */
  rateLimit?: RateLimitConfig
  /** Advisory model catalogs overriding the built-in defaults, per provider. */
  models?: {
    codex?: ModelEntry[]
    claude?: ModelEntry[]
    grok?: ModelEntry[]
    copilot?: ModelEntry[]
    antigravity?: ModelEntry[]
    kimi?: ModelEntry[]
    glm?: ModelEntry[]
    qwen?: ModelEntry[]
  }
  /**
   * GLM Coding Plan station. `bigmodel` (mainland, bigmodel.cn) is the
   * default; `zai` targets the international z.ai account system. Login and
   * inference both follow this choice.
   */
  glm?: { station?: 'bigmodel' | 'zai' }
  /** Antigravity-specific OAuth and endpoint configuration. */
  antigravity?: AntigravityRuntimeConfig & {
    /** Google OAuth client id. May instead be supplied as ANTIGRAVITY_CLIENT_ID. */
    clientId?: string
    /** Google OAuth client secret, when required by the client registration. */
    clientSecret?: string
  }
  /** Same-subscription account pools (and optional extra tier models). */
  pool?: {
    /** Enable account pooling (default true; needs ≥2 accounts of one provider). */
    enabled?: boolean
    /** Member selection: plain priority failover, or quota-aware urgency scheduling. */
    strategy?: 'priority' | 'quota_aware' | 'quota_normalized'
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

const providerIdSchema = z.union(['codex', 'claude', 'grok', 'copilot', 'antigravity', 'kimi', 'glm', 'qwen'])
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
  providers: z.array(providerIdSchema).default([
    'codex', 'claude', 'grok', 'copilot', 'antigravity', 'kimi', 'glm', 'qwen',
  ]),
  codexClientVersion: z.string(),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  claudePromptCacheTtl: z.union(['5m', '1h']).default(DEFAULT_PROMPT_CACHE_TTL),
  claudeDeferTools: z.array(z.string()).default([]),
  rateLimit: z.object({
    wait: z.boolean().default(true),
    maxWaitMs: z.number().min(1).default(DEFAULT_RATE_LIMIT_MAX_WAIT_MS),
  }),
  models: z.object({
    codex: z.array(modelEntrySchema),
    claude: z.array(modelEntrySchema),
    grok: z.array(modelEntrySchema),
    copilot: z.array(modelEntrySchema),
    antigravity: z.array(modelEntrySchema),
    kimi: z.array(modelEntrySchema),
    glm: z.array(modelEntrySchema),
    qwen: z.array(modelEntrySchema),
  }),
  glm: z.object({
    station: z.union(['bigmodel', 'zai']).default('bigmodel'),
  }),
  antigravity: z.object({
    clientId: z.string(),
    clientSecret: z.string().role('secret'),
    baseURL: z.string(),
    userAgent: z.string(),
    onboard: z.boolean().default(true),
  }),
  pool: z.object({
    enabled: z.boolean().default(true),
    strategy: z.union(['priority', 'quota_aware', 'quota_normalized']).default('quota_aware'),
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
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', maxTokens: 128_000, contextWindow: 1_000_000 },
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
  // Static fallback only; the authenticated fetchAvailableModels response wins.
  antigravity: [
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash', inputModalities: ['text', 'image'] },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', inputModalities: ['text', 'image'] },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking', inputModalities: ['text', 'image'] },
  ],
  // Static fallback only; the authenticated /coding/v1/models response wins.
  kimi: [
    { id: 'kimi-for-coding', name: 'Kimi for Coding (K2.8)', contextWindow: 1_048_576 },
    { id: 'kimi-for-coding-highspeed', name: 'Kimi for Coding Highspeed', contextWindow: 262_144 },
    { id: 'k3', name: 'K3', contextWindow: 1_048_576 },
    { id: 'k3-256k', name: 'K3 256K', contextWindow: 262_144 },
    { id: 'k3.1-pro', name: 'K3.1 Pro', contextWindow: 1_048_576 },
    { id: 'k3.1-pro-highspeed', name: 'K3.1 Pro Highspeed', contextWindow: 1_048_576 },
  ],
  // Static fallback; `GET /api/paas/v4/models` replaces it after login.
  glm: [
    { id: 'glm-5.4', name: 'GLM-5.4', contextWindow: 1_000_000, maxTokens: 128_000,
      inputModalities: ['text', 'image'] },
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_000_000, maxTokens: 128_000,
      inputModalities: ['text', 'image'] },
  ],
  // 千问AI平台 has no GET /models; this is the documented fallback catalog.
  // The console catalog (ListModelSeries) replaces it after the quota login,
  // which is how preview models such as qwen4-max-preview appear.
  qwen: [
    { id: 'qwen4-max-preview', name: 'Qwen4 Max Preview', contextWindow: 1_000_000, maxTokens: 131_072 },
    { id: 'qwen4-max', name: 'Qwen4 Max', contextWindow: 1_000_000, maxTokens: 131_072 },
    { id: 'qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: 1_000_000, maxTokens: 131_072 },
    { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', contextWindow: 1_000_000, maxTokens: 131_072 },
    { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', contextWindow: 1_000_000, maxTokens: 131_072 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxTokens: 393_216 },
  ],
}

/**
 * Kimi Code thinking depths: K3.1/K3/K2.8 Preview take low|high|max (default
 * high, K2.8 Preview max); K2.7 Code Highspeed is fixed-on and has no levels.
 */
const KIMI_REASONING = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
] as const

/** @internal Exported for tests only. */
export function kimiReasoning(model: string): ChatSubscriptionReasoning | undefined {
  switch (model) {
    case 'k3.1-pro':
    case 'k3.1-pro-highspeed':
    case 'k3':
    case 'k3-256k':
      return { efforts: KIMI_REASONING, defaultEffort: 'high', body: effort => ({ reasoning_effort: effort }) }
    case 'kimi-for-coding':
      return { efforts: KIMI_REASONING, defaultEffort: 'max', body: effort => ({ reasoning_effort: effort }) }
    default:
      return undefined
  }
}

/** GLM-5.3 always thinks; the effort level selects low|high|max depth. */
const GLM_REASONING = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
] as const

/** @internal Exported for tests only. */
export function glmReasoning(model: string): ChatSubscriptionReasoning | undefined {
  if (!/^glm-5(?:[.-]|$)/i.test(model) || /-legal$/i.test(model)) return undefined
  return {
    efforts: GLM_REASONING,
    defaultEffort: 'max',
    body: effort => ({ thinking: { type: 'enabled' }, reasoning_effort: effort }),
  }
}

/**
 * 千问AI平台 exposes low|medium|xhigh directly on Qwen3.8 (default xhigh);
 * other catalog entries keep the provider default.
 */
const QWEN_REASONING = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'xhigh', name: 'Extra High' },
] as const

/** @internal Exported for tests only. */
export function qwenReasoning(model: string): ChatSubscriptionReasoning | undefined {
  if (!model.startsWith('qwen4') && !model.startsWith('qwen3.8') && model !== 'deepseek-v4-pro') return undefined
  return { efforts: QWEN_REASONING, defaultEffort: 'xhigh', body: effort => ({ reasoning_effort: effort }) }
}

/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {  const resolve = (provider: ProviderId): ModelEntry[] => {
    // Schemastery injects `[]` for omitted array fields, so an empty list
    // cannot be told apart from an absent one: both mean the built-ins.
    const configured = models?.[provider]
    const entries = configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODELS[provider]
    return validateModels(entries, `${name}: models.${provider}`)
  }
  return {
    codex: resolve('codex'),
    claude: resolve('claude'),
    grok: resolve('grok'),
    copilot: resolve('copilot'),
    antigravity: resolve('antigravity'),
    kimi: resolve('kimi'),
    glm: resolve('glm'),
    qwen: resolve('qwen'),
  }
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
    case 'antigravity': return (session as AntigravitySession).account
    case 'kimi': return (session as KimiSession).account
    case 'glm': return (session as GlmSession).account
    case 'qwen': return (session as QwenSession).account
  }
}

/** The plan name a stored session carries, when the provider told us. */
function planOf(provider: ProviderId, session: StoredSession): string | undefined {
  switch (provider) {
    case 'codex': return (session as CodexSession).planType
    case 'claude': return (session as ClaudeSession).subscriptionType
    case 'grok': return undefined
    case 'copilot': return undefined
    case 'antigravity': return undefined
    case 'kimi': return undefined
    case 'glm': return undefined
    case 'qwen': return (session as QwenSession).plan
  }
}

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
   * Logins per provider whose attempt has left its flow manager (the code
   * arrived, or the device poll settled) but whose token exchange + persist
   * is still running. In that window the flow manager says busy=false while
   * no session exists yet (loggedIn=false); the Settings page polls only
   * while busy, so without counting it the card would stop at "not logged
   * in" one tick before the session lands and never refresh on its own. A
   * count rather than a set: a superseded attempt finishing late must not
   * clear the window of the attempt that replaced it.
   */
  private finalizing = new Map<ProviderId, number>()

  private beginFinalizing(provider: ProviderId): void {
    this.finalizing.set(provider, (this.finalizing.get(provider) ?? 0) + 1)
  }

  private endFinalizing(provider: ProviderId): void {
    const left = (this.finalizing.get(provider) ?? 1) - 1
    if (left <= 0) this.finalizing.delete(provider)
    else this.finalizing.set(provider, left)
  }

  /** In-flight OAuth completions, one per provider at most. */
  private completions = new Map<ProviderId, Promise<void>>()

  /**
   * In-flight ZCode login (GLM). Its polling runs against the official
   * CLI flow instead of the loopback engine, so it is tracked separately;
   * `busy` must include it or the Settings card would stop polling while the
   * user completes the browser step.
   */
  private zcodeLogins = new Map<ProviderId, GlmLoginAttempt>()
  /** Reserving the ZCode flow before its first network call closes the double-click window. */
  private glmStarting = false
  /** In-flight Qwen console login (quota reads only; inference stays key-based). */
  private qwenConsoleLogins = new Map<ProviderId, QwenConsoleAttempt>()
  private qwenConsoleStarting = false

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
    /** Antigravity OAuth/runtime configuration. */
    private readonly antigravityConfig: Config['antigravity'] = {},
    /** The CLI version each route presents, shown beside the provider in Settings. */
    private readonly clientVersions: Partial<Record<ProviderId, () => Promise<CliVersion | undefined>>> = {},
    private readonly resetRedemption?: ResetRedemption,
    /**
     * Runs on a manual (forced) usage refresh of one account. The plugin
     * clears that account's pool cooldowns here: the Settings "Refresh"
     * button is the user's "retry now" — a stale cooldown left by a transient
     * failure must not outlive an explicit re-check (issue #139).
     */
    private readonly onUsageForced?: (provider: ProviderId, account: string) => void,
    /** Opt-in provider gate (Antigravity defaults to disabled); false blocks login and usage calls. */
    private readonly providerEnabled: (provider: ProviderId) => boolean = () => true,
    /** Which ZCode station the GLM login and inference use. */
    private readonly glmStation: () => 'bigmodel' | 'zai' = () => 'bigmodel',
  ) {}

  prepareReset(account: string, signal: AbortSignal) {
    if (!this.resetRedemption) throw new BadRequest('Reset redemption unavailable')
    return this.resetRedemption.prepare(account, AbortSignal.any([signal, AbortSignal.timeout(20_000)]))
  }

  async consumeReset(account: string, ticket: string, signal: AbortSignal): Promise<void> {
    if (!this.resetRedemption) throw new BadRequest('Reset redemption unavailable')
    await this.resetRedemption.redeem(account, ticket, AbortSignal.any([signal, AbortSignal.timeout(20_000)]))
  }

  usage(provider: ProviderId, account: string, signal: AbortSignal, force = false): Promise<ProviderUsage> {
    if (!this.providerEnabled(provider)) return Promise.resolve({ supported: false })
    if (force) this.onUsageForced?.(provider, account)
    const fetcher = this.usageFetchers[provider]
    if (fetcher === undefined) return Promise.resolve({ supported: false })
    if (this.poolUsage === undefined) return fetcher(account, signal).then(snapshot => {
      const fetchedAt = Date.now()
      return { ...snapshot, fetchedAt, staleAt: fetchedAt + 5 * 60_000 }
    })
    return this.poolUsage.displaySnapshotFor(provider, account, force)
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
    const clientVersion = await this.clientVersions[provider]?.()
    return {
      ...provider === 'qwen'
        ? { quotaLinked: entries.some(({ session }) => {
          const console = (session as QwenSession).console
          return console !== undefined && console.expiresAt > Date.now()
        }) }
        : {},
      busy: this.flows.isBusy(provider) || this.deviceFlows.isBusy(provider)
        || this.zcodeLogins.has(provider) || this.qwenConsoleLogins.has(provider)
        || this.finalizing.has(provider)
        || (provider === 'glm' && this.glmStarting)
        || (provider === 'qwen' && this.qwenConsoleStarting),
      accounts: entries.map(({ key, session }, index) => {
        const account = accountOf(provider, session)
        const plan = planOf(provider, session)
        return {
          key,
          isDefault: index === 0,
          // A static platform key has no real expiry; do not show a fake one.
          ...provider === 'qwen' ? {} : { expiresAt: session.expiresAt },
          ...account === undefined ? {} : { account },
          ...plan === undefined ? {} : { plan },
          ...provider === 'qwen'
            ? { quotaLinked: (() => {
              const console = (session as QwenSession).console
              return console !== undefined && console.expiresAt > Date.now()
            })() }
            : {},
        }
      }),
      ...detail === undefined ? {} : { detail },
      ...clientVersion === undefined ? {} : { clientVersion },
    }
  }

  async login(provider: ProviderId, method?: LoginMethod, account?: string): Promise<{ authorizeUrl: string; userCode?: string }> {
    if (!this.providerEnabled(provider)) {
      throw new BadRequest(`provider ${provider} is disabled; enable it manually in Settings > Subscriptions first`)
    }
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
    if (provider === 'kimi') {
      // Device flow: the UI shows the user code while the background task
      // polls the provider's OAuth host for the token pair.
      const attempt = await this.deviceFlows.start(provider, await kimiDeviceFlow())
      this.beginFinalizing(provider)
      void this.completeKimiDevice(attempt)
      return { authorizeUrl: attempt.verificationUrl, userCode: attempt.userCode }
    }
    if (provider === 'qwen') {
      // Inference is key-based; this browser flow only connects the console
      // session that can read quota.
      if (this.qwenConsoleLogins.has('qwen') || this.qwenConsoleStarting) {
        throw new Error('a qwen console login attempt is already in progress')
      }
      const accounts = await listAccounts('qwen')
      if (accounts.length === 0) {
        throw new BadRequest('Save the Qwen API key first, then log in to read quota')
      }
      // Link the console to the account the user clicked, never to whichever
      // account happens to be the default.
      const selected = account === undefined
        ? (accounts.length === 1 ? accounts[0] : undefined)
        : accounts.find(entry => entry.key === account)
      if (selected === undefined) {
        throw new BadRequest('Choose which Qwen account this quota login belongs to')
      }
      this.qwenConsoleStarting = true
      let attempt: QwenConsoleAttempt
      try {
        attempt = await startQwenConsoleLogin()
      } finally {
        this.qwenConsoleStarting = false
      }
      this.qwenConsoleLogins.set('qwen', attempt)
      this.beginFinalizing('qwen')
      void this.completeQwenConsole(attempt, selected.key)
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'glm') {
      // ZCode server-mediated flow: the browser completes against the station's
      // own callback; the plugin polls the flow and then mints the plan key.
      if (this.zcodeLogins.has('glm') || this.glmStarting) {
        throw new Error('a glm login attempt is already in progress')
      }
      // `startGlmLogin` awaits its init call, so reserve the slot first: two
      // clicks in that window must not open two browser flows.
      this.glmStarting = true
      let attempt: GlmLoginAttempt
      try {
        attempt = await startGlmLogin(this.glmStation())
      } finally {
        this.glmStarting = false
      }
      this.zcodeLogins.set('glm', attempt)
      this.beginFinalizing('glm')
      void this.completeGlm(attempt)
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'copilot') {
      // Device flow: no redirect URI — the UI shows the user code while the
      // background task polls GitHub for the token.
      const attempt = await this.deviceFlows.start(provider, copilotDeviceFlow())
      this.beginFinalizing(provider)
      void this.completeDevice(provider, attempt)
      return { authorizeUrl: attempt.verificationUrl, userCode: attempt.userCode }
    }
    const spec = provider === 'grok'
      ? await grokFlow()
      : provider === 'antigravity'
        ? antigravityFlow(resolveAntigravityOAuthConfig(this.antigravityConfig))
        : codexFlow
    const attempt = await this.flows.start(provider, spec)
    // Claimed only once the attempt exists: a rejected `start()` (one attempt
    // per provider) must not supersede the attempt already running.
    this.beginFinalizing(provider)
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
    } finally {
      this.endFinalizing(provider)
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
      this.endFinalizing(provider)
    }
  }

  /** Drive one Kimi device grant to a stored session. */
  private async completeKimiDevice(attempt: DeviceAttempt): Promise<void> {
    const provider = 'kimi'
    const claim = this.claim(provider)
    try {
      const tokens = await attempt.waitTokens()
      const session = completeKimiLogin(tokens)
      if (this.claims.get(provider) !== claim) return
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session))
    } catch (error) {
      if (this.claims.get(provider) !== claim) return
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    } finally {
      this.endFinalizing(provider)
    }
  }

  /** Merge a finished console login into the Qwen key session (quota only). */
  private async completeQwenConsole(attempt: QwenConsoleAttempt, account: string): Promise<void> {
    const claim = this.claim('qwen')
    try {
      const credentials = await attempt.wait()
      if (this.claims.get('qwen') !== claim) return
      const current = await getAccountSession('qwen', account) as QwenSession | undefined
      // The account may already be gone (logout) when the flow completes.
      if (current === undefined) return
      let cliAccessToken: string | undefined
      try {
        cliAccessToken = await exchangeQwenCliToken(credentials.accessToken)
      } catch {
        // Usage will retry the exchange with the stored device token.
      }
      const console = { ...credentials, ...cliAccessToken === undefined ? {} : { cliAccessToken } }
      // The exchange is a network call: logout or key replacement may have
      // happened since the snapshot above. Apply the console fields only, and
      // only when the account and its inference key are still the same.
      const wrote = await updateAccountSession('qwen', account, candidate => {
        if (this.claims.get('qwen') !== claim) return undefined
        if (candidate.accessToken !== current.accessToken) return undefined
        return { ...candidate, console }
      })
      if (!wrote) return
      this.lastError.delete('qwen')
      this.onAuthChanged('qwen', account)
    } catch (error) {
      if (this.claims.get('qwen') !== claim) return
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set('qwen', errorChain(error))
      }
    } finally {
      if (this.qwenConsoleLogins.get('qwen') === attempt) this.qwenConsoleLogins.delete('qwen')
      this.endFinalizing('qwen')
    }
  }

  /**
   * Store one provider API key as a non-expiring session (Qwen 千问AI平台).
   * @throws BadRequest when the provider or the key is not one this route accepts.
   */
  async saveKey(provider: ProviderId, key: string): Promise<void> {
    if (provider !== 'qwen') throw new BadRequest('API-key login is only available for qwen')
    let session: QwenSession
    try {
      session = qwenSessionFromKey(key)
    } catch (error) {
      throw new BadRequest(error instanceof Error ? error.message : String(error))
    }
    // Reuse a stored row for the same credential (including a legacy row keyed
    // by the bare plan name), so re-saving a key updates it instead of
    // appending a duplicate; a different key is a different account.
    const accounts = await listAccounts('qwen')
    const same = accounts.find(entry => (entry.session as QwenSession).accessToken === session.accessToken)
    const account = same?.key ?? accountKeyOf(provider, session)
    const existing = same?.session as QwenSession | undefined
    if (existing?.console !== undefined) session = { ...session, console: existing.console }
    this.claim(provider)
    await saveAccountSession('qwen', account, session as never)
    this.lastError.delete(provider)
    this.onAuthChanged(provider, account)
  }

  /** Drive one ZCode login through provisioning to a stored GLM session. */
  private async completeGlm(attempt: GlmLoginAttempt): Promise<void> {
    const claim = this.claim('glm')
    try {
      const session = await attempt.wait()
      if (this.claims.get('glm') !== claim) return
      const account = await this.persist('glm', session)
      this.lastError.delete('glm')
      this.onAuthChanged('glm', account)
    } catch (error) {
      if (this.claims.get('glm') !== claim) return
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set('glm', errorChain(error))
      }
    } finally {
      // Only the owning attempt may clear the slot: a cancel + immediate retry
      // installs a new attempt before this one finishes.
      if (this.zcodeLogins.get('glm') === attempt) this.zcodeLogins.delete('glm')
      this.endFinalizing('glm')
    }
  }

  /** Token exchange for one OAuth code; `protected` so tests can stand in for the provider endpoint. */
  protected exchange(provider: ProviderId, code: string, attempt: OAuthAttempt): Promise<StoredSession> {
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
      case 'kimi':
      case 'qwen':
        return Promise.reject(new Error(`${provider} uses the device flow; no authorization code to exchange`))
      case 'glm':
        return Promise.reject(new Error('glm uses the ZCode flow; no authorization code to exchange'))
      case 'antigravity':
        return exchangeAntigravityCode(
          code,
          attempt.pkce.verifier,
          attempt.redirectUri,
          resolveAntigravityOAuthConfig(this.antigravityConfig),
          this.antigravityConfig,
        )
    }
  }

  private async persist(provider: ProviderId, session: StoredSession): Promise<string> {
    // Keyed by the account's stable identity: re-logging the same account
    // updates in place, a different account appends.
    let account = accountKeyOf(provider, session)
    if (provider === 'kimi' && (session as KimiSession).account === undefined) {
      // An opaque Kimi access token carries no identity, and its rotating
      // refresh token cannot serve as one — logging the same single account
      // in again would otherwise append a duplicate on every login.
      const existing = await listAccounts('kimi')
      if (existing.length === 1) account = existing[0].key
    }
    if (provider === 'glm') {
      // Account keys now include the station (the same email can exist on
      // bigmodel and zai). A row written before that change is still keyed by
      // the bare email: reuse it for the same station instead of duplicating.
      const glm = session as GlmSession
      const existing = (await listAccounts('glm')).find(entry => {
        const stored = entry.session as GlmSession
        return stored.account !== undefined && stored.account === glm.account && stored.station === glm.station
      })
      if (existing !== undefined) account = existing.key
    }
    await saveAccountSession(provider, account, session as never)
    return account
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
    this.zcodeLogins.get(provider)?.cancel()
    this.zcodeLogins.delete(provider)
    this.qwenConsoleLogins.get(provider)?.cancel()
    this.qwenConsoleLogins.delete(provider)
    return Promise.resolve()
  }

  async logout(provider: ProviderId, account: string): Promise<void> {
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    this.zcodeLogins.get(provider)?.cancel()
    this.zcodeLogins.delete(provider)
    this.qwenConsoleLogins.get(provider)?.cancel()
    this.qwenConsoleLogins.delete(provider)
    await deleteAccountSession(provider, account)
    this.lastError.delete(provider)
    this.onAuthChanged(provider, account)
  }

  async setDefault(provider: ProviderId, account: string): Promise<void> {
    await setDefaultAccount(provider, account)
    this.onAuthChanged(provider, account)
  }
}

/** How long the Settings status waits on a CLI version refresh before showing the last one. */
const STATUS_VERSION_WAIT_MS = 1000

/**
 * Read the CLI version a route presents for the Settings page. The first
 * lookup is awaited (bounded by its own 5s deadline) so a slow registry is
 * not misreported as a fallback; a later refresh is waited on only briefly,
 * because the whole page waits on `status`, and the last result shows.
 */
export function presentedVersion(
  cache: Pick<NpmCliVersionCache, 'resolve' | 'current'>,
  waitMs = STATUS_VERSION_WAIT_MS,
): () => Promise<CliVersion | undefined> {
  return async () => {
    if (cache.current() === undefined) {
      await cache.resolve()
      return cache.current()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      cache.resolve(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs) }),
    ]).finally(() => { clearTimeout(timer) })
    return cache.current()
  }
}

export function apply(ctx: Context, config: Config): void {
  // Outbound requests (catalog discovery, the npm version lookup, token
  // refresh) must survive links where one TCP handshake exceeds Node's 250ms
  // Happy Eyeballs attempt budget; see MIN_CONNECT_ATTEMPT_TIMEOUT_MS.
  const previousAttemptTimeout = ensureConnectAttemptTimeout()
  ctx.effect(() => () => { restoreConnectAttemptTimeout(previousAttemptTimeout) }, 'dsh-plugin-subscriptions: connect attempt timeout')
  const preferences = new ProviderSettingsStore()
  const codexVersion = new CodexClientVersionCache()
  const claudeVersion = new ClaudeCliVersionCache()
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  // The schema rejects anything else in the settings UI, but `apply` is also
  // called with a plain object (tests, `--patch` overlays), so check here too.
  const claudePromptCacheTtl = config.claudePromptCacheTtl ?? DEFAULT_PROMPT_CACHE_TTL
  if (claudePromptCacheTtl !== '5m' && claudePromptCacheTtl !== '1h') {
    throw new Error(`${name}: claudePromptCacheTtl must be '5m' or '1h'`)
  }
  const claudeDeferTools = config.claudeDeferTools ?? []
  if (!Array.isArray(claudeDeferTools)
    || claudeDeferTools.some(pattern => typeof pattern !== 'string' || pattern.length === 0 || pattern !== pattern.trim())) {
    // A pattern with surrounding whitespace would silently match nothing, so it is rejected rather than trimmed.
    throw new Error(`${name}: claudeDeferTools must be an array of non-empty strings without surrounding whitespace`)
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
  // Optional, resolved per request for the same reason: maps an attachment's
  // host path into the tool execution world, so an image offloaded to text
  // names a read-only copy the model can reopen. Structural face of the
  // filesystem service; only this one method is consumed.
  const resolveHostPathMapper = (): HostPathMapper | undefined => {
    const fs = ctx.get('fs') as { processPathFromHostPath?: HostPathMapper } | undefined
    const map = fs?.processPathFromHostPath
    return typeof map === 'function' ? hostPath => map.call(fs, hostPath) : undefined
  }

  // Registration handles are kept so an auth-state change can re-announce the
  // route (`replace` fires `llm/adapters-updated`), which makes the web model
  // picker re-query `listModels` and show/hide the provider.
  const handles = new Map<string, AdapterRegistrationHandle>()
  // The constructed adapters, for the pool route to fail over between.
  const adapters = new Map<ProviderId, AccountAwareAdapter>()
  // Per-provider account token managers; also the pool's account lists.
  const accountTokens = new Map<ProviderId, AccountTokenManager<StoredSession>>()
  // Pool state, assigned when the pool route registers below; read here so an
  // auth change immediately recovers the account's cooling members and
  // refreshes its quota snapshot.
  let poolHealth: PoolHealthRegistry | undefined
  let poolUsage: PoolUsageTracker | undefined
  let poolAdapter: PoolAdapter | undefined
  const imagePool = new ImageAccountPool({
    enabled: config.pool?.enabled !== false && (config.pool?.autoAccounts ?? config.pool?.autoFamilies ?? true),
    onWarn,
  })
  const catalogChanged = (): void => {
    poolAdapter?.invalidate()
    for (const [route, handle] of handles) handle.replace([route])
  }
  const authChanged = (provider: ProviderId, account?: string): void => {
    if (provider === 'codex' || provider === 'grok') imagePool.clear(provider, account)
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
  // Model-bound composer choices persist independently of subagent defaults.
  // Legacy callers without a model retain the session-only override.
  const modelSpeeds = new ModelSpeeds()
  const speedBySession = new Map<string, SpeedTier>()
  const speedBySessionModel = new Map<string, Map<string, SpeedTier>>()
  const selectedSpeed = (sessionId: string, model?: string): SpeedTier => {
    if (model !== undefined) model = parseAccountModelId(model)?.model ?? model
    const explicit = (model === undefined ? undefined : speedBySessionModel.get(sessionId)?.get(model))
      ?? speedBySession.get(sessionId)
    if (explicit !== undefined) return explicit
    // The request itself carries no subagent flag. The live registry exposes
    // durable origin metadata for spawn, fork, and resumed subagents alike.
    const agent = ctx.get('agents')?.get(sessionId as NonNullable<GenerateOptions['sessionId']>)
    if (model !== undefined && agent?.session.header.origin === 'subagent') {
      return preferences.subagentSpeed(parseAccountModelId(model)?.model ?? model)
    }
    return model === undefined ? 'standard' : modelSpeeds.get(model) ?? 'standard'
  }
  let codexAdapter: CodexAdapter | undefined
  let grokAdapter: GrokAdapter | undefined
  // Dropped on every copilot auth transition so replay state (captured
  // reasoning) never survives an account switch in memory.
  let copilotAdapter: CopilotAdapter | undefined
  const memberAdapters = new Map<ProviderId, AccountAwareAdapter>()
  // Usage window tracking: one store per plugin
  // instance. It owns the window tracker, loads `trackingStartedAt` and the
  // open entries from disk, and saves behind the request path; events that
  // arrive before it has loaded are applied once it has. Dispose saves what
  // is pending.
  const usageStore = new WindowStore({ onWarn })
  ctx.effect(() => () => usageStore.dispose(), 'dsh-plugin-subscriptions: usage window store')
  // The provider total from before tracking: folded once from DSH's
  // session history, which only `sessionQuery` reads. The service is
  // optional (headless profiles have none), so the scan waits for it.
  // It also waits for `sessionPersistence`: without it `sessionQuery`
  // lists only the live sessions, and a scan then would store a total that
  // misses every stored session and is never recomputed.
  // Leaving either service aborts a running scan, which then writes nothing
  // and is retried at the next startup; dispose waits for a scan already
  // writing, within the shutdown bound.
  const preTracking = new PreTracking({
    onWarn,
    trackingStartedAt: async () => {
      await usageStore.ready
      return usageStore.trackingStartedAt
    },
  })
  ctx.inject(['sessionQuery', 'sessionPersistence'], queryCtx => {
    queryCtx.effect(
      () => preTracking.attach(queryCtx.get('sessionQuery') as HostSessionQuery),
      'dsh-plugin-subscriptions: earlier usage history scan',
    )
  })
  // Usage inspection does not fetch quota or make provider requests.
  const usageService = new UsageService({ store: usageStore, preTracking })
  ctx.effect(() => () => { usageService.dispose() }, 'dsh-plugin-subscriptions: usage service')
  const onRequestEnd = (end: RequestEnd): void => { usageStore.recordRequest(end) }
  const register = (provider: ProviderId, adapter: AccountAwareAdapter): AdapterRegistrationHandle => {
    const route = new AccountPreferencesAdapter({
      provider, adapter, settings: preferences, pool: () => poolAdapter, onRequestEnd,
      enabled: () => preferences.providerEnabled(provider),
      accounts: async () => (await accountTokens.get(provider)?.list() ?? []).map(({ key, session }) => ({ key, label: accountOf(provider, session) ?? key })),
    })
    memberAdapters.set(provider, route.poolMember())
    return ctx.llm.registerAdapter([provider], route)
  }
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
        usageFetchers.codex = async (account, signal) => {
          const session = await tokens.session(account)
          const usage = await fetchCodexUsage(session, proxiedFetch, signal)
          try {
            const resetCredits = await fetchCodexResetCredits(session, proxiedFetch, signal)
            return { ...usage, resetCredits }
          } catch (error) {
            // Reset credits are an optional private endpoint; preserve ordinary usage.
            const message = error instanceof Error ? error.message : String(error)
            return { ...usage, resetCreditsError: message }
          }
        }
        let adapter!: CodexAdapter
        adapter = new CodexAdapter({
          ...config.codexClientVersion === undefined ? {} : { clientVersion: config.codexClientVersion },
          resolveClientVersion: () => codexVersion.resolve(),
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
          onCatalogChanged: catalogChanged,
          accountCatalogStore: account => accountCatalogStore('codex', account),
          defaultEffortOf: (model: string) => defaultEffortOf('codex', model),
          contextWindowOf: model => preferences.contextWindow('codex', model),
          defaultContextWindow: () => preferences.get('codex').contextWindow,
          defaultMaxTokens: () => preferences.get('codex').defaultMaxTokens,
          pool: () => poolAdapter,
          speedFor: (sessionId: string | undefined, model: string): boolean | Promise<boolean> =>
            sessionId !== undefined
            && selectedSpeed(sessionId, model) === 'fast'
            && adapter.supportsFastTier(model),
        })
        codexAdapter = adapter
        adapters.set('codex', adapter)
        handles.set('codex', register('codex', adapter))
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
          fetchClaudeUsage(await tokens.session(account), proxiedFetch, signal, () => claudeVersion.resolve())
        const adapter = new ClaudeAdapter({
          models: catalog.claude,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('claude'),
          onWarn,
          resolveAttachments,
          resolveHostPathMapper,
          catalogStore: catalogStore('claude'),
          onCatalogChanged: catalogChanged,
          accountCatalogStore: account => accountCatalogStore('claude', account),
          defaultEffortOf: (model: string) => defaultEffortOf('claude', model),
          resolveCliVersion: () => claudeVersion.resolve(),
          promptCacheTtl: claudePromptCacheTtl,
          promptCacheTtlOverride: () => preferences.promptCacheTtl(),
          deferToolPatterns: () => claudeDeferTools,
          pool: () => poolAdapter,
        })
        adapters.set('claude', adapter)
        handles.set('claude', register('claude', adapter))
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
          onCatalogChanged: catalogChanged,
          accountCatalogStore: account => accountCatalogStore('grok', account),
          defaultEffortOf: (model: string) => defaultEffortOf('grok', model),
          // Catalog-driven context tiers (issue #149): the Settings page
          // offers the window list and the adapter caps the request here.
          contextWindowOf: model => preferences.contextWindow('grok', model),
          pool: () => poolAdapter,
        })
        grokAdapter = adapter
        adapters.set('grok', adapter)
        handles.set('grok', register('grok', adapter))
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
          onCatalogChanged: catalogChanged,
          accountCatalogStore: account => accountCatalogStore('copilot', account),
          defaultEffortOf: (model: string) => defaultEffortOf('copilot', model),
          pool: () => poolAdapter,
        })
        adapters.set('copilot', copilotAdapter)
        handles.set('copilot', register('copilot', copilotAdapter))
        break
      }
      case 'antigravity': {
        const tokens = new AccountTokenManager<AntigravitySession>({
          provider: 'antigravity',
          displayName: 'Google Antigravity',
          makeOptions: () => ({
            preemptMs: ANTIGRAVITY_PREEMPT_MS,
            refresh: session => refreshAntigravity(session, resolveAntigravityOAuthConfig(config.antigravity)),
            isPermanent: isAntigravityPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('antigravity', account) },
        })
        accountTokens.set('antigravity', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.antigravity = async (account, signal) => fetchAntigravityUsage(
          await tokens.session(account), config.antigravity, proxiedFetch, signal,
        )
        const adapter = new AntigravityAdapter({
          models: catalog.antigravity,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('antigravity'),
          ...config.antigravity === undefined ? {} : { runtime: config.antigravity },
          onWarn,
          resolveAttachments,
          catalogStore: catalogStore('antigravity'),
          onCatalogChanged: catalogChanged,
          accountCatalogStore: account => accountCatalogStore('antigravity', account),
          defaultEffortOf: model => defaultEffortOf('antigravity', model),
          pool: () => poolAdapter,
        })
        adapters.set('antigravity', adapter)
        handles.set('antigravity', register('antigravity', adapter))
        break
      }
      case 'kimi': {
        const tokens = new AccountTokenManager<KimiSession>({
          provider: 'kimi',
          displayName: 'Kimi Code',
          makeOptions: () => ({
            preemptMs: KIMI_PREEMPT_MS,
            refresh: refreshKimi,
            isPermanent: isKimiPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('kimi', account) },
        })
        accountTokens.set('kimi', tokens as unknown as AccountTokenManager<StoredSession>)
        const adapter = new ChatSubscriptionAdapter({
          definition: {
            id: 'kimi',
            name: 'Kimi Code',
            label: 'Kimi Code',
            endpoint: `${KIMI_API_BASE}/chat/completions`,
            replayReasoning: true,
            headers: () => kimiHeaders(),
            reasoning: kimiReasoning,
            discover: async (session, fetchFn, signal) => (await fetchKimiModels(
              session as KimiSession, fetchFn, signal,
            )).map(model => ({
              id: model.id,
              name: model.name,
              ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
              ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
              inputModalities: model.inputModalities,
            }) satisfies ChatSubscriptionDiscovered),
          },
          tokens: tokens as unknown as AccountTokenManager<ChatSubscriptionSession>,
          models: catalog.kimi,
          streamIdleTimeoutMs,
          rateLimit,
          onWarn,
          resolveAttachments,
          pool: () => poolAdapter,
        })
        usageFetchers.kimi = async (account, signal) =>
          fetchKimiUsage(await tokens.session(account), proxiedFetch, signal)
        adapters.set('kimi', adapter)
        handles.set('kimi', register('kimi', adapter))
        break
      }
      case 'glm': {
        const tokens = new AccountTokenManager<GlmSession>({
          provider: 'glm',
          displayName: 'GLM Coding Plan',
          makeOptions: () => ({
            preemptMs: 24 * 60 * 60_000,
            refresh: refreshGlm,
            isPermanent: isGlmPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('glm', account) },
        })
        accountTokens.set('glm', tokens as unknown as AccountTokenManager<StoredSession>)
        const adapter = new ChatSubscriptionAdapter({
          definition: {
            id: 'glm',
            name: 'GLM Coding Plan',
            label: 'GLM Coding Plan',
            // Follow the account's station, not the current config: a saved
            // bigmodel account must keep talking to bigmodel after the config
            // is switched to zai.
            endpoint: session => (session as GlmSession).station === 'zai'
              ? 'https://api.z.ai/api/coding/paas/v4/chat/completions'
              : 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
            replayReasoning: true,
            reasoning: glmReasoning,
            discover: async (session, fetchFn, signal) => {
              const known = new Map(catalog.glm.map(entry => [entry.id, entry]))
              return (await fetchGlmModels(session as GlmSession, fetchFn, signal)).map(id => {
                const entry = known.get(id)
                return {
                  id,
                  name: entry?.name ?? id,
                  // New GLM-5 releases share the same 1M/128k coding window;
                  // vision stays opt-in unless the catalog entry says so.
                  contextWindow: entry?.contextWindow ?? 1_000_000,
                  maxTokens: entry?.maxTokens ?? 128_000,
                  inputModalities: entry?.inputModalities ?? ['text'],
                }
              })
            },
          },
          tokens: tokens as unknown as AccountTokenManager<ChatSubscriptionSession>,
          models: catalog.glm,
          streamIdleTimeoutMs,
          rateLimit,
          onWarn,
          resolveAttachments,
          pool: () => poolAdapter,
        })
        usageFetchers.glm = async (account, signal) =>
          fetchGlmUsage(await tokens.session(account), proxiedFetch, signal)
        adapters.set('glm', adapter)
        handles.set('glm', register('glm', adapter))
        break
      }
      case 'qwen': {
        const tokens = new AccountTokenManager<QwenSession>({
          provider: 'qwen',
          displayName: 'Qwen 千问AI平台',
          makeOptions: () => ({
            // A static key never refreshes; the manager only needs a no-op.
            preemptMs: 60_000,
            refresh: refreshQwen,
            isPermanent: isQwenPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('qwen', account) },
        })
        accountTokens.set('qwen', tokens as unknown as AccountTokenManager<StoredSession>)
        const adapter = new ChatSubscriptionAdapter({
          definition: {
            id: 'qwen',
            name: 'Qwen 千问AI平台',
            label: 'Qwen 千问AI平台',
            endpoint: session => `${(session as QwenSession).baseURL ?? QWEN_STANDARD_BASE}/chat/completions`,
            headers: () => ({ 'user-agent': QWEN_USER_AGENT }),
            reasoning: qwenReasoning,
            discover: async (session, fetchFn, signal) => {
              // The console catalog reflects the account's real (including
              // preview) list; without a console login the static fallback wins.
              const console = (session as QwenSession).console
              if (console === undefined || console.expiresAt <= Date.now()) return []
              const known = new Map(catalog.qwen.map(entry => [entry.id, entry]))
              return (await listQwenConsoleModels(console, fetchFn, signal)).map(id => {
                const entry = known.get(id)
                return {
                  id,
                  name: entry?.name ?? id,
                  // The platform's text models share the 1M/131k window; known
                  // entries keep their own metadata instead of losing it.
                  contextWindow: entry?.contextWindow ?? 1_000_000,
                  maxTokens: entry?.maxTokens ?? 131_072,
                  inputModalities: entry?.inputModalities ?? ['text'],
                }
              })
            },
          },
          tokens: tokens as unknown as AccountTokenManager<ChatSubscriptionSession>,
          models: catalog.qwen,
          streamIdleTimeoutMs,
          rateLimit,
          onWarn,
          resolveAttachments,
          defaultEffortOf: model => defaultEffortOf('qwen', model),
          pool: () => poolAdapter,
        })
        usageFetchers.qwen = async (account, signal) => {
          const session = await tokens.session(account)
          const result = await fetchQwenUsage(session, proxiedFetch, signal)
          const consoleUpdate = result.updated?.console
          if (consoleUpdate !== undefined) {
            // A quota read holds a snapshot across an await. Apply the console
            // fields only, and only while the account still exists with the
            // same inference key; a late read must not undo logout/replacement.
            await updateAccountSession('qwen', account, current => current.accessToken === session.accessToken
              ? { ...current, console: consoleUpdate }
              : undefined)
          }
          return result.usage
        }
        adapters.set('qwen', adapter)
        handles.set('qwen', register('qwen', adapter))
        break
      }
    }
  }

  const trackUsage: SnapshotObserver = (provider, account, snapshot, at) => {
    try { usageStore.observe(provider, account, snapshot, at) }
    catch { onWarn(`Could not track the ${provider} quota window`) }
  }
  observeUsageFetchers(usageFetchers, trackUsage)

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
    const rawFetcherFor = (provider: ProviderId, account: string): (() => Promise<ProviderUsage>) | undefined => {
      switch (provider) {
        case 'codex': {
          // Settings reads the pool cache too: use the complete usage fetcher
          // so reset credits (and optional lookup errors) survive this path.
          const fetcher = usageFetchers.codex
          return fetcher === undefined ? undefined : () =>
            fetcher(account, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
        }
        case 'claude': {
          const tokens = claudeTokens
          return tokens === undefined ? undefined : async () =>
            fetchClaudeUsage(
              await tokens.session(account),
              proxiedFetch,
              AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS),
              () => claudeVersion.resolve(),
            )
        }
        case 'grok': {
          const tokens = grokTokens
          return tokens === undefined ? undefined : async () =>
            fetchGrokUsage(await tokens.session(account), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
        }
        case 'antigravity': {
          const tokens = accountTokens.get('antigravity')
          return tokens === undefined ? undefined : async () => fetchAntigravityUsage(
            await tokens.session(account) as AntigravitySession, config.antigravity, proxiedFetch,
            AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS),
          )
        }
        case 'kimi':
        case 'glm':
        case 'qwen': {
          // These routes register their usage fetcher in the provider loop;
          // the pool's own fetcher table must forward to it or Settings would
          // report the route as "no usage" even though the endpoint exists.
          const fetcher = usageFetchers[provider]
          return fetcher === undefined ? undefined : () =>
            fetcher(account, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
        }
        case 'copilot':
          return undefined
      }
    }
    // Codex already goes through the observed fetcher table. The other pool
    // fetchers keep their existing timeout/lookup behavior and report here.
    const fetcherFor = (provider: ProviderId, account: string): (() => Promise<ProviderUsage>) | undefined => {
      const fetch = rawFetcherFor(provider, account)
      if (fetch === undefined || provider === 'codex') return fetch
      return async () => {
        const snapshot = await fetch()
        trackUsage(provider, account, snapshot, Date.now())
        return snapshot
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
            if (!preferences.providerEnabled(provider)) return
            const accounts = (await accountTokens.get(provider)?.list() ?? []).map(entry => entry.key)
            if (accounts.length === 0) return
            const catalogs = (await Promise.all(accounts.map(async account => {
              const models = await withTimeout(
                signal => adapter.listOwnModels(provider, account, signal, true),
                POOL_USAGE_TIMEOUT_MS,
              )
              const settings = preferences.get(provider).accounts
              const policy = settings && Object.hasOwn(settings, account) ? settings[account] : undefined
              return models === undefined ? undefined : { account, models: models.filter(model => accountAllowsPool(policy, model.id, provider, models)) }
            }))).filter(entry => entry !== undefined)
            if (catalogs.length > 0) sources[provider] = { catalogs }
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
      adapters: Object.fromEntries(memberAdapters),
      health: poolHealth,
      usage: poolUsage,
      strategy: poolConfig?.strategy ?? 'quota_aware',
      switchMargin: poolConfig?.switchMargin ?? 2,
      defaultAccount: provider => accountTokens.get(provider)?.defaultAccount() ?? Promise.resolve(undefined),
      resolveAccount: (provider, account) => accountTokens.get(provider)?.resolveAccount(account) ?? Promise.resolve(account),
      families,
      tiers: poolConfig?.tiers ?? {},
      onWarn,
      onRequestEnd,
    })
  }

  // Keep the full catalog for the editor and routing; filter only picker enumeration.
  const fullCatalogs = new Map<ProviderId, (provider: string) => Promise<readonly LlmModelInfo[]>>()
  for (const [provider, adapter] of adapters) {
    const list = adapter.listModels.bind(adapter)
    fullCatalogs.set(provider, list)
    adapter.listModels = async route => (await list(route)).filter(model => preferences.visible(provider, model.id))
  }

  const speed: SpeedController = {
    async speed(sessionId, model) {
      const fastModels = await codexAdapter?.fastCapableModels() ?? []
      const accountPreferences = preferences.get('codex').accounts
      for (const { key } of await codexTokens?.list() ?? []) {
        if (!accountPreferences || !Object.hasOwn(accountPreferences, key) || accountPreferences[key].independentEntry !== true) continue
        for (const model of [...fastModels]) {
          if (parseAccountModelId(model)) continue
          if (await codexAdapter?.supportsFastTier(model, key)) fastModels.push(accountModelId(key, model))
        }
      }
      return {
        tier: model !== undefined && !fastModels.includes(model) ? 'standard' : selectedSpeed(sessionId, model),
        fastModels,
      }
    },
    async setSpeed(sessionId, tier, model) {
      if (model === undefined) {
        speedBySession.set(sessionId, tier)
        return
      }
      model = parseAccountModelId(model)?.model ?? model
      await modelSpeeds.set(model, tier)
      const choices = speedBySessionModel.get(sessionId) ?? new Map<string, SpeedTier>()
      choices.set(model, tier)
      speedBySessionModel.set(sessionId, choices)
    },
  }
  // Per-model default effort overrides (the Settings page's model pickers).
  // The catalog re-reads the live model info per model — same source as the
  // session model picker, so the offered effort levels match the picker
  // exactly, and the configured default merges in through the adapters.
  const modelDefaults: ModelDefaultsController = {
    async catalog(force = false): Promise<ModelDefaultsCatalog[]> {
      if (force) {
        codexVersion.invalidate()
        claudeVersion.invalidate()
        // This is not an auth transition: retain health, usage and Copilot
        // reasoning replay, but bypass every account's discovery cache.
        for (const adapter of adapters.values()) adapter.clearAccountCatalog()
        poolAdapter?.invalidate()
        for (const [route, handle] of handles) handle.replace([route])
      }
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
          if (tierIds.has(model.id) || parseAccountModelId(model.id)) continue
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
  const resetRedemption = new ResetRedemption(
    async (account, signal) => {
      if (!usageFetchers.codex) throw new BadRequest('Codex unavailable')
      return usageFetchers.codex(account, signal)
    },
    async (account, creditId, requestId, signal) => {
      if (!codexTokens) throw new BadRequest('Codex unavailable')
      await consumeCodexResetCredit(await codexTokens.session(account), creditId, requestId, proxiedFetch, signal)
    },
    account => poolUsage?.invalidate('codex', account),
    (account, at) => { usageStore.redeem('codex', account, at) },
  )
  registerAuthRpc(ctx, new SubscriptionsAuthController(
    flows, deviceFlows, authChanged, resolveAttachments, usageFetchers, undefined, poolUsage, config.antigravity,
    {
      ...providers.includes('codex') ? {
        codex: config.codexClientVersion === undefined
          ? presentedVersion(codexVersion)
          : async () => ({ version: config.codexClientVersion!, source: 'config' as const }),
      } : {},
      ...providers.includes('claude') ? { claude: presentedVersion(claudeVersion) } : {},
    },
    resetRedemption,
    (provider, account) => poolHealth?.clear(provider, account),
    provider => preferences.providerEnabled(provider),
    () => config.glm?.station === 'zai' ? 'zai' : 'bigmodel',
  ), speed, {
    get: () => proxyGetConfig(),
    set: input => proxySetConfig(input),
    test: payload => proxyTestConnection(payload.url, payload.proxy),
  }, modelDefaults, {
    displayName: provider => preferences.get(provider).displayName,
    visibleModels: provider => preferences.get(provider).visibleModels,
    enabled: provider => preferences.providerEnabled(provider),
    async setEnabled(provider, enabled) {
      if (provider !== 'antigravity') throw new BadRequest('Only Antigravity supports toggling enabled state')
      if (!adapters.has(provider)) throw new BadRequest(`provider ${provider} is not configured`)
      await preferences.setProviderEnabled(provider, enabled)
      if (!enabled) {
        flows.pending(provider)?.cancel()
      }
      poolAdapter?.invalidate()
      for (const [route, handle] of handles) handle.replace([route])
    },
    async get(provider, force) {
      await loadModelDefaults()
      const adapter = adapters.get(provider)
      if (!adapter) throw new BadRequest(`provider ${provider} is not configured`)
      if (!preferences.providerEnabled(provider)) {
        throw new BadRequest(`provider ${provider} is disabled; enable it manually in Settings > Subscriptions first`)
      }
      if (force) {
        if (provider === 'codex') codexVersion.invalidate()
        if (provider === 'claude') claudeVersion.invalidate()
        adapter.clearAccountCatalog()
        poolAdapter?.invalidate()
      }
      const models = await fullCatalogs.get(provider)!(provider)
      // Enumerate each account once, with the same bounds used by pool discovery.
      const accounts = await accountTokens.get(provider)?.list() ?? []
      const accountCatalogs = await Promise.all(accounts.map(async account => ({
        account: account.key,
        models: await withTimeout(signal => adapter.listOwnModels(provider, account.key, signal, !force), DISCOVERY_TIMEOUT_MS).catch(() => undefined),
      })))
      const tierIds = new Set((await poolAdapter?.modelsForProvider(provider).catch(() => []) ?? []).map(model => model.id))
      const fastModels = new Set(provider === 'codex' ? await codexAdapter?.fastCapableModels() ?? [] : [])
      const rows = await Promise.all(models.map(async model => {
        const contexts: { default: number; max: number }[] = []
        if (provider === 'codex' && codexAdapter) {
          for (const account of accountCatalogs) {
            if (account.models?.some(entry => entry.id === model.id)) {
              const limits = await withTimeout(
                () => codexAdapter.contextLimits(model.id, account.account),
                DISCOVERY_TIMEOUT_MS,
              ).catch(() => undefined)
              if (limits) contexts.push(limits)
            }
          }
        }
        const grokContexts: { default: number; max: number; options?: number[] }[] = []
        if (provider === 'grok' && grokAdapter) {
          for (const account of accountCatalogs) {
            if (account.models?.some(entry => entry.id === model.id)) {
              const limits = await withTimeout(
                () => grokAdapter.contextLimits(model.id, account.account),
                DISCOVERY_TIMEOUT_MS,
              ).catch(() => undefined)
              if (limits) grokContexts.push(limits)
            }
          }
        }
        const grokLimits = (() => {
          if (grokContexts.length === 0) return undefined
          const defaultWindow = Math.min(...grokContexts.map(entry => entry.default))
          const maxWindow = Math.min(...grokContexts.map(entry => entry.max))
          const optionSets = grokContexts.map(entry => new Set(entry.options ?? [entry.default]))
          const commonOptions = [...optionSets[0]]
            .filter(option => option <= maxWindow && optionSets.every(set => set.has(option)))
            .sort((left, right) => left - right)
          return {
            default: defaultWindow,
            max: maxWindow,
            ...(commonOptions.length > 1 ? { options: commonOptions } : {}),
          }
        })()
        // A model with unavailable capabilities can still be hidden or restored.
        const info = await withTimeout(() => adapter.resolveModel(provider, model.id), DISCOVERY_TIMEOUT_MS).catch(() => undefined)
        return {
          id: model.id, name: model.name,
          contextWindow: info?.context?.contextWindow,
          efforts: tierIds.has(model.id) ? [] : info?.reasoning?.efforts.map(({ id, name }) => ({ id, name })) ?? [],
          configured: defaultEffortOf(provider, model.id),
          ...(provider === 'codex' ? { fastTier: !tierIds.has(model.id) && fastModels.has(model.id) } : {}),
          ...(contexts.length ? {
            defaultContextWindow: Math.min(...contexts.map(entry => entry.default)),
            maxContextWindow: Math.min(...contexts.map(entry => entry.max)),
          } : {}),
          ...(grokLimits === undefined ? {} : {
            defaultContextWindow: grokLimits.default,
            maxContextWindow: grokLimits.max,
            ...grokLimits.options === undefined ? {} : { contextWindowOptions: grokLimits.options },
          }),
        }
      }))
      // Announce forced refresh only after the replacement catalog is ready.
      if (force) handles.get(provider)?.replace([provider])
      return {
        provider, settings: preferences.get(provider), models: rows, tools: PROVIDER_TOOLS[provider],
        // The config value the "follow config" choice resolves to, for the Settings page to label it.
        ...(provider === 'claude' ? { promptCacheTtlDefault: claudePromptCacheTtl } : {}),
        accounts: accounts.map(({ key, session }) => {
          const catalog = accountCatalogs.find(entry => entry.account === key)?.models
          return { key, label: accountOf(provider, session) ?? key, models: (catalog ?? []).map(({ id, name }) => ({ id, name })), ...(catalog === undefined ? { unavailable: true } : {}) }
        }),
      }
    },
    async set(provider, settings) {
      if (!adapters.has(provider)) throw new BadRequest(`provider ${provider} is not configured`)
      let validated
      try { validated = validatePreferences(provider, settings) } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : String(error))
      }
      const next = provider === 'antigravity'
        && preferences.providerEnabled('antigravity')
        && !Object.hasOwn(settings as Record<string, unknown>, 'enabled')
        ? { ...validated, enabled: true }
        : validated
      await preferences.set(provider, next)
      poolAdapter?.invalidate()
      for (const [route, handle] of handles) handle.replace([route])
    },
  }, createUsageHistoryController(
    usageService,
    // The auth store's list (default first), as the card shows it; reading it refreshes no token.
    async provider => (await listAccounts(provider)).map(({ key, session }) => {
      const label = accountOf(provider, session)
      return label === undefined ? { key } : { key, label }
    }),
  ))

  // OpenCode-style cadence: a startup check (five-minute cache freshness),
  // then one hour between completed runs. Picker reads never schedule refreshes.
  ctx.effect(() => startCatalogRefresh(async signal => {
    await Promise.all([...adapters].map(async ([provider, adapter]) => {
      if (signal.aborted || overridden.has(provider) || !preferences.providerEnabled(provider)) return
      // Account unions bound each discovery and omit logged-out accounts.
      await adapter.listOwnModels(provider, undefined, signal)
    }))
  }, () => onWarn('background model catalog refresh failed; next automatic attempt is in one hour')),
  'dsh-plugin-subscriptions: hourly model catalog refresh')

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

  // `web` is optional on headless/minimal compositions. Register Codex behind
  // DSH's native web_search tool when the capability seam is mounted.
  //
  // `web_search` is the host's tool, not one this plugin registers, so the
  // Codex switch gates this provider's `available()` rather than the tool
  // itself: turned off, the seam auto-selects another registered provider, or
  // reports WEB_PROVIDER_UNAVAILABLE the way dsh-tool-web expects. Denying the
  // tool per agent would instead take web_search away from every other
  // provider in the composition.
  if (codexTokens !== undefined) {
    const tokens = codexTokens
    ctx.inject(['web'], webCtx => {
      webCtx.web.registerSearchProvider(new CodexWebSearchProvider({
        tokens,
        enabled: () => preferences.toolEnabled('codex', 'web_search'),
        fetchFn: proxiedFetch,
      }))
    })
  }

  // `tools` is optional (headless/minimal compositions may not mount it), so
  // registration waits for the service instead of injecting it at load.
  // x_search and video_generate follow the grok provider; image_generate
  // prefers the codex provider and falls back to grok.
  ctx.inject(['tools'], (toolsCtx) => {
    const registeredNames = new Map<string, string>()
    if (grokTokens !== undefined) {
      for (const definition of [
        createXSearchTool({ tokens: grokTokens }),
        createVideoGenerateTool({ tokens: grokTokens }),
      ]) {
        const result = registerWithAlias(toolsCtx.tools, definition)
        if (result !== undefined) registeredNames.set(definition.name, result.name)
      }
    }
    if (codexTokens !== undefined || grokTokens !== undefined) {
      const result = registerWithAlias(toolsCtx.tools, createImageGenerateTool({
        imagePool,
        ...codexTokens === undefined ? {} : { codexTokens },
        ...grokTokens === undefined ? {} : { grokTokens },
        resolveAttachments,
        resolveLlm: () => ctx.get('llm'),
        providerEnabled: (provider, createdAt) => preferences.toolEnabled(provider, 'image_generate', createdAt),
      }))
      if (result !== undefined) registeredNames.set('image_generate', result.name)
    }
    // Restrictions are scoped to each agent. Keep global definitions registered
    // so already-open sessions retain both their schemas and execution path.
    toolsCtx.on('agent/created', ({ agent }) => {
      const at = agent.session.header.createdAt
      const deny: string[] = []
      if (grokTokens !== undefined) {
        for (const tool of ['x_search', 'video_generate'] as const) {
          const registered = registeredNames.get(tool)
          if (registered !== undefined && !preferences.toolEnabled('grok', tool, at)) deny.push(registered)
        }
      }
      if ((codexTokens !== undefined || grokTokens !== undefined)
        && !(codexTokens !== undefined && preferences.toolEnabled('codex', 'image_generate', at))
        && !(grokTokens !== undefined && preferences.toolEnabled('grok', 'image_generate', at))) {
        const registered = registeredNames.get('image_generate')
        if (registered !== undefined) deny.push(registered)
      }
      if (deny.length) agent.ctx.tools.restrict({ deny })
      return undefined
    })
  })
}
