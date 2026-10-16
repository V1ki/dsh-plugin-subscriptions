/**
 * Grok (X Premium / xAI) subscription provider: OIDC-discovered OAuth against
 * auth.x.ai with the Grok CLI client id, and streaming against the xAI
 * Responses-style endpoint.
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { FlowSpec } from '../auth/oauth-flow.js';
import type { GrokSession } from '../auth/store.js';
import type { PoolAdapter } from './pool.js';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { ResponsesRequestInput } from '../translate/responses.js';
import { AccountTokenManager } from './accounts.js';
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ProviderUsage } from './common.js';
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js';
export declare const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export declare const GROK_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export declare const GROK_API_URL = "https://api.x.ai/v1/responses";
/** Refresh when the access token has less than this much life left. */
export declare const GROK_PREEMPT_MS: number;
/**
 * Reads the reset instant of the xAI window that rejected a request.
 *
 * Body only. xAI serves the OpenAI-compatible `x-ratelimit-reset-*` family,
 * whose values are rollover durations (`6m0s`) present on every response, one
 * per bucket — on a 429 the earliest of them is usually a bucket with room
 * (`0s` for the request bucket while the token bucket is the one exhausted),
 * which would burn the whole retry budget in seconds. They reach the operator
 * through `rateLimitDiagnostics` instead.
 */
export declare const grokRateLimitReset: RateLimitResetReader;
/** Discovered OIDC endpoints for the xAI authorization server. */
export interface GrokDiscovery {
    authorizationEndpoint: string;
    tokenEndpoint: string;
}
/**
 * Resolve the xAI OIDC endpoints (cached after the first fetch).
 * @returns validated authorization and token endpoints.
 */
export declare function grokDiscovery(): Promise<GrokDiscovery>;
/**
 * Build the grok flow facts for the OAuth flow engine (async because the
 * authorize URL comes from OIDC discovery).
 * @returns the flow spec for one attempt.
 */
export declare function grokFlow(): Promise<FlowSpec>;
/**
 * The subscription tier encoded in a grok access token's `tier` claim (no
 * verification — same trust posture as the other claim reads).
 * @param accessToken - the stored access token.
 * @returns the display tier name, or undefined when the claim is absent.
 */
export declare function grokTierName(accessToken: string): string | undefined;
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
export declare function exchangeGrokCode(code: string, verifier: string, redirectUri: string, challenge: string): Promise<GrokSession>;
/**
 * Refresh a grok session (form-encoded grant).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export declare function refreshGrok(session: GrokSession): Promise<GrokSession>;
/**
 * Whether a grok refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export declare function isGrokPermanentRefreshError(error: unknown): boolean;
/**
 * The Grok Build CLI chat proxy's billing endpoint (the source of the CLI's
 * `/usage` "Usage limit" panel; see xai-org/grok-build
 * `extensions/billing.rs`). Forwards to the backend `GetGrokCreditsConfig`.
 */
export declare const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
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
export declare function fetchGrokUsage(session: GrokSession, fetchFn?: FetchFn, signal?: AbortSignal): Promise<ProviderUsage>;
export declare const GROK_MODELS_URL = "https://api.x.ai/v1/models";
/**
 * The Grok Build CLI chat proxy's model catalog — the only grok endpoint that
 * advertises reasoning capability. The `api.x.ai/v1/models` and
 * `/v1/language-models` payloads carry pricing, context, and aliases only, so
 * effort metadata must come from here (the same source the official CLI's
 * picker uses).
 */
export declare const GROK_CLI_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
/** Per-model metadata the CLI catalog contributes to a discovered model. */
type GrokCliModelMeta = Partial<Pick<DiscoveredModel, 'name' | 'description' | 'contextWindow' | 'reasoning'>>;
/**
 * Fetch the CLI catalog and index its per-model metadata by model id.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns model id → contributed metadata.
 */
