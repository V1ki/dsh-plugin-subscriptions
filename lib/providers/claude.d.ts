/**
 * Claude Pro/Max subscription provider: OAuth against claude.ai /
 * platform.claude.com with the Claude Code client id, and streaming against
 * the Anthropic Messages API with the Claude Code identity headers.
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { FlowSpec } from '../auth/oauth-flow.js';
import type { ClaudeSession } from '../auth/store.js';
import type { PoolAdapter } from './pool.js';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { TranslatableMessage } from '../translate/resolved.js';
import type { PromptCacheTtl } from '../translate/anthropic.js';
import { AccountTokenManager } from './accounts.js';
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ProviderUsage } from './common.js';
import type { CliVersion } from './npm-cli-version.js';
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js';
export declare const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export declare const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export declare const CLAUDE_TOKEN_URL = "https://claude.ai/v1/oauth/token";
export declare const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages?beta=true";
export declare const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export declare const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?beta=true";
export declare const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export declare const CLAUDE_CALLBACK_PATH = "/callback";
/** Refresh when the access token has less than this much life left. */
export declare const CLAUDE_PREEMPT_MS: number;
/**
 * Reads the reset instant of the Anthropic window that rejected a request.
 *
 * `anthropic-ratelimit-unified-*` is the subscription-plan family — the one
 * Claude Code renders as "resets 3pm" — and is the only header that names the
 * window which actually rejected this request. The per-bucket
 * `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset`
 * headers are deliberately not read: they are rollover snapshots attached to
 * every response, so on a 429 they cannot say which bucket refused, and the
 * earliest of them is typically the bucket that still had room — a wait that
 * lands straight back in the closed window. They reach the operator through
 * `rateLimitDiagnostics` instead.
 */
export declare const claudeRateLimitReset: RateLimitResetReader;
/**
 * The subscription endpoint only serves requests presenting as Claude Code,
 * so these headers impersonate the CLI; the harness attribution user-agent
 * cannot be sent here (one user-agent slot, and the CLI's wins). The endpoint
 * also gates new models on the CLI version, so the version normally comes
 * from npm (`ClaudeCliVersionCache`); this is only the offline floor.
 */
export declare const CLAUDE_CLI_FALLBACK_VERSION = "2.1.283";
export declare function detectClaudeVersion(): string;
/**
 * The lowest version to present: the local CLI or the bundled fallback,
 * whichever is newer. An outdated local install must not pin requests to a
 * version the endpoint already rejects for new models.
 * @param detect - local CLI probe (injectable for tests).
 */
export declare function claudeCliVersionFloor(detect?: () => string): CliVersion;
/** The User-Agent Claude Code sends at `version`. */
export declare function claudeCliUserAgent(version: string): string;
export declare const CLAUDE_BETA_FALLBACK: string;
/** Static claude flow facts for the OAuth flow engine. */
export declare const claudeFlow: FlowSpec;
/**
 * Exchange an authorization code for a claude session (JSON grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param state - the attempt's state (echoed to the token endpoint).
 * @returns the session to store.
 */
export declare function exchangeClaudeCode(code: string, verifier: string, redirectUri: string, state: string): Promise<ClaudeSession>;
/**
 * Refresh a claude session (JSON grant echoing the issued scope).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export declare function refreshClaude(session: ClaudeSession): Promise<ClaudeSession>;
/**
 * Whether a claude refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export declare function isClaudePermanentRefreshError(error: unknown): boolean;
export declare const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/**
 * Fetch the claude subscription usage from the OAuth usage endpoint (the
 * source of Claude Code's `/usage` screen). Newer responses carry a
 * structured `limits` array; older ones the flat `five_hour`/`seven_day*`
 * buckets — both shapes are read, the array winning when it has entries.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @param cliVersion - resolves the Claude Code version to present; defaults to the local floor.
 * @returns the mapped usage snapshot.
 */
export declare function fetchClaudeUsage(session: ClaudeSession, fetchFn?: FetchFn, signal?: AbortSignal, cliVersion?: () => Promise<string>): Promise<ProviderUsage>;
/**
 * Fetch the live model catalog from the subscription endpoint. `signal`
 * cancels the request; `cliVersion` resolves the Claude Code version to
 * present (defaults to the local floor).
 */
