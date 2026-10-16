/**
 * Rate-limit window handling shared by the subscription adapters.
 *
 * A subscription plan is rate-limit shaped by design — a five-hour session
 * window, a weekly window, and on some plans a per-model weekly one — so a 429
 * is not a dead end: the window reopens at a time the provider discloses. This
 * module turns that disclosure into the `providerRetryAfterMs` the optional
 * `@deepseek-ai/dsh-llm-retry` plugin waits out, and resolves the retry policy
 * whose `maxDelayMs` decides how long a route is allowed to hold the turn.
 *
 * The wait itself is provider-independent: adapters own the policy, the retry
 * plugin executes it. Only the extraction of the reset instant differs, so each
 * adapter contributes one {@link RateLimitResetReader} built from the parsing
 * primitives here.
 *
 * @module dsh-plugin-subscriptions/providers/rate-limit
 */
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
/**
 * Reads the instant one provider's rate-limit window reopens off a 429.
 * @param response - the failed response, for its headers.
 * @param body - the complete response body (never truncated: readers parse JSON).
 * @param now - the current epoch milliseconds, injected so parsing is testable.
 * @returns epoch milliseconds of the reset, or undefined when the provider said nothing.
 */
export type RateLimitResetReader = (response: Response, body: string, now: number) => number | undefined;
/** Default ceiling on a rate-limit wait: six hours covers a five-hour session window with slack. */
export declare const DEFAULT_RATE_LIMIT_MAX_WAIT_MS: number;
/**
 * Interpret a bare numeric rate-limit value, which providers write in three
 * shapes: epoch milliseconds, epoch seconds, or a delay in seconds. The
 * magnitude separates them unambiguously for any plausible value — an epoch in
 * seconds is ~1.8e9 today, while a delay of even a full week is ~6e5.
 * @param value - the raw numeric value.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when the value is unusable.
 */
export declare function resetInstantFromNumber(value: number, now: number): number | undefined;
/**
 * Parse a Go-style duration (`6m0s`, `1h2m3.5s`, `150ms`) into milliseconds —
 * the form OpenAI-compatible `x-ratelimit-reset-*` headers use.
 * @param text - the raw header value.
 * @returns the duration in milliseconds, or undefined when the text is not one.
 */
export declare function durationMs(text: string): number | undefined;
/**
 * Interpret any single rate-limit value — a number, a numeric string, a
 * duration (`6m0s`), or a date — as the instant a window reopens. One reader
 * for every shape, so a provider that changes the encoding of a field it
 * already sends does not need a code change here.
 * @param value - the raw header value or JSON field.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when the value is unusable.
 */
export declare function resetInstantFromValue(value: unknown, now: number): number | undefined;
/**
 * Read a header carrying any of the {@link resetInstantFromValue} shapes.
 * @param response - the failed response.
 * @param name - the header to read.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when absent or unusable.
 */
export declare function resetInstantFromHeader(response: Response, name: string, now: number): number | undefined;
/**
 * Read the RFC 7231 `retry-after` header in both its forms: a delay in seconds
 * (never an epoch stamp, whatever its magnitude) or an HTTP-date.
 * @param response - the failed response.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when absent or unusable.
 */
export declare function retryAfterInstant(response: Response, now: number): number | undefined;
/**
 * Parse a response body as JSON without throwing on the non-JSON bodies
 * providers occasionally return under load (an HTML gateway page, say).
 * @param body - the complete response body.
 * @returns the parsed value, or undefined when the body is not JSON.
 */
export declare function jsonBody(body: string): unknown;
/**
 * Find a reset instant under any of the named keys, anywhere in a parsed body.
 *
 * The search is by key rather than by path on purpose: providers move the same
 * field between containers (`detail`, `error`, top level) across endpoints and
 * versions, and a path-shaped reader silently stops working when they do. Only
 * the key list is provider-specific.
 * @param value - the parsed body, or any nested value.
 * @param keys - field names this provider uses for a reset or delay.
 * @param now - the current epoch milliseconds.
 * @param depth - remaining recursion depth.
 * @returns the earliest instant found, or undefined when no key matched.
 */
export declare function resetFromFields(value: unknown, keys: readonly string[], now: number, depth?: number): number | undefined;
/**
 * The earliest of several candidate reset instants, ignoring absent ones. The
 * earliest is the one that matters: it is the first moment any of the reported
 * limits allows a request again.
 * @param candidates - reset instants in no particular order.
 * @returns the earliest instant, or undefined when every candidate is absent.
 */
