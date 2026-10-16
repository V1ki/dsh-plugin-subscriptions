/**
 * Plumbing shared by the subscription adapters: HTTP error mapping, a
 * stream idle watchdog, fetch failure classification, OAuth endpoint errors,
 * and the per-provider {@link TokenManager} that owns session freshness.
 * Concurrent refreshes for one provider coalesce behind a single in-flight
 * promise (`inflight`), so a rotating refresh token is never spent twice.
 */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { RateLimitResetReader } from './rate-limit.js';
/** One configured model catalog entry. */
export interface ModelEntry {
    /** Wire model id; must be non-empty. */
    id: string;
    /** Selector label; defaults to the id. */
    name?: string;
    /** Known combined request/response context capacity. */
    contextWindow?: number;
    /** Per-request output cap for this model. */
    maxTokens?: number;
    /** Accepted request modalities; when set, wins over the provider default. */
    inputModalities?: ('text' | 'image')[];
    /**
     * Force this model's upstream protocol. Only the copilot adapter consumes
     * the semantics; the union is inlined here to avoid a circular import of
     * the copilot module's `CopilotWire`.
     */
    wire?: 'chat-completions' | 'responses';
}
/**
 * Validate a configured model catalog (mirrors llm-deepseek's resolveModels).
 * @param models - raw configured entries.
 * @param label - diagnostic prefix naming the provider.
 * @returns the validated entries.
 */
export declare function validateModels(models: readonly ModelEntry[], label: string): ModelEntry[];
/** Optional per-call hooks {@link httpLlmError} uses to read a rate-limit window. */
export interface HttpLlmErrorOptions {
    /**
     * The calling provider's reader for the instant its rate-limit window
     * reopens. Consulted on a 429 only, and there ahead of the generic
     * `retry-after` header, because a provider's own field names the window while
     * `retry-after` often names a short backoff.
     */
    rateLimitReset?: RateLimitResetReader;
    /** Diagnostic sink for a 429 that disclosed no reset instant this code recognizes. */
    onWarn?: (message: string) => void;
}
/**
 * Build an LlmError from a non-2xx provider response, mapping the status to a
 * stable code and, for a rate-limited request, the disclosed reset instant to
 * the `providerRetryAfterMs` the retry plugin waits out.
 *
 * A 429 classifies as `RATE_LIMIT` on the strength of the status alone, ahead
 * of the quota-wording check. On these routes there is no terminal quota to
 * distinguish: a subscription has no balance to top up, only a window that
 * reopens, and providers announce an exhausted window with wording
 * (`usage_limit_reached`) the shared classifier reads as permanent.
 * @param response - the failed response.
 * @param label - diagnostic prefix naming the provider API.
 * @param options - the calling provider's rate-limit reader and warning sink.
 * @returns the classified error.
 */
export declare function httpLlmError(response: Response, label: string, options?: HttpLlmErrorOptions): Promise<LlmError>;
/** An idle watchdog: aborts its signal when no SSE activity arrives within the timeout. */
export interface IdleWatchdog {
    /** Signal to pass to fetch and body reads; aborts on caller cancel or idle expiry. */
    readonly signal: AbortSignal;
    /** Reset the idle timer (call on every received SSE event). */
    pulse(): void;
    /** Stop the timer and detach from the caller signal. */
    stop(): void;
    /** Whether the last abort came from idle expiry rather than caller cancellation. */
    timedOut(): boolean;
}
/**
 * Create an idle watchdog chained to the caller's signal.
 * @param caller - the request's own abort signal, when present.
 * @param timeoutMs - maximum idle interval while a stream read is outstanding.
 * @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
 */
export declare function idleWatchdog(caller: AbortSignal | undefined, timeoutMs: number): IdleWatchdog;
/**
 * Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
 * expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
 * TRANSPORT with the cause chained.
 * @param label - diagnostic prefix naming the provider API.
 * @param error - the thrown value.
 * @param watchdog - the request's idle watchdog.
 * @param caller - the request's own abort signal, when present.
 * @returns the classified error.
 */