export declare function fetchClaudeModels(session: ClaudeSession, fetchFn?: FetchFn, signal?: AbortSignal, cliVersion?: () => Promise<string>): Promise<DiscoveredModel[]>;
/** Constructor dependencies for {@link ClaudeAdapter}. */
export interface ClaudeAdapterOptions {
    models: readonly ModelEntry[];
    streamIdleTimeoutMs: number;
    tokens: AccountTokenManager<ClaudeSession>;
    /** Late-bound pool facade (wired after adapter construction); pools list under their first member's provider. */
    pool?: () => PoolAdapter | undefined;
    /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
    discovery: boolean;
    fetchFn?: FetchFn;
    onWarn?: (message: string) => void;
    /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
    rateLimit?: RateLimitWait;
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
    /** Resolves the Claude Code version to present (npm-backed); absent means the local floor. */
    resolveCliVersion?: () => Promise<string>;
    /** Lifetime of the request's cache breakpoints; absent means Anthropic's five-minute default. */
    promptCacheTtl?: PromptCacheTtl;
    /**
     * The user's Settings-page choice, read per request so a save applies to
     * the next turn without a restart; undefined falls back to `promptCacheTtl`.
     */
    promptCacheTtlOverride?: () => PromptCacheTtl | undefined;
}
/**
 * Inline image data a Claude request may carry, in base64 bytes. Every turn
 * resends the history, so screenshots accumulate until the request passes the
 * API's 32MB body limit and every later turn and compaction fails with HTTP
 * 413 `request_too_large`. Past this budget the host offloads the oldest
 * images to text and retries; the remaining 12MB holds prompts, tools, and text.
 */
export declare const CLAUDE_REQUEST_IMAGE_BUDGET: number;
/**
 * Assemble the Anthropic request body.
 *
 * Extracted from the adapter so the wire shape — cache breakpoints above all —
 * is testable without a network round trip. The message array is marked before
 * it is placed so the breakpoints land on the blocks the body ships: one on the
 * last `system` block (covering `tools` + `system`, which render ahead of it)
 * and up to three across the history, Anthropic's four-slot maximum.
 * @param options - the generate request.
 * @param messages - conversation messages with images already resolved.
 * @param maxTokens - the resolved output cap.
 * @param thinking - the thinking parameter, when the model takes one.
 * @param effort - the reasoning effort, when the model advertises efforts.
 * @param cacheTtl - lifetime of every cache breakpoint; defaults to five minutes.
 * Requests that carry a `purpose` (compaction, session titles) always use five
 * minutes to preserve their existing auxiliary-request behavior. A five-minute
 * mark can still read an entry a one-hour mark wrote.
 * @returns the JSON body to POST.
 */
export declare function claudeRequestBody(options: GenerateOptions, messages: readonly TranslatableMessage[], maxTokens: number, thinking?: Record<string, unknown>, effort?: string, cacheTtl?: PromptCacheTtl): Record<string, unknown>;
/** Claude wire adapter: one instance serves the `claude` provider route. */
export declare class ClaudeAdapter extends LlmAdapter {
    private readonly options;
    private readonly catalog;
    /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
    private readonly accountCatalogs;
    private accountCatalogsInvalidated;
    private readonly invalidatedAccounts;
    /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
    private catalogOwner;
    constructor(options: ClaudeAdapterOptions);
    private fetchCatalog;
    /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
    clearAccountCatalog(account?: string): void;
    /** Default and secondary accounts each seed their own persisted catalog. */
    private catalogFor;
    private discovered;
    private staticModels;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): import("@deepseek-ai/dsh-llm").ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** The provider's own catalog: union of every account, or one account when named. */
    listOwnModels(provider: string, account?: string, signal?: AbortSignal, preferCached?: boolean): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    /** Capability resolution of the provider's own models (the pool resolves members here). */
    resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Pool seam: stream through one specific account instead of the default. */
    streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk>;
    private streamCore;
    /**
     * `display: 'summarized'` is set explicitly on both shapes: `adaptive`-type
     * models default to `display: 'omitted'`, which returns thinking blocks with
     * an empty `thinking` field — without this override the "Think" panel would
     * always render empty even though real reasoning (and billed thinking_tokens)
     * ran.
     */
    private thinkingParam;
    private request;
}