export declare function earliestReset(...candidates: (number | undefined)[]): number | undefined;
/**
 * Turn a reset instant into the wait to report as `providerRetryAfterMs`.
 *
 * Deliberately not capped: a reset beyond the policy's `maxDelayMs` makes the
 * retry plugin delegate immediately, failing the turn at once with the real
 * reset in the message, rather than clamping the wait down and burning the
 * retry budget against a window that is still closed.
 * @param instant - epoch milliseconds the window reopens.
 * @param now - the current epoch milliseconds.
 * @returns the wait in milliseconds, never below {@link MIN_WAIT_MS}.
 */
export declare function waitFromReset(instant: number, now: number): number;
/**
 * Render the rate-limit-shaped headers and the head of the body of a 429 whose
 * reset instant nothing parsed. Emitted through the adapter's `onWarn`, this is
 * how an unrecognized provider field gets named from live traffic instead of
 * being guessed at.
 *
 * It is also where the per-bucket rollover snapshots land by design — no reader
 * parks a turn on one, because on a 429 they cannot say which bucket refused —
 * so the operator still sees what the provider disclosed.
 * @param response - the failed response.
 * @param body - the complete response body.
 * @returns a one-line diagnostic.
 */
export declare function rateLimitDiagnostics(response: Response, body: string): string;
/** Per-route retry shape a subscription adapter starts from. */
export interface RetryDefaults {
    /** Retries after the first attempt. */
    readonly maxRetries: number;
    /** First local backoff delay. */
    readonly initialDelayMs: number;
    /** Local backoff ceiling, and the accepted-provider-delay ceiling when waiting is off. */
    readonly maxDelayMs: number;
    /** Symmetric jitter around each local delay. */
    readonly jitterRatio: number;
}
/**
 * The retry shape every subscription route starts from: Claude Code's own SDK
 * numbers — ten retries after the first attempt, exponential backoff from 1s
 * doubling per attempt, capped at 60s, plus 20% jitter.
 *
 * Shared across all four routes rather than kept to claude, because what these
 * numbers are tuned for is the shape of a subscription endpoint — a consumer
 * plan behind a session window, which sheds load in bursts and rewards an
 * attempt that outlasts them — and that is the same on all four. The dsh-llm
 * defaults (5 retries from 500ms to 10s) give up after about fifteen seconds,
 * which is short for that.
 *
 * The 60s cap governs local backoff only: a disclosed rate-limit reset is
 * accepted up to the configured wait ceiling instead.
 */
export declare const DEFAULT_RETRY: RetryDefaults;
/** How long a route may hold a turn open waiting for a rate-limit window. */
export interface RateLimitWait {
    /** Whether a disclosed reset may be waited out at all. */
    readonly wait: boolean;
    /** Ceiling on one wait; a reset further out fails the turn instead. */
    readonly maxWaitMs: number;
}
/** Rate-limit waiting as the plugin config accepts it. */
export interface RateLimitConfig {
    /** Wait for a disclosed reset instead of failing the turn (default true). */
    wait?: boolean;
    /** Ceiling on one wait in milliseconds (default six hours). */
    maxWaitMs?: number;
}
/** Waiting behavior a route falls back to when the plugin passed none (waiting on, six-hour ceiling). */
export declare const DEFAULT_RATE_LIMIT_WAIT: RateLimitWait;
/**
 * Validate and default the rate-limit waiting config.
 * @param config - the raw plugin config section, when present.
 * @param path - diagnostic path naming the config that owns the value.
 * @returns the resolved, immutable behavior.
 */
export declare function resolveRateLimitWait(config: RateLimitConfig | undefined, path: string): RateLimitWait;
/**
 * Resolve one route's retry policy, widening the delay ceiling to the
 * configured wait so a disclosed reset hours out is accepted rather than
 * refused.
 *
 * The ceiling is shared with local exponential backoff, so widening it also
 * raises how long an unrelated transient failure may back off for. That stays
 * bounded by the finite retry budget — the claude route's ten retries reach
 * 512 s per attempt at most — and it only governs when the provider disclosed
 * nothing, which is exactly the case where a longer wait is the safer guess.
 * @param defaults - the route's retry shape.
 * @param rateLimit - resolved waiting behavior.
 * @param path - diagnostic path naming the provider route.
 * @returns the policy to report from `providerRetryPolicy`.
 */
export declare function subscriptionRetryPolicy(defaults: RetryDefaults, rateLimit: RateLimitWait, path: string): ResolvedRetryPolicy;
