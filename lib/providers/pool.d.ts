/**
 * The pool adapter: same-subscription account routing, plus optional
 * configured tier extras. The picker is the union of every account's
 * catalog. A model listed by several accounts failovers; a model listed by
 * one account is pinned to it. Tiers are extra picker rows. Member
 * selection is sticky per session (so prompt caches survive) and optionally
 * quota-aware; failures fail over to the next member as long as no stream
 * content chunk has been emitted (leading usage remains buffered).
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ProviderId } from '../auth/store.js';
import type { AccountAwareAdapter } from './accounts.js';
import type { PoolDefinition, PoolMemberRef } from './pool-family.js';
import { PoolHealthRegistry } from './pool-health.js';
import type { PoolUsageTracker } from './pool-usage.js';
/** Member-selection strategy: plain priority failover or quota-aware scheduling. */
export type PoolStrategy = 'priority' | 'quota_aware';
export interface PoolAdapterOptions {
    /** The live subscription adapters, by provider route. */
    adapters: Partial<Record<ProviderId, AccountAwareAdapter>>;
    health: PoolHealthRegistry;
    usage: PoolUsageTracker;
    strategy: PoolStrategy;
    /** A challenger must out-urgency the sticky member by this factor to take over. */
    switchMargin: number;
    /** The default account of one provider (for config members omitting `account`). */
    defaultAccount: (provider: ProviderId) => Promise<string | undefined>;
    /** Resolve legacy account aliases before pool deduplication and cache identity. */
    resolveAccount?: (provider: ProviderId, account: string) => Promise<string>;
    /** Account pools (auto-aggregated plus config overrides), resolved lazily. */
    families: () => Promise<Map<string, PoolDefinition>>;
    /** User-configured extra picker entries (heterogeneous fallbacks), by pool id. */
    tiers: Record<string, PoolMemberRef[]>;
    onWarn: (message: string) => void;
}
export declare class PoolAdapter extends LlmAdapter {
    private readonly options;
    /** sessionId|poolId → member key of the last member that served a chunk. */
    private readonly sticky;
    /** Messages already warned about — configuration diagnostics repeat every request otherwise. */
    private readonly warned;
    /**
     * Short-lived pools snapshot. `owns()` runs on every resolveModel — the
     * model picker issues one per entry — and pool assembly touches every
     * provider's catalog and account store, so recompute at most this often.
     * Auth changes bump {@link generation} so a stale snapshot cannot land.
     */
    private poolsCache;
    private poolsInflight;
    private generation;
    constructor(options: PoolAdapterOptions);
    /** Drop the pools snapshot so the next read reflects the current accounts. */
    invalidate(): void;
    /** Warn once per distinct message (pools() runs on every request). */
    private warnOnce;
    /** Drop members whose adapter is not registered (copy — caller state is shared). */
    private usable;
    /** Account pools (auto-aggregated plus config overrides) with usable members. */
    private familyPools;
    /** All pools (account pools merged with extra tiers) with usable members. */
    private pools;
    /** Recompute the pools snapshot (account pools merged with extra tiers). */
    private assemblePools;
    /**
     * Extra picker rows one provider lists (configured tiers). Account pools
     * reuse the catalog entry of the same wire id, so they are not listed
     * again — the picker stays one row per model in ChatGPT / Claude / ….
     */
    modelsForProvider(provider: ProviderId): Promise<LlmModelInfo[]>;
    /**
     * Whether `model` on `provider`'s route is served here (several accounts
     * fail over, one account is pinned, or a configured tier).
     */
    owns(provider: ProviderId, model: string): Promise<boolean>;
    /**
     * Resolve every member's account (config members may omit it to mean "the
     * default account") and drop members with no resolvable login. Duplicates
     * collapse — an explicitly pinned account and the default may coincide.
     */
    private concrete;
    /**
     * Resolve a pool model to the conservative INTERSECTION of its members'
     * capabilities: the smallest context window and output cap, the reasoning
     * efforts every member supports, and the modalities all of them accept —
     * so a request valid for the pool stays valid after a failover. Capability
     * metadata is account-specific, so every distinct member is resolved.
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private streamMembers;
    /**
     * Order the candidates for one request. Health filters both strategies;
     * `quota_aware` then ranks by urgency (members without telemetry, e.g.
     * copilot, score zero and sink to the bottom of their class), while
     * quota-exhausted members stay as a last-resort tail in pool order. The
     * sticky member keeps its lead unless a challenger out-scores it by
     * `switchMargin`.
     */
    private select;
    /** Pin the serving member to the session (with bounded memory). */
    private remember;
    /**
     * The error for an exhausted pool. It says WHY (issue #139): the last
     * member failure of this request when members were tried, or the cooling
     * record that kept every member out of the candidate set — and its `code`
     * is that failure's own code, never a synthetic `RATE_LIMIT` (a transport
     * blip on a single-member pool used to be reported as a rate limit). The
     * earliest recovery hint is scoped to THIS pool's members (the health
     * registry is shared across pools).
     */
    private exhausted;
}