export declare function mapFetchFailure(label: string, error: unknown, watchdog: IdleWatchdog, caller: AbortSignal | undefined): LlmError;
/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
export declare class OAuthEndpointError extends Error {
    /** HTTP status of the token endpoint response. */
    readonly status: number;
    /** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
    readonly oauthCode: string | undefined;
    /**
     * The endpoint's `retry-after`, in ms, when it sent one. Usage/models
     * endpoints reuse this error type and can rate-limit progressively (each
     * hit within the window extends the next one), so a caller retrying on a
     * fixed schedule instead of honoring this can keep an account locked out
     * indefinitely.
     */
    readonly retryAfterMs: number | undefined;
    constructor(message: string, status: number, oauthCode?: string, retryAfterMs?: number);
}
/**
 * Read an OAuth JSON error body into an {@link OAuthEndpointError}. Two body
 * shapes are understood: RFC 6749 (`{ error: "invalid_grant", error_description }`)
 * and the OpenAI API envelope the auth.openai.com token endpoint now answers
 * with (`{ error: { code: "refresh_token_reused", message } }`). The code
 * must land in `oauthCode` either way — the permanent-failure classifiers
 * key on it, and an unrecognized shape would keep a dead login forever.
 * @param response - the failed token-endpoint response.
 * @param label - diagnostic prefix naming the provider.
 * @returns the error to throw.
 */
export declare function oauthEndpointError(response: Response, label: string): Promise<OAuthEndpointError>;
/** A session fresh enough to serve a request without a refresh. */
interface TimedSession {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}
/** Provider hooks the token manager needs. */
export interface TokenManagerOptions<S extends TimedSession> {
    /** Human-readable provider name for error messages. */
    displayName: string;
    /** Refresh this long before `expiresAt`. */
    preemptMs: number;
    load(): Promise<S | undefined>;
    save(session: S): Promise<void>;
    remove(): Promise<void>;
    /** Perform the provider's refresh-token grant. */
    refresh(session: S): Promise<S>;
    /** Whether a refresh failure is permanent (re-login required). */
    isPermanent(error: unknown): boolean;
    /** Called after a permanent refresh failure deleted the stored session. */
    onRemoved?(): void;
}
/**
 * Per-provider session freshness: loads the stored session, refreshes
 * proactively inside the preempt window or on demand after a 401, and
 * coalesces concurrent refreshes behind one in-flight promise. Permanent
 * refresh failures delete the stored session and surface INVALID_CREDENTIAL
 * with a re-login hint; transient failures fall back to a still-valid token.
 */
export declare class TokenManager<S extends TimedSession> {
    private readonly options;
    private inflight;
    /** The session whose refresh token the in-flight refresh is spending. */
    private attempted;
    constructor(options: TokenManagerOptions<S>);
    /**
     * Read the stored session without any refresh side effect. Catalog queries
     * (`listModels`) use this to decide whether the provider is logged in.
     * @returns the stored session, or `undefined` when logged out.
     */
    peek(): Promise<S | undefined>;
    /**
     * Whether a session is currently stored (cheap; never refreshes).
     * @returns true when logged in.
     */
    hasSession(): Promise<boolean>;
    /**
     * Resolve a usable session, refreshing proactively or on demand.
     * @param forceRefresh - refresh regardless of expiry (used after a 401).
     * @returns the persisted session to send.
     * @throws LlmError MISSING_CREDENTIAL when logged out, INVALID_CREDENTIAL
     *   when the refresh grant is permanently rejected.
     */
    session(forceRefresh?: boolean): Promise<S>;
    private doRefresh;
}
/** Fetch signature adapters accept for discovery calls (injectable for tests). */
export type FetchFn = typeof fetch;
/** Bound on one account catalog fetch or usage poll — a hang must not block the picker. */
export declare const DISCOVERY_TIMEOUT_MS = 10000;
/** Cancel one caller's wait without cancelling catalog work shared with other callers. */
export declare function withAbortSignal<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
/**
 * Run `work` with an aborting signal. Resolves undefined when the timeout
 * fires (the fetch is aborted); other failures propagate.
 */
