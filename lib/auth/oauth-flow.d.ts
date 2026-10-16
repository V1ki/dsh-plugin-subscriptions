/**
 * Generic OAuth authorization-code flow engine: one temporary loopback HTTP
 * server per login attempt receives the provider's redirect, validates
 * `state`, and yields the authorization `code`. A pasted callback URL or bare
 * code can substitute for the browser redirect (`manual`), and the user can
 * abort (`cancel`). At most one attempt per provider runs at a time.
 */
import { type PkcePair } from './pkce.js';
/** Default attempt lifetime: three minutes for the user to complete login. */
export declare const DEFAULT_FLOW_TIMEOUT_MS = 180000;
/** Where the temporary callback server listens; port 0 asks the OS for an ephemeral port. */
export interface ListenSpec {
    host: string;
    /** Tried in order; the first free port wins (covers the codex 1455→1457 fallback). */
    ports: readonly number[];
}
/** Inputs an authorize-URL builder may need for one attempt. */
export interface AuthorizeInput {
    /** Loopback redirect URI pointing at the temporary server. */
    redirectUri: string;
    state: string;
    pkce: PkcePair;
    /** Random hex nonce; only providers that require one use it. */
    nonce: string;
}
/** Static per-provider flow facts. */
export interface FlowSpec {
    /** Path the provider redirects to on the loopback server. */
    callbackPath: string;
    listen: ListenSpec;
    timeoutMs?: number;
    /**
     * Build the provider authorize URL for one attempt.
     * @param input - redirect URI, state, PKCE pair, and nonce minted for this attempt.
     * @returns the URL the user's browser should open.
     */
    buildAuthorizeUrl(input: AuthorizeInput): string;
}
/** One in-flight login attempt. */
export interface OAuthAttempt {
    /** URL to open in the user's browser. */
    readonly authorizeUrl: string;
    /** Redirect URI registered for this attempt (echoed at the token exchange). */
    readonly redirectUri: string;
    /** PKCE pair minted for this attempt. */
    readonly pkce: PkcePair;
    /** State parameter minted for this attempt (some providers echo it at exchange). */
    readonly state: string;
    /**
     * Wait for the authorization code from the browser callback or `manual`.
     * @returns the authorization code; rejects on timeout, provider error, or cancel.
     */
    waitCode(): Promise<string>;
    /**
     * Feed a pasted full callback URL (code + state extracted and validated) or
     * a bare authorization code (state cannot be checked) into this attempt.
     * @param input - the pasted text.
     * @throws when the input carries no code or a mismatched state.
     */
    manual(input: string): void;
    /** Abort the attempt and close its callback server. */
    cancel(): void;
}
/**
 * Own the set of in-flight login attempts, keyed by provider. One attempt per
 * provider at a time; an attempt removes itself when it settles.
 */
export declare class OAuthFlowManager {
    private attempts;
    /**
     * Whether a login attempt is running for one provider.
     * @param provider - the provider route.
     * @returns true while an attempt is waiting for its code.
     */
    isBusy(provider: string): boolean;
    /**
     * The pending attempt for one provider, when any.
     * @param provider - the provider route.
     * @returns the in-flight attempt, or `undefined`.
     */
    pending(provider: string): OAuthAttempt | undefined;
    /**
     * Start a login attempt: mint PKCE/state, open the loopback callback
     * server, and build the authorize URL.
     * @param provider - the provider route (one attempt at a time).
     * @param spec - static flow facts for this provider.
     * @returns the live attempt; its `waitCode()` settles the login.
     * @throws when an attempt is already running or no callback port is free.
     */
    start(provider: string, spec: FlowSpec): Promise<OAuthAttempt>;
}
