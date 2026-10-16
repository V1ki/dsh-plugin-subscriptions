/**
 * ChatGPT/Codex subscription provider: OAuth against auth.openai.com with the
 * Codex CLI client id, and streaming against the ChatGPT backend Responses
 * endpoint.
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CompatibleMessage as Message } from '../compat.js';
import type { FlowSpec } from '../auth/oauth-flow.js';
import type { CodexSession } from '../auth/store.js';
import type { PoolAdapter } from './pool.js';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { ResponsesRequestInput } from '../translate/responses.js';
import { AccountTokenManager } from './accounts.js';
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ProviderUsage } from './common.js';
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js';
export declare const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export declare const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export declare const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export declare const CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses";
/** Refresh when the access token has less than this much life left. */
export declare const CODEX_PREEMPT_MS: number;
/**
 * Reads the reset instant of the Codex window that rejected a request.
 *
 * Body only. The `x-codex-{primary,secondary}-reset-after-seconds` headers are
 * rollover snapshots the backend attaches to every response, one per window,
 * so they say nothing about which window refused: a burst 429 that would clear
 * in seconds still carries a primary rollover hours out, and reading it would
 * park the turn for those hours. They reach the operator through
 * `rateLimitDiagnostics` instead.
 */
export declare const codexRateLimitReset: RateLimitResetReader;
/**
 * Fast tier (the codex CLI's "fast mode"): the Responses `service_tier` wire
 * value for priority processing, mirroring codex-rs
 * `ServiceTier::Fast.request_value()`. The legacy catalog spelling is the
 * `additional_speed_tiers` entry "fast".
 */
export declare const CODEX_FAST_SERVICE_TIER = "priority";
/** One session's speed choice: standard routing or the fast (priority) tier. */
export type CodexSpeedTier = 'standard' | 'fast';
/** Static codex flow facts for the OAuth flow engine. */
export declare const codexFlow: FlowSpec;
/** User identity claims decoded from a codex id token. */
export interface CodexProfileClaims {
    emailAddress?: string;
    planType?: string;
}
/**
 * Decode the user-identity claims of a codex id token (pure, cheap — no
 * verification, same trust posture as {@link accountIdOf}). Claim paths
 * mirror codex-rs `login/src/token_data.rs`: the email is the top-level
 * `email` claim, falling back to `https://api.openai.com/profile`.email; the
 * plan is `https://api.openai.com/auth`.chatgpt_plan_type.
 * @param idToken - a stored or freshly issued id token, when present.
 * @returns whichever claims the token carried; empty when undecodable.
 */
export declare function codexProfileClaims(idToken: string | undefined): CodexProfileClaims;
/**
 * Exchange an authorization code for a codex session (form-encoded grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @returns the session to store.
 */
export declare function exchangeCodexCode(code: string, verifier: string, redirectUri: string): Promise<CodexSession>;
/**
 * Refresh a codex session (JSON grant — unlike the code exchange).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export declare function refreshCodex(session: CodexSession): Promise<CodexSession>;
/**
 * Whether a codex refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export declare function isCodexPermanentRefreshError(error: unknown): boolean;
export declare const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export declare const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
/** Read available banked resets. This endpoint is private and intentionally read-only. */
export declare function fetchCodexResetCredits(session: CodexSession, fetchFn?: FetchFn, signal?: AbortSignal): Promise<NonNullable<ProviderUsage['resetCredits']>>;
/** Spend one banked reset. The caller must already have confirmed the credit is still available. */
export declare function consumeCodexResetCredit(session: CodexSession, creditId: string, requestId: string, fetchFn?: FetchFn, signal?: AbortSignal): Promise<void>;
/**
 * Fetch the codex subscription usage from the ChatGPT backend wham/usage
 * endpoint (the source of the codex CLI `/status` rate-limit lines). The
 * windows are classified by their reported duration (`limit_window_seconds`)
 * rather than by slot, since the backend has been observed to report the
 * weekly lane as `primary_window` without a secondary window; slot order is
 * kept only as a fallback when the duration is absent. The lookup itself
 * consumes no rate-limit budget.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export declare function fetchCodexUsage(session: CodexSession, fetchFn?: FetchFn, signal?: AbortSignal): Promise<ProviderUsage>;
export declare const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
/**
 * Client version sent on the /models catalog request. The backend gates the
 * visible model list by client version. Verified 2026-09-05: the same account
 * omitted GPT-6 Astra at 0.147.0 and listed it at stable CLI 0.153.4. This is
 * not an entitlement guarantee; the server remains authoritative.
 */
export declare const CODEX_CLIENT_VERSION = "0.153.4";
/** Validate an explicit catalog compatibility version before using it on the wire. */
export declare function codexClientVersion(value?: string): string;
/**
 * Fetch the live codex model catalog with the session's auth headers.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation (pool-assembly timeout).
 * @param clientVersion - catalog compatibility version, not the plugin version.
 * @returns discovered models: hidden entries dropped, sorted by priority.
 */
