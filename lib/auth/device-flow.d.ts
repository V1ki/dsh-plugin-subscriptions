/** Static per-provider device-flow facts. */
export interface DeviceFlowSpec {
    /** OAuth App / GitHub App client id the device code is requested for. */
    clientId: string;
    /** Scope string requested at device-code time. */
    scope: string;
    /** Device-code endpoint (e.g. `https://github.com/login/device/code`). */
    deviceCodeUrl: string;
    /** Token polling endpoint (e.g. `https://github.com/login/oauth/access_token`). */
    tokenUrl: string;
    /** Fetch implementation (injectable for tests). */
    fetchFn?: typeof fetch;
}
/** One in-flight device-flow login attempt. */
export interface DeviceAttempt {
    /** URL the user opens to authorize (e.g. `https://github.com/login/device`). */
    readonly verificationUrl: string;
    /** Short code the user types at the verification URL. */
    readonly userCode: string;
    /**
     * Poll until GitHub releases the access token.
     * @returns the GitHub OAuth access token; rejects on timeout, denial, or cancel.
     */
    waitToken(): Promise<string>;
    /** Abort the attempt; `waitToken` rejects with a cancellation error. */
    cancel(): void;
}
/**
 * Own the set of in-flight device-flow attempts, keyed by provider. One
 * attempt per provider at a time; an attempt removes itself when it settles.
 */
export declare class DeviceFlowManager {
    private attempts;
    /**
     * Whether a device-flow attempt is running for one provider.
     * @param provider - the provider route.
     * @returns true while an attempt is polling.
     */
    isBusy(provider: string): boolean;
    /**
     * The pending attempt for one provider, when any.
     * @param provider - the provider route.
     * @returns the in-flight attempt, or `undefined`.
     */
    pending(provider: string): DeviceAttempt | undefined;
    /**
     * Start a device-flow attempt: request a device code, then poll the token
     * endpoint in the background of `waitToken`.
     * @param provider - the provider route (one attempt at a time).
     * @param spec - static flow facts for this provider.
     * @returns the live attempt; its `waitToken()` settles the login.
     * @throws when an attempt is already running or the device-code request fails.
     */
    start(provider: string, spec: DeviceFlowSpec): Promise<DeviceAttempt>;
}
