/**
 * Health bookkeeping for pool members: which `(provider, account, model)`
 * member is cooling down after a failure, and for how long. Purely in-memory
 * — a restart re-probes members naturally, so nothing here is persisted.
 *
 * The failure classifier maps the adapters' stable `LlmError` codes (see
 * `httpLlmError`/`mapFetchFailure` in `common.ts`) to one of three actions:
 * switch to another member with a cooldown, switch without recording a
 * cooldown (transport blips say nothing about the account), or rethrow
 * (the request itself is at fault and another account would fail alike).
 */
import type { ProviderId } from '../auth/store.js';
/** Registry key for one pool member. */
export declare function memberKey(provider: ProviderId, account: string, model: string): string;
/** Registry key parking EVERY member of one account (account-level failures). */
export declare function accountKey(provider: ProviderId, account: string): string;
/** Default cooldown when a quota/rate failure carries no `retry-after`. */
export declare const DEFAULT_QUOTA_COOLDOWN_MS: number;
/** Auth failures recheck after a day; a re-login clears the record immediately. */
export declare const AUTH_COOLDOWN_MS: number;
/** Transient server-side failures cool down briefly. */
export declare const TRANSIENT_COOLDOWN_MS = 60000;
/** Whether a failure parks one member or the account's whole quota. */
export type PoolFailureScope = 'member' | 'account';
/** What the pool should do with a member that just failed. */
export type PoolFailureAction = {
    action: 'switch';
    cooldownMs: number;
    reason: string;
    scope: PoolFailureScope;
} | {
    action: 'switch';
} | {
    action: 'throw';
};
/**
 * Classify a member failure. Quota and rate-limit failures cool down (using
 * the provider's own `retry-after` when sent, which is more accurate than
 * any fixed guess) — account-wide for account-metered providers, per-member
 * for model-scoped ones; auth failures park the account until re-login
 * (credentials are account-level); server/timeout failures get a short
 * per-member cooldown; transport failures switch without a record;
 * everything else — most importantly CONTEXT_WINDOW_EXCEEDED and ABORTED —
 * is the request's own fault and is rethrown untouched.
 * @param error - the failure thrown by a member adapter's stream.
 * @param provider - the failing member's provider (decides the quota scope).
 * @returns the action the pool should take.
 */
export declare function classifyPoolFailure(error: unknown, provider: ProviderId): PoolFailureAction;
/** One cooling record, named by its registry key (feeds the exhausted-pool diagnosis). */
export interface CoolingRecord {
    key: string;
    unavailableUntil: number;
    /** The failure code that parked the member (`RATE_LIMIT`, `AUTH`, `SERVER`, …). */
    reason: string;
}
/**
 * Cooldown registry keyed by {@link memberKey}. A member whose cooldown has
 * expired is simply available again — recovery is proven by the next real
 * request, not by a background probe.
 */
export declare class PoolHealthRegistry {
    private readonly records;
    /** Whether a member may serve: neither it nor its whole account is cooling. */
    isMemberAvailable(provider: ProviderId, account: string, model: string, now?: number): boolean;
    /** Whether one registry key is clear right now. */
    isAvailable(key: string, now?: number): boolean;
    /** Park a member for `cooldownMs`; a longer existing cooldown wins. */
    markUnavailable(key: string, cooldownMs: number, reason: string, now?: number): void;
    /**
     * Epoch ms at which the earliest cooling record among `keys` recovers;
     * `undefined` when none of them is cooling. The registry is shared by
     * every pool, so the caller passes the keys of ITS members (member and
     * account keys alike) — an unrelated pool's cooldown must not shape this
     * pool's retry hint. Feeds the pool-exhausted error's
     * `providerRetryAfterMs`.
     */
    earliestRecovery(keys: ReadonlySet<string>, now?: number): number | undefined;
    /**
     * The earliest-recovering cooling record among `keys` (with the failure
     * code that parked it), or `undefined` when none of them is cooling. Lets
     * an exhausted pool say WHY its members are parked, instead of assuming a
     * rate limit.
     */
    earliestRecoveryRecord(keys: ReadonlySet<string>, now?: number): CoolingRecord | undefined;
    /** Drop records of one provider, or of a single account when given (auth changes). */
    clear(provider: ProviderId, account?: string): void;
}