export declare function fetchCodexModels(session: CodexSession, fetchFn?: FetchFn, signal?: AbortSignal, clientVersion?: string): Promise<DiscoveredModel[]>;
/** Constructor dependencies for {@link CodexAdapter}. */
export interface CodexAdapterOptions {
    /** Catalog compatibility version; defaults to the verified stable CLI version. */
    clientVersion?: string;
    /** Automatic lookup used only when no explicit compatibility version is set. */
    resolveClientVersion?: () => Promise<string>;
    models: readonly ModelEntry[];
    streamIdleTimeoutMs: number;
    tokens: AccountTokenManager<CodexSession>;
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
    /** Durable store for one NON-default account's catalog (the default's lives in `catalogStore`). */
    accountCatalogStore?: (account: string) => CatalogPersistence;
    /** Per-account catalog bound for the picker union (defaults to {@link DISCOVERY_TIMEOUT_MS}). */
    discoveryTimeoutMs?: number;
    /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
    rateLimit?: RateLimitWait;
    /**
     * Per-model default reasoning effort override (the Settings page's picker).
     * Returns the user-configured default for one model, or undefined to follow
     * the provider's own default.
     */
    defaultEffortOf?: (model: string) => string | undefined;
    contextWindowOf?: (model: string) => number | undefined;
    /**
     * Per-request speed lookup (the composer Speed toggle's host half). Returns
     * whether this session's current choice sends the model on the fast tier;
     * absent means every request stays on standard routing.
     */
    speedFor?: (sessionId: string | undefined, model: string) => Promise<boolean> | boolean;
}
/** Text marking a repaired tool output as an unknown outcome; the model must verify before retrying. */
export declare const CODEX_UNKNOWN_TOOL_OUTCOME = "The tool call has no recorded result. Its outcome is unknown; verify external state before retrying any operation that may have side effects.";
/**
 * Reconcile one Responses input's tool-call pairing after id normalization:
 * every `function_call` gets an output and every `function_call_output`
 * matches a call. Missing outputs become error-style outputs whose text marks
 * the outcome unknown; orphan outputs are dropped. Duplicate calls of one id
 * receive exactly one repair output. The request is local repair only: the
 * durable history stays authoritative and unchanged.
 * @param input - normalized Responses input items.
 * @returns the same array when already balanced, otherwise a repaired array.
 */
export declare function reconcileResponsesToolCalls(input: ResponsesRequestInput['input']): ResponsesRequestInput['input'];
/**
 * The `reasoning.effort` wire value for a selected effort. Codex's "ultra" is
 * a client-side selection (max reasoning plus proactive sub-agent delegation)
 * that the Codex CLI itself lowers to `max` at the Responses API boundary;
 * the backend answers HTTP 400 to a literal `ultra`. Discovery no longer
 * lists it, but an effort saved before that change may still arrive here.
 */
export declare function codexWireEffort(effort: string): string;
/**
 * The Responses request body for one generation. A fast-tier request (the
 * composer Speed toggle, the codex CLI's fast mode) carries
 * `service_tier: priority`; the tier field is omitted entirely otherwise,
 * matching the CLI (it never sends an explicit standard tier).
 */
export declare function codexRequestBody(options: GenerateOptions, resolved: ResponsesRequestInput, fast: boolean): Record<string, unknown>;
/** Adapt the current harness's first-class tool messages at the Codex boundary. */
export declare function projectCodexMessages(messages: readonly Message[]): Message[];
/** Codex wire adapter: one instance serves the `codex` provider route. */
export declare class CodexAdapter extends LlmAdapter {
    private readonly options;
    private readonly catalog;
    /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
    private readonly accountCatalogs;
    private accountCatalogsInvalidated;
    private readonly invalidatedAccounts;
    /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
    private catalogOwner;
    constructor(options: CodexAdapterOptions);
    /** Discovery fetcher: resolves the session through the refresh-aware path. */
    private fetchCatalog;
    /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
    clearAccountCatalog(account?: string): void;
    /** Default and secondary accounts each seed their own persisted catalog. */
    private catalogFor;
    /** Picker rows for discovered entries (the wire id doubles as the route id). */
    private listed;
    /**
     * The last catalog one account successfully listed, without any network.
     * Routing asks for this when live discovery times out: an account that
     * listed a model minutes ago is still a better answer than "no models".
     */
    lastKnownOwnModels(provider: string, account: string): Promise<readonly LlmModelInfo[] | undefined>;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): import("@deepseek-ai/dsh-llm").ResolvedRetryPolicy;
    private staticModels;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** The provider's own catalog: union of every account, or one account when named. */
    listOwnModels(provider: string, account?: string, signal?: AbortSignal, preferCached?: boolean): Promise<readonly LlmModelInfo[]>;
    /**
     * The discovered entry for one model. Resolved through the cache's
     * stale-while-revalidate path so capability metadata stays stable across a
     * long conversation: a discovered-only effort (one missing from the static
     * CODEX_EFFORTS list) selected by the user must not vanish — and fail the
     * call — just because the TTL lapsed mid-turn.
     */
    private discovered;
    /** Whether the discovered catalog advertises a fast tier for this model. */
    supportsFastTier(model: string, account?: string): Promise<boolean>;
    /** Ids of every discovered model with a fast tier (the Speed toggle's visibility list). */
    fastCapableModels(): Promise<string[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    /** Capability resolution of the provider's own models (the pool resolves members here). */
    resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo>;
    /** Account-specific bounds; absent maximum conservatively keeps the advertised default. */
    contextLimits(model: string, account?: string): Promise<{
        default: number;
        max: number;
    }>;
    private contextWindowFor;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Pool seam: stream through one specific account instead of the default. */
    streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk>;
    private streamCore;
    private request;
}
