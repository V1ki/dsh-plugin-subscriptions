/**
 * GitHub Copilot subscription provider: OAuth device-authorization flow with
 * the VS Code Copilot Chat client id, a GitHub-token → Copilot-token exchange
 * against `copilot_internal/v2/token`, and streaming against two upstream
 * protocols chosen per model: the OpenAI-compatible chat completions endpoint
 * for models whose catalog entry lists `/chat/completions`, and the Responses
 * endpoint for the newer model families (gpt-5.5/5.6, …) that only list
 * `/responses`. Both upstreams are stream-only.
 *
 * Two token generations are in play: the long-lived GitHub OAuth token (kept
 * as the session's `refreshToken`) and the ~30-minute Copilot API token it
 * exchanges into (the session's `accessToken`). A TokenManager "refresh" is a
 * fresh exchange, so the standard preempt/401-retry machinery applies
 * unchanged.
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { DeviceFlowSpec } from '../auth/device-flow.js';
import type { CopilotSession } from '../auth/store.js';
import type { PoolAdapter } from './pool.js';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { ReasoningReplayItem, ResponsesRequestInput, ResponsesStreamEvent } from '../translate/responses.js';
import { AccountTokenManager } from './accounts.js';
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry } from './common.js';
import type { RateLimitWait } from './rate-limit.js';
/**
 * Client id of the VS Code Copilot Chat GitHub App (pi-mono and
 * copilot2api-go use the same value): the app is pre-authorized for the
 * Copilot internal token exchange, a self-registered OAuth App is not.
 */
export declare const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export declare const COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
export declare const COPILOT_DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
export declare const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export declare const GITHUB_USER_URL = "https://api.github.com/user";
export declare const COPILOT_API_URL = "https://api.githubcopilot.com/chat/completions";
/** Responses endpoint for models whose catalog entry only lists `/responses`. */
export declare const COPILOT_RESPONSES_URL = "https://api.githubcopilot.com/responses";
export declare const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";
/** Refresh when the Copilot API token has less than this much life left. */
export declare const COPILOT_PREEMPT_MS: number;
/**
 * The VS Code update feed answers a JSON array of version strings, latest
 * stable first. The Copilot API rejects requests whose Editor-Version is too
 * old with `401 IDE token expired`, so the version is resolved live (cached
 * for a day) instead of hardcoded — a stale hardcode bricks every request.
 */
export declare const VSCODE_RELEASES_URL = "https://update.code.visualstudio.com/api/releases/stable";
/** Last-known-good VS Code version when the feed is unreachable. */
export declare const FALLBACK_VSCODE_VERSION = "1.107.0";
/**
 * Resolve the VS Code version presented as Editor-Version: the latest stable
 * from the update feed, cached for a day, falling back to a pinned version
 * when the feed fails. Concurrent resolves coalesce behind one fetch.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param forceRefresh - bypass the cache (a 401 `IDE token expired` retry).
 * @returns a `major.minor.patch` version string.
 */
export declare function latestVsCodeVersion(fetchFn?: FetchFn, forceRefresh?: boolean): Promise<string>;
/**
 * The device-flow facts for the auth controller's DeviceFlowManager.
 * @returns the flow spec for one attempt.
 */
export declare function copilotDeviceFlow(): DeviceFlowSpec;
/**
 * Header set presenting requests as the VS Code Copilot Chat extension; the
 * Copilot API rejects traffic without an editor identity.
 * @param hasVision - whether the request carries image input.
 * @param vscodeVersion - Editor-Version value from {@link latestVsCodeVersion}.
 * @returns headers to merge into Copilot API requests.
 */
export declare function copilotHeaders(hasVision?: boolean, vscodeVersion?: string): Record<string, string>;
/** The freshly exchanged Copilot API token half of a session. */
interface CopilotTokenPair {
    accessToken: string;
    expiresAt: number;
}
/**
 * Exchange a long-lived GitHub OAuth token for a short-lived Copilot API
 * token. A 401/403 means the GitHub token is revoked or the account lost its
 * Copilot subscription — permanent, re-login required.
 * @param githubToken - the GitHub OAuth token from the device flow.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the Copilot API token and its expiry.
 */