export declare function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T | undefined>;
/** One rate-limit window reported by a provider's usage endpoint. */
export interface UsageWindow {
    /** Window kind: `session` for the short rolling window, `weekly` for the 7-day one. */
    kind: 'session' | 'weekly' | 'other';
    /** Model scope for model-specific windows (e.g. `Opus`), when the provider names one. */
    scope?: string;
    /** Percent of the window already consumed (0–100). */
    usedPercent: number;
    /** Epoch milliseconds at which the window resets, when the provider discloses it. */
    resetsAt?: number;
}
/** One banked Codex reset credit, returned by the private ChatGPT backend API. */
export interface ResetCredit {
    id?: string;
    grantedAt?: number;
    expiresAt?: number;
}
/** Subscription usage of one provider, as served by the `usage` RPC endpoint. */
export interface ProviderUsage {
    /** False when the provider has no usage endpoint (grok); windows are absent then. */
    supported: boolean;
    /** Usage windows in display order. */
    windows?: UsageWindow[];
    /** Plan name the usage endpoint reported, when present. */
    plan?: string;
    /** Available banked Codex full resets, when the backend discloses them. */
    resetCredits?: ResetCredit[];
    /** Optional reset lookup failure; ordinary usage remains usable. */
    resetCreditsError?: string;
}
/** One model discovered from a provider's live model-list endpoint. */
export interface DiscoveredModel {
    /** Account-specific server-advertised ceiling for local context overrides. */
    maxContextWindow?: number;
    /** Wire model id. */
    id: string;
    /** Human-readable display name. */
    name: string;
    description?: string;
    /** Advertised combined context capacity in tokens. */
    contextWindow?: number;
    /** Server-advertised per-request output token ceiling, when disclosed. */
    maxOutputTokens?: number;
    /** Provider sort hint; lower sorts earlier. */
    priority?: number;
    /** Advertised reasoning efforts, when the provider discloses them. */
    reasoning?: {
        efforts: {
            id: ReasoningEffortId;
            name: string;
            description?: string;
        }[];
        defaultEffort?: ReasoningEffortId;
    };
    /** Accepted request modalities the endpoint advertised (e.g. Copilot's vision support flag). */
    inputModalities?: ('text' | 'image')[];
    /** Claude-specific: which extended-thinking wire shape this model accepts. */
    thinkingType?: 'enabled' | 'adaptive';
    /** Codex-specific: the catalog advertises a fast (priority) service tier. */
    fastTier?: boolean;
    /** Copilot-specific: which upstream protocol the model's endpoints speak. */
    copilotWire?: 'chat-completions' | 'responses';
    /**
     * Copilot-specific: the catalog also lists `/responses` for this model
     * (dual-protocol entries, e.g. gpt-5.4), so a chat-wire request may reroute
     * there when it combines function tools with a reasoning effort.
     */
    copilotResponses?: boolean;
}
/** Display name for a wire reasoning-effort identifier. */
export declare function effortDisplayName(effort: string): string;
/** The reasoning-block shape every caller passes to {@link mergeReasoning}. */
export interface ReasoningBlock {
    efforts: readonly {
        id: ReasoningEffortId;
        name: string;
        description?: string;
    }[];
    defaultEffort?: ReasoningEffortId;
}
/**
 * Fold a configured per-model default effort into a reasoning block, keeping
 * the DSH runtime invariant `defaultEffort ∈ efforts` (the runtime rejects an
 * unknown default with `INVALID_MODEL_REASONING`).
 *
 * A configured level the base set does not advertise is *dropped*, not
 * appended: for claude/grok/copilot the base is the provider's live catalog,
 * i.e. the truth about what the model accepts, so honouring a stale override
 * would put an unsupported effort on every single request instead of letting
 * the harness reject it before provider I/O. The override then simply falls
 * back to the provider's own default until the user picks a level the catalog
 * still lists.
 *
 * `extendable` opts into the opposite rule for a base that is a *built-in
 * fallback* rather than discovered truth (codex, whose static effort list is
 * known to trail the backend): there, appending the configured level is how a
 * newly shipped tier becomes selectable at all.
 * @param configuredDefault - the user-configured default effort id, or undefined.
 * @param base - the discovered/built-in reasoning block, or undefined.
 * @param options - `extendable` marks the base as a fallback that may be extended.
 * @returns the merged block, or undefined when neither side contributes one.
 */
export declare function mergeReasoning(configuredDefault: string | undefined, base: ReasoningBlock | undefined, options?: {
    extendable?: boolean;
}): DiscoveredModel['reasoning'] | undefined;
/**
 * First account catalog that lists `model` (callers pass default-first).
 * One failing lookup sits that account out so a sibling's metadata still
 * resolves — the same isolation as the picker catalog union.
 */
export declare function discoverAcrossAccounts(accounts: readonly string[], lookup: (account: string) => Promise<DiscoveredModel | undefined>): Promise<DiscoveredModel | undefined>;
/** Skip scheduled refreshes when the last successful catalog is this recent. */
export declare const DISCOVERY_TTL_MS: number;
/** A durable snapshot of one provider's discovered catalog. */
export interface CatalogSnapshot {
    /** Epoch milliseconds of the successful fetch that produced it. */
    at: number;
    models: DiscoveredModel[];
}
/** The durable half of a {@link ModelCatalogCache} (the models.json store). */
export interface CatalogPersistence {
    /** The last persisted snapshot, or undefined when absent or unusable. */
    load(): Promise<CatalogSnapshot | undefined>;
    /** Persist a fresh snapshot (write-through after every successful fetch). */
    save(snapshot: CatalogSnapshot): Promise<void>;
    /** Drop the persisted snapshot (a 401 proved the credential changed). */
    clear(): Promise<void>;
}
/**
 * Cache for one provider's discovered model catalog. The TTL only decides
 * when to REFRESH; it never makes the cache forget: capability metadata
 * (reasoning efforts) must stay stable for a session that selected an effort,
 * or mid-conversation calls fail UNSUPPORTED_REASONING_EFFORT the moment the
 * cache goes stale. `get` awaits freshness unless its caller opts into
 * cache-only picker/routing reads. The startup/hourly job owns automatic
 * refreshes; `resolveModel` uses {@link resolve}, which serves the last-known
 * catalog and only awaits the fetch when nothing is known yet. An optional {@link CatalogPersistence} seeds the
 * last-known state across restarts and receives every successful fetch. A 401
 * that still fails after a forced token refresh must call {@link invalidate}.
 */
