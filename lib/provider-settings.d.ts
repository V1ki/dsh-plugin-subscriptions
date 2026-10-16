import { type ProviderId } from './auth/store.js';
export declare const PROVIDER_TOOLS: {
    readonly codex: readonly ["image_generate", "web_search"];
    readonly claude: readonly [];
    readonly grok: readonly ["image_generate", "video_generate", "x_search"];
    readonly copilot: readonly [];
    readonly antigravity: readonly [];
};
export type SubscriptionTool = 'image_generate' | 'video_generate' | 'x_search' | 'web_search';
/** Mirrors `PromptCacheTtl` in translate/anthropic.ts; kept here so the client bundle needs no translate import. */
export declare const PROMPT_CACHE_TTLS: readonly ["5m", "1h"];
export type PromptCacheTtlSetting = typeof PROMPT_CACHE_TTLS[number];
export interface AccountPreferences {
    alias?: string;
    /** Absent means included. */
    poolEnabled?: boolean;
    /** Absent means no separate picker entries. */
    independentEntry?: boolean;
    /** Absent allows every model; [] allows none. */
    poolModels?: string[];
}
export interface ProviderPreferences {
    /** Presentation only; never used as a provider or model routing key. */
    displayName?: string;
    modelDisplayNames?: Record<string, string>;
    accounts?: Record<string, AccountPreferences>;
    /** Absent follows discovery; an explicit selection hides newly discovered models. */
    visibleModels?: string[];
    contextWindows?: Record<string, number>;
    tools?: Partial<Record<SubscriptionTool, boolean>>;
    /** Claude only: overrides the plugin config's `claudePromptCacheTtl`; absent follows config. */
    promptCacheTtl?: PromptCacheTtlSetting;
}
export declare function validatePreferences(provider: ProviderId, input: unknown): ProviderPreferences;
/** Durable user preferences, independent of expiring discovery caches. */
export declare class ProviderSettingsStore {
    private current;
    private writes;
    readonly path: string;
    constructor(path?: string);
    get(provider: ProviderId): ProviderPreferences;
    visible(provider: ProviderId, model: string): boolean;
    modelName(provider: ProviderId, model: string, fallback: string): string;
    contextWindow(model: string): number | undefined;
    /** The Settings-page Claude cache TTL; undefined follows the plugin config. Read per request, so no clone. */
    promptCacheTtl(): PromptCacheTtlSetting | undefined;
    /** Creation-time policy survives restarts and never changes an existing session. */
    toolEnabled(provider: ProviderId, tool: SubscriptionTool, createdAt?: number): boolean;
    set(provider: ProviderId, input: unknown): Promise<void>;
}