export declare function exchangeCopilotToken(githubToken: string, fetchFn?: FetchFn): Promise<CopilotTokenPair>;
/**
 * Complete a device-flow login: exchange the GitHub token for a Copilot API
 * token and read the GitHub login name for the status display.
 * @param githubToken - the GitHub OAuth token the device flow released.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the session to store.
 */
export declare function completeCopilotLogin(githubToken: string, fetchFn?: FetchFn): Promise<CopilotSession>;
/**
 * Refresh a copilot session: re-exchange the long-lived GitHub token for a
 * fresh Copilot API token.
 * @param session - the stored session.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the fresh session to store.
 */
export declare function refreshCopilot(session: CopilotSession, fetchFn?: FetchFn): Promise<CopilotSession>;
/**
 * Whether a copilot refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix (GitHub token revoked or the subscription lost).
 */
export declare function isCopilotPermanentRefreshError(error: unknown): boolean;
/**
 * Fetch the live Copilot model list. Models hidden from the picker or
 * disabled by policy are excluded, as are models able to speak neither
 * protocol this adapter knows: an entry listing `/chat/completions` speaks
 * the chat wire, one listing only `/responses` (the newer GPT families,
 * e.g. gpt-5.6) speaks the Responses wire, and the choice is recorded on the
 * discovered entry so requests pick the matching endpoint; an entry listing
 * BOTH endpoints additionally records `/responses` availability, which
 * {@link copilotRequestWire} uses to reroute tools+effort requests. Vision
 * support from the catalog becomes the model's input modalities, and a
 * non-empty `supports.reasoning_effort` array becomes the model's selectable
 * reasoning efforts (the endpoint discloses no default, so none is claimed).
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns discovered chat models in endpoint order.
 */
export declare function fetchCopilotModels(session: CopilotSession, fetchFn?: FetchFn, signal?: AbortSignal): Promise<DiscoveredModel[]>;
/** Which upstream protocol one Copilot model speaks. */
export type CopilotWire = 'chat-completions' | 'responses';
/**
 * The wire protocol for one model: the discovered catalog entry's recorded
 * choice, defaulting to chat completions for unknown models (static-catalog
 * and no-discovery configurations, and models listing both endpoints).
 * @param entry - the discovered catalog entry, when known.
 * @returns the protocol the request for this model must speak.
 */
export declare function copilotWireFor(entry: DiscoveredModel | undefined): CopilotWire;
/**
 * The upstream protocol for ONE REQUEST: the model's default wire, except
 * that a dual-protocol model defaulting to chat completions must reroute to
 * Responses when the request combines function tools with a reasoning effort
 * — Copilot rejects exactly that combination on /chat/completions with
 * HTTP 400 invalid_request_body ("Function tools with reasoning_effort are
 * not supported … use /v1/responses or set reasoning_effort to 'none'",
 * observed on gpt-5.4) while /responses serves it. Effort 'none' stays on
 * the chat wire (the API allows the combination there), and models not
 * listing /responses never reroute.
 * @param entry - the discovered catalog entry, when known.
 * @param options - the harness generate options (tools + effort only).
 * @returns the protocol the request for this model must speak.
 */
export declare function copilotRequestWire(entry: DiscoveredModel | undefined, options: Pick<GenerateOptions, 'tools' | 'reasoningEffort'>): CopilotWire;
/**
 * The chat completions request body for one generation. The output cap rides
 * `max_completion_tokens` — the newer OpenAI-family models on Copilot reject
 * the legacy `max_tokens` parameter outright (HTTP 400 "Unsupported
 * parameter"), and the rest of the catalog accepts the new spelling.
 * @param options - the harness generate options.
 * @param messages - translated wire messages (images pre-resolved).
 * @returns the JSON body.
 */
export declare function copilotChatRequestBody(options: GenerateOptions, messages: Record<string, unknown>[]): Record<string, unknown>;
/**
 * The Responses request body for one generation (the wire the `/responses`-
 * only model families speak). Usage arrives on `response.completed`.
 * @param options - the harness generate options.
 * @param resolved - translated instructions + input (images pre-resolved).
 * @returns the JSON body.
 */