export declare class ModelCatalogCache {
    private readonly persistence?;
    private readonly ttlMs;
    private readonly onChanged?;
    private entry;
    private inflight;
    /** Settles once the persisted snapshot (when any) has been considered. */
    private seeded;
    /** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
    private seedDisabled;
    /** Bumped by {@link invalidate} so a loser in-flight fetch cannot write back. */
    private generation;
    constructor(persistence?: CatalogPersistence | undefined, ttlMs?: number, onChanged?: (() => void) | undefined);
    /**
     * The cached catalog when fresh, without fetching.
     * @returns the cached models, or `undefined` when absent or stale.
     */
    cached(): readonly DiscoveredModel[] | undefined;
    /**
     * The last successfully fetched catalog, ignoring TTL. Used to carry
     * capability metadata forward when a later fetch cannot re-enrich.
     * @returns the last-known models, or `undefined` when nothing has been stored.
     */
    lastKnown(): readonly DiscoveredModel[] | undefined;
    /** Load the persisted snapshot once; a fetch or invalidate that landed first wins. */
    private ensureSeeded;
    /** Run (or join) the single in-flight fetch, updating memory and disk on success. */
    private refresh;
    /**
     * Return the cached catalog when fresh, otherwise fetch and cache it.
     * @param fetcher - performs the provider's model-list request.
     * @param preferCached - serve saved metadata; the startup/hourly job owns automatic refreshes.
     * @returns the discovered models.
     * @throws the fetcher's failure (the `listModels` caller warns and falls back).
     */
    get(fetcher: () => Promise<DiscoveredModel[]>, preferCached?: boolean): Promise<readonly DiscoveredModel[]>;
    /**
     * The models for capability resolution. A fresh cache answers directly; a
     * stale one answers immediately from the last-known catalog. Only the
     * startup/hourly job refreshes known metadata automatically; a cold cache
     * awaits one fetch.
     * @param fetcher - performs the provider's model-list request.
     * @returns the models, or `undefined` when nothing is known (the caller
     *   falls back to its static metadata). Never throws.
     */
    resolve(fetcher: () => Promise<DiscoveredModel[]>): Promise<readonly DiscoveredModel[] | undefined>;
    /** Drop the cached catalog (e.g. after a 401 proved the credential changed). */
    invalidate(): void;
}
/** Whether discovery failed because the stored login is gone. */
export declare function isMissingOrInvalidCredential(error: unknown): boolean;
/** Whether discovery stopped because the caller cancelled or the timeout fired. */
export declare function isDiscoveryAborted(error: unknown, signal?: AbortSignal): boolean;
/**
 * Whether discovery failed because the access token was rejected. After
 * {@link discoverOrRetryAuth} this means the token was rejected AGAIN right
 * after a forced refresh: the login is dead server-side (revoked) even though
 * the refresh grant still answers, so the store keeps the session.
 */
export declare function isDiscoveryAuthFailure(error: unknown): boolean;
/**
 * Run a catalog fetch, retrying once after a forced token refresh when the
 * first attempt is a 401/AUTH. Only {@link ModelCatalogCache.invalidate}s
 * when the retry is also an auth failure, so a refresh race cannot erase
 * last-known capability metadata.
 */
export declare function discoverOrRetryAuth<T>(session: (forceRefresh?: boolean) => Promise<unknown>, catalog: ModelCatalogCache, run: () => Promise<T>): Promise<T>;
/**
 * Keep Codex's session header stable for a supplied, non-empty session ID.
 * Existing UUIDs are preserved; other IDs use a SHA-256-derived UUIDv8 (a
 * custom deterministic layout). UUID formatting is a client convention,
 * not a claim about gateway validation or guaranteed prompt-cache hits.
 * Missing and empty IDs have no session identity and receive a fresh UUIDv4.
 */
export declare function deterministicSessionId(sessionId?: string): string;
export {};
