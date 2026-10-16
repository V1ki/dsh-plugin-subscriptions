/**
 * Same-subscription account routing: the picker is the union of every
 * account's catalog (deduped by wire id). A model listed by two or more
 * accounts failovers between them; a model listed by only one account is
 * sent to that account. No extra pool identity, no cross-provider
 * aggregation.
 */
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm';
import type { ProviderId } from '../auth/store.js';
/** One pool member: an exact provider/account/model route. */
export interface PoolMemberRef {
    provider: ProviderId;
    /** Account key; omitted in configured members to mean "the default account". */
    account?: string;
    model: string;
}
/** A member with its account resolved (no config indirection left). */
export type ConcretePoolMember = PoolMemberRef & {
    account: string;
};
/** One pool: its members plus display metadata for the picker. */
export interface PoolDefinition {
    members: PoolMemberRef[];
    /** Display name of the catalog entry (account pools) or the pool id (extras). */
    name?: string;
    /** Description of the catalog entry, when the pool borrowed one. */
    description?: string;
    /**
     * When true, the pool is an extra picker entry (a configured tier). Account
     * pools leave this unset so they reuse the provider's existing catalog row.
     */
    extra?: boolean;
}
/** One account's catalog as seen through that account's credentials. */
export interface AccountCatalog {
    account: string;
    models: readonly LlmModelInfo[];
}
/** One provider's contribution to account-pool aggregation. */
export interface ProviderPoolSource {
    /** Per-account catalogs, default first. A model pools only the accounts that list it. */
    catalogs: readonly AccountCatalog[];
}
/** Map key for one provider's pool of one model (ids collide across providers). */
export declare function poolKey(provider: string, model: string): string;
/**
 * Build per-provider account routes. Each model id becomes a definition of
 * the accounts that list it: two or more fail over; one is pinned to that
 * account (so a Max-only model is never sent to a Plus login). The picker
 * unions these catalogs; a logout that drops a model to one account keeps
 * the same id and pins it to whoever remains.
 * @param sources - per-account catalogs (providers with no accounts list
 *   nothing and simply never join a pool).
 * @returns `provider/model` → pool definition (not listed as an extra entry).
 */
export declare function buildAccountPools(sources: Partial<Record<ProviderId, ProviderPoolSource>>): Map<string, PoolDefinition>;
