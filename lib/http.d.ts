/** Stored proxy configuration (the proxy.json shape). */
export interface ProxyConfig {
    /** Whether outbound subscription requests route through {@link url}. */
    enabled: boolean;
    /** Proxy origin: `http://host:port` or `https://host:port`. */
    url: string;
    /** Optional proxy user for basic auth. */
    username?: string;
    /** Optional proxy password for basic auth; never sent back to the client. */
    password?: string;
    /** Hostnames (exact, suffix, or `*.example.com`) that use host routing instead. */
    bypass: string[];
}
/** The proxy config as served to the client: secrets replaced by a flag. */
export interface ProxyConfigView {
    enabled: boolean;
    url: string;
    username?: string;
    /** Whether a password is stored (the password itself never leaves the host). */
    passwordSet: boolean;
    bypass: string[];
    /** Last load/apply failure, when the stored config is unusable. */
    error?: string;
}
/** One `proxySet` payload. */
export interface ProxyInput {
    enabled: boolean;
    url: string;
    username?: string;
    /** `undefined` keeps the stored password, `null`/`''` clears it. */
    password?: string | null;
    bypass?: string[];
}
/** One `proxyTest` result. */
export interface ProxyTestResult {
    /** Whether the destination answered with an HTTP status. */
    ok: boolean;
    /** Whether the plugin proxy was used; false means host routing, not necessarily direct. */
    viaProxy: boolean;
    /** Status of the answered request, when one was received. */
    status?: number;
    /** Round-trip latency in milliseconds. */
    latencyMs?: number;
    /** Failure message, when no response was received. */
    error?: string;
}
/** A draft proxy for one test probe (never persisted). */
export interface ProxyDraft {
    url: string;
    username?: string;
    password?: string;
}
/** Destination the `proxyTest` endpoint probes when none is given. */
export declare const DEFAULT_PROXY_TEST_URL = "https://api.x.ai/v1/models";
/** Probe deadline; a hung proxy must not pin the Settings dialog forever. */
export declare const DEFAULT_PROXY_TEST_TIMEOUT_MS = 15000;
/**
 * Minimum per-address connect attempt budget for Node's Happy Eyeballs
 * (`net.autoSelectFamilyAttemptTimeout`). Node's default is 250ms, which is
 * shorter than one TCP handshake to Cloudflare-fronted hosts (registry.npmjs.org,
 * chatgpt.com) on a high-latency link: every address then fails with
 * ETIMEDOUT and the whole fetch dies even though curl succeeds.
 */
export declare const MIN_CONNECT_ATTEMPT_TIMEOUT_MS = 1500;
/**
 * Raise the process-wide Happy Eyeballs attempt timeout to at least `minMs`.
 * Never lowers a host-configured value. The setting is per process (there is
 * no per-dispatcher knob that survives the host's global dispatcher), so the
 * plugin restores the previous value on dispose.
 * @param minMs - the floor to enforce.
 * @returns the value in effect before the call.
 */
export declare function ensureConnectAttemptTimeout(minMs?: number): number;
/** Restore a value captured by {@link ensureConnectAttemptTimeout}. */
export declare function restoreConnectAttemptTimeout(previous: number): void;
/** Absolute path of the proxy config file. */
export declare function proxyFilePath(): string;
/**
 * Flatten a fetch failure into a readable message: undici wraps the true
 * cause (`connect ECONNREFUSED ...`) behind a bare "fetch failed", so walk
 * the cause chain and append each distinct layer (up to four, cycle-safe).
 * A hostname resolving to several addresses (e.g. `localhost` → ::1 and
 * 127.0.0.1) fails as an `AggregateError` with an empty message, so its
 * per-address `errors` entries are folded in too.
 */
export declare function describeFetchError(error: unknown): string;
/**
 * Parse and validate a proxy URL. Only HTTP(S) proxies are supported because
 * the undici dispatcher speaks CONNECT over HTTP; socks5 is not supported.
 * @param raw - the URL the user configured.
 * @returns the parsed URL (credentials attached by the caller).
 */
export declare function parseProxyUrl(raw: string): URL;
/**
 * Whether a request hostname bypasses the proxy.
 * @param hostname - the request's hostname.
 * @param entries - configured bypass entries: exact host, plain suffix
 *   (`example.com` also matches `api.example.com`), or `*.example.com`.
 */
export declare function matchesBypass(hostname: string, entries: readonly string[]): boolean;
/**
 * Current proxy config as served to the client (secrets omitted).
 * @returns the view; {@link ProxyConfigView.error} carries the last
 *   load/apply failure when the stored config is unusable.
 */
export declare function proxyGetConfig(): Promise<ProxyConfigView>;
/**
 * Validate, persist, and apply one proxy config. A `password` of `undefined`
 * keeps the stored value; `null` or `''` clears it.
 * @param input - the client's payload.
 * @returns the resulting view (secrets omitted).
 */
export declare function proxySetConfig(input: ProxyInput): Promise<ProxyConfigView>;
/**
 * The fetch caller all subscription code uses: routes through the configured
 * proxy unless the host bypasses it. Identity-passthrough otherwise: the host
 * may itself route global fetch through an environment-configured proxy.
 *
 * Proxied requests run on undici's own fetch (not the global one) so the
 * ProxyAgent dispatcher always comes from the same undici build the request
 * is issued with — a mismatched dispatcher can be silently ignored by the
 * host's global fetch.
 */
export declare function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
/**
 * Probe a destination through a proxy, answering with the HTTP status or a
 * flattened transport error. The probe uses `draft` when given (the dialog's
 * current inputs, without saving) and the stored config otherwise.
 * @param target - `http(s)` URL to fetch; defaults to {@link DEFAULT_PROXY_TEST_URL}.
 * @param draft - unsaved proxy inputs to test; absent means the stored config.
 * @returns the result; any HTTP status counts as a successful connection,
 *   only a transport failure is an error.
 */
export declare function proxyTestConnection(target?: string, draft?: ProxyDraft): Promise<ProxyTestResult>;
