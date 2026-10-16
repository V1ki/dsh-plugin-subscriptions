/**
 * dsh-plugin-subscriptions: register OAuth-subscription LLM providers
 * (ChatGPT/Codex, Claude, Grok, GitHub Copilot, Google Antigravity) on `ctx.llm`, and expose the `/subscriptions-auth`
 * RPC channel the web Settings page uses to run the logins. The token store
 * lives at `~/.dsh/plugins/subscriptions/auth.json`; the channel registers only when
 * a host `connection` service exists, so headless compositions load fine.
 * @module dsh-plugin-subscriptions
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ProviderId } from './auth/store.js';
import type { ModelEntry } from './providers/common.js';
import type { RateLimitConfig } from './providers/rate-limit.js';
import type { PromptCacheTtl } from './translate/anthropic.js';
import type { CliVersion, NpmCliVersionCache } from './providers/npm-cli-version.js';
export type { AccountPreferences, ProviderPreferences } from './provider-settings.js';
import type { PoolMemberRef } from './providers/pool-family.js';
import type { AntigravityRuntimeConfig } from './providers/antigravity.js';
export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js';
export type { RateLimitConfig, RateLimitWait } from './providers/rate-limit.js';
export type { ProviderStatus } from './auth/rpc.js';
export type { AntigravitySession, ClaudeSession, CodexSession, CopilotSession, GrokSession, ProviderId } from './auth/store.js';
export declare const name = "dsh-plugin-subscriptions";
export declare const inject: string[];
/** Default maximum provider idle time while one stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Bound on one pool quota poll — member selection must not hang on a usage endpoint. */
export declare const POOL_USAGE_TIMEOUT_MS = 10000;
export { withTimeout } from './providers/common.js';
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
    /** Codex /models client_version override; does not change account entitlements. */
    codexClientVersion?: string;
    /** Provider routes to register; defaults to every supported provider. */
    providers?: ProviderId[];
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
    /**
     * How long Anthropic keeps the Claude conversation cache after its last use:
     * `'5m'` (default, the API's own default) or `'1h'`. One hour writes cache
     * entries at 2× the input price instead of 1.25×, and pays off when you
     * regularly pause longer than five minutes between messages. Claude only;
     * compaction and session-title requests always stay on five minutes.
     */
    claudePromptCacheTtl?: PromptCacheTtl;
    /** Whether and how long a route waits out a closed rate-limit window. */
    rateLimit?: RateLimitConfig;
    /** Advisory model catalogs overriding the built-in defaults, per provider. */
    models?: {
        codex?: ModelEntry[];
        claude?: ModelEntry[];
        grok?: ModelEntry[];
        copilot?: ModelEntry[];
        antigravity?: ModelEntry[];
    };
    /** Antigravity-specific OAuth and endpoint configuration. */
    antigravity?: AntigravityRuntimeConfig & {
        /** Google OAuth client id. May instead be supplied as ANTIGRAVITY_CLIENT_ID. */
        clientId?: string;
        /** Google OAuth client secret, when required by the client registration. */
        clientSecret?: string;
    };
    /** Same-subscription account pools (and optional extra tier models). */
    pool?: {
        /** Enable account pooling (default true; needs ≥2 accounts of one provider). */
        enabled?: boolean;
        /** Member selection: plain priority failover, or quota-aware urgency scheduling. */
        strategy?: 'priority' | 'quota_aware';
        /** A challenger must out-score the sticky member by this factor to take over (default 2). */
        switchMargin?: number;
        /** Auto-pool every catalog model across a provider's logged-in accounts (default true). */
        autoAccounts?: boolean;
        /** @deprecated Use {@link autoAccounts}. */
        autoFamilies?: boolean;
        /** Explicit account lists for one catalog model (same provider); replaces the auto pool. */
        families?: Record<string, PoolMemberRef[]>;
        /** Extra picker entries with heterogeneous fallbacks, listed under the first member's provider. */
        tiers?: Record<string, PoolMemberRef[]>;
    };
}
export declare const Config: z<Config>;
/**
 * Read the CLI version a route presents for the Settings page. The first
 * lookup is awaited (bounded by its own 5s deadline) so a slow registry is
 * not misreported as a fallback; a later refresh is waited on only briefly,
 * because the whole page waits on `status`, and the last result shows.
 */
export declare function presentedVersion(cache: Pick<NpmCliVersionCache, 'resolve' | 'current'>, waitMs?: number): () => Promise<CliVersion | undefined>;
export declare function apply(ctx: Context, config: Config): void;