export declare function copilotResponsesRequestBody(options: GenerateOptions, resolved: ResponsesRequestInput): Record<string, unknown>;
/**
 * Rewrite Copilot's Responses-gateway item ids into stable per-item keys.
 * Unlike chatgpt.com's Responses backend, the Copilot gateway mints a FRESH
 * opaque `item.id`/`item_id` on every event of one response (the `added`,
 * each delta, and the `done` all differ), which defeats id-keyed block
 * assembly in the shared translator: text fragments would each open their
 * own block, `done` would synthesize duplicates, and a function call whose
 * arguments arrive whole only on `done` (the deltas carry empty strings)
 * would close empty. The stable key derives from the event's `output_index`
 * — the item's position in the response's output array, which survives the
 * gateway's per-event id churn even when two items' events interleave on
 * the wire (parallel tool calls do exactly that). Events without an
 * `output_index` fall back to the key of the last `output_item.added`, which
 * is only correct while one item's events stay contiguous — the pre-
 * interleaving behavior, kept for gateways that omit the field; with no
 * `added` seen yet they key to `copilot-item-0` as before. Function-call
 * identity additionally rides the gateway-stable `call_id`.
 */
export declare class CopilotResponsesItemNormalizer {
    private readonly onCaptured?;
    private adds;
    private lastKey;
    /** Call ids and completed reasoning items collected for the open response. */
    private capturedCallIds;
    private capturedReasoning;
    /**
     * @param onCaptured - fired at each `response.completed` that produced BOTH
     *   function calls and completed reasoning items, receiving the response's
     *   call ids and replayable reasoning items so the adapter can replay them
     *   on the next request.
     */
    constructor(onCaptured?: ((callIds: string[], items: ReasoningReplayItem[]) => void) | undefined);
    /**
     * [2026-08-23]-[a single arrival-order ordinal mis-buckets every event after
     * a second item's `added`, mangling interleaved parallel tool calls;
     * output_index is the only correlator the gateway keeps stable]-[changes
     * keys only for streams that carry output_index; no-index streams keep the
     * old last-added-key behavior byte for byte]
     */
    private keyFor;
    /**
     * Rewrite one parsed Responses event.
     * @param event - the event as parsed off the wire.
     * @returns the event with a stable item key.
     */
    push(event: ResponsesStreamEvent): ResponsesStreamEvent;
}
/** Constructor dependencies for {@link CopilotAdapter}. */
export interface CopilotAdapterOptions {
    models: readonly ModelEntry[];
    streamIdleTimeoutMs: number;
    tokens: AccountTokenManager<CopilotSession>;
    /** Late-bound pool facade (wired after adapter construction); pools list under their first member's provider. */
    pool?: () => PoolAdapter | undefined;
    /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
    discovery: boolean;
    /** Warning sink for discovery failures that fall back to the static catalog. */
    onWarn?: (message: string) => void;
    /** Fetch implementation for discovery (defaults to the proxy-aware fetch). */
    fetchFn?: FetchFn;
    /** Resolve the attachment service per request; absent means image requests fail loudly. */
    resolveAttachments?: () => AttachmentStore | undefined;
    /** Durable catalog store seeding capability metadata across restarts. */
    catalogStore?: CatalogPersistence;
    onCatalogChanged?: () => void;
    accountCatalogStore?: (account: string) => CatalogPersistence;
    /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
    rateLimit?: RateLimitWait;
    /**
     * Per-model default reasoning effort override (the Settings page's picker).
     * Returns the user-configured default for one model, or undefined to follow
     * the provider's own default.
     */
    defaultEffortOf?: (model: string) => string | undefined;
}
/** Copilot wire adapter: one instance serves the `copilot` provider route. */
export declare class CopilotAdapter extends LlmAdapter {
    private readonly options;
    private readonly catalog;
    /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
    private readonly accountCatalogs;
    private accountCatalogsInvalidated;
    private readonly invalidatedAccounts;
    /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
    private catalogOwner;
    /**
     * [2026-08-23]-[a reasoning model continuing a tool chain must get its
     * reasoning back or it restarts from scratch every tool round trip; the
     * items live in ADAPTER memory because dsh-llm's reasoning ContentBlock is
     * a closed shape that cannot carry them through the harness]-[entries are
     * namespaced per ACCOUNT × CONVERSATION × MODEL, idle out via a sliding
     * TTL, and the whole store is dropped on auth transitions, so replay
     * degrades to the old behavior instead of leaking across contexts]
     */
    private readonly replayByScope;
    /** Call-id entries kept per scope; see {@link captureReasoning}. */
    private static readonly REPLAY_CALL_LIMIT;
    /** Conversation scopes kept at once; bounds memory when many sessions interleave. */
    private static readonly REPLAY_SCOPE_LIMIT;
    /** How long a captured entry stays replayable; tool round trips take minutes, not hours. */
    private static readonly REPLAY_TTL_MS;
    constructor(options: CopilotAdapterOptions);
    /** Discovery fetcher: resolves the session through the refresh-aware path. */
    private fetchCatalog;
    /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
    clearAccountCatalog(account?: string): void;
    /** Default and secondary accounts each seed their own persisted catalog. */
    private catalogFor;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): import("@deepseek-ai/dsh-llm").ResolvedRetryPolicy;
    private staticModels;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** The provider's own catalog: union of every account, or one account when named. */
    listOwnModels(provider: string, account?: string, signal?: AbortSignal, preferCached?: boolean): Promise<readonly LlmModelInfo[]>;
    /**
     * The discovered entry for one model. Resolved through the cache's
     * stale-while-revalidate path: capability metadata must stay stable across
     * a long conversation — a mid-turn refetch must neither block nor fail the
     * call before provider I/O.
     */
    private discovered;
    /**
     * [2026-08-23]-[a manually configured responses-only model combined with
     * `discovery:false` left discovered() undefined, so copilotRequestWire
     * silently defaulted to /chat/completions and the request 404/400'd at the
     * gateway; an explicit config wire must win over catalog inference]-[config
     * `models[].wire` now routes the request even without discovery]
     */
    private configuredWireEntry;
    /**
     * The replay scope isolating one ACCOUNT × CONVERSATION × MODEL. The
     * account identity is the session's long-lived GitHub token (stable across
     * Copilot-token refreshes, different per GitHub login); the conversation is
     * the loop-stamped `sessionId`, falling back to the first message's id
     * when a hand-built request carries no session stamp. Identity-free
     * requests have no replay scope; the model separates
     * wire families. A call id captured in one scope is invisible to every
     * other scope, so reused ids cannot leak reasoning across accounts,
     * conversations, or models.
     */
    private replayScope;
    /**
     * Store one response's completed reasoning items behind every call id it
     * produced, inside one replay scope. Retention: a CONSUMED entry is kept —
     * every later round of the same conversation replays ALL its earlier
     * function_calls — until it idles out of the TTL (see {@link replayFor})
     * or the per-scope entry cap evicts it oldest-first. All calls of one
     * response share ONE entry object: toResponsesInput dedupes replays by
     * array reference, so parallel calls replay the items once instead of once
     * per call.
     */
    private captureReasoning;
    /**
     * The replay items for one call id in one scope, when still fresh. The TTL
     * bounds IDLE time, not total age: a hit refreshes the entry (and its
     * eviction recency), so an ongoing conversation keeps its chain alive
     * while a conversation that stopped asking forgets within the TTL. An
     * absent or aged-out entry answers `undefined` — the no-replay
     * degradation, never an error.
     */
    private replayFor;
    /**
     * Drop every captured replay entry. Lookup correctness never depends on
     * the call — the scope already carries the account identity — but the host
     * wiring invokes this on every copilot auth transition (login, logout,
     * credential death) so a switched account's memory never holds the
     * previous account's encrypted reasoning at all; conversation teardown is
     * bounded by the TTL and the caps.
     */
    clearReplayState(): void;
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