export declare function fetchGrokCliCatalog(session: GrokSession, fetchFn?: FetchFn, signal?: AbortSignal): Promise<Map<string, GrokCliModelMeta>>;
/**
 * Fetch the live grok model list, enriched with the CLI catalog's per-model
 * metadata (display name, context window, reasoning efforts). The api.x.ai
 * list stays authoritative for which models exist; the CLI catalog is
 * enrichment only, so its failure degrades to a plain list instead of taking
 * discovery down. When enrichment is missing, last-known capability metadata
 * is carried forward so a transient CLI outage cannot strip efforts a
 * session already selected.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param onWarn - warning sink for a failed CLI catalog fetch.
 * @param previous - last-known catalog used to keep enrichment when the CLI
 *   catalog is down or omits a model.
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns discovered chat models in endpoint order.
 */
export declare function fetchGrokModels(session: GrokSession, fetchFn?: FetchFn, onWarn?: (message: string) => void, previous?: readonly DiscoveredModel[], signal?: AbortSignal): Promise<DiscoveredModel[]>;
/**
 * Build one xAI Responses request body (exported for tests, like
 * {@link codexRequestBody}). The tool trio renders only when tools exist:
 * A reported xAI 400 invalid-argument on tool-less calls motivated omitting
 * tool controls when no tools are supplied. Keep this endpoint-specific
 * compatibility measure separate from assumptions about other backends.
 */
export declare function grokRequestBody(options: GenerateOptions, resolved: ResponsesRequestInput): Record<string, unknown>;
/** Constructor dependencies for {@link GrokAdapter}. */
export interface GrokAdapterOptions {
    models: readonly ModelEntry[];
    streamIdleTimeoutMs: number;
    tokens: AccountTokenManager<GrokSession>;
    /** Late-bound pool facade (wired after adapter construction); pools list under their first member's provider. */
    pool?: () => PoolAdapter | undefined;
    /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
    discovery: boolean;
    /** Warning sink for discovery failures that fall back to the static catalog. */
    onWarn?: (message: string) => void;
    /** Fetch implementation for discovery (defaults to global fetch). */
    fetchFn?: FetchFn;
    /** Resolve the attachment service per request; absent means image requests fail loudly. */
    resolveAttachments?: () => AttachmentStore | undefined;
    /** Durable catalog store seeding capability metadata across restarts. */
    catalogStore?: CatalogPersistence;
    onCatalogChanged?: () => void;
    accountCatalogStore?: (account: string) => CatalogPersistence;
    /**
     * Per-model default reasoning effort override (the Settings page's picker).
     * Returns the user-configured default for one model, or undefined to follow
     * the provider's own default.
     */
    defaultEffortOf?: (model: string) => string | undefined;
    /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
    rateLimit?: RateLimitWait;
}
/** Grok wire adapter: one instance serves the `grok` provider route. */
export declare class GrokAdapter extends LlmAdapter {
    private readonly options;
    private readonly catalog;
    /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
    private readonly accountCatalogs;
    private accountCatalogsInvalidated;
    private readonly invalidatedAccounts;
    /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
    private catalogOwner;
    constructor(options: GrokAdapterOptions);
    /** Discovery fetcher: resolves the session through the refresh-aware path. */
    private fetchCatalog;
    /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
    clearAccountCatalog(account?: string): void;
    /** Default and secondary accounts each seed their own persisted catalog. */
    private catalogFor;
    private listed;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): import("@deepseek-ai/dsh-llm").ResolvedRetryPolicy;
    private staticModels;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** The provider's own catalog: union of every account, or one account when named. */
    listOwnModels(provider: string, account?: string, signal?: AbortSignal, preferCached?: boolean): Promise<readonly LlmModelInfo[]>;
    /**
     * The discovered entry for one model. Resolved through the cache's
     * stale-while-revalidate path: capability metadata must stay stable across
     * a long conversation — a session that selected a reasoning effort calls
     * this on EVERY step, and forgetting the efforts just because the TTL
     * lapsed mid-turn would fail the call with UNSUPPORTED_REASONING_EFFORT
     * before provider I/O.
     */
    private discovered;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    /** Capability resolution of the provider's own models (the pool resolves members here). */
    resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Pool seam: stream through one specific account instead of the default. */
    streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk>;
    private streamCore;
    private request;
}
export {};
