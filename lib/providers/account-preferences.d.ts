import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ProviderId } from '../auth/store.js';
import type { ProviderSettingsStore, AccountPreferences } from '../provider-settings.js';
import type { AccountAwareAdapter } from './accounts.js';
import type { PoolAdapter } from './pool.js';
/** Reserved namespace, recognized even when malformed or no longer enabled. */
export declare const ACCOUNT_MODEL_PREFIX = "~account:";
export declare function accountModelId(account: string, model: string): string;
export declare function parseAccountModelId(id: string): {
    account: string;
    model: string;
} | undefined;
export declare function accountAllowsPool(preferences: AccountPreferences | undefined, model: string): boolean;
interface Options {
    provider: ProviderId;
    adapter: AccountAwareAdapter;
    settings: ProviderSettingsStore;
    accounts: () => Promise<readonly {
        key: string;
        label: string;
    }[]>;
    pool: () => PoolAdapter | undefined;
    /** Per-account discovery bound (defaults to {@link DISCOVERY_TIMEOUT_MS}; tests shorten it). */
    discoveryTimeoutMs?: number;
}
/** Keeps the registered route separate from raw adapters and pool member seams. */
export declare class AccountPreferencesAdapter extends LlmAdapter {
    private readonly options;
    constructor(options: Options);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): import("@deepseek-ai/dsh-llm").ResolvedRetryPolicy | undefined;
    private preference;
    private models;
    private requireAccount;
    private fallback;
    /** Pool-only facade: explicit families/tiers must obey the same policy as auto pools. */
    poolMember(): AccountAwareAdapter;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, id: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, id: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    /** Presentation only: routing still uses the original model id. */
    private present;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export {};
