/**
 * OAuth device-authorization flow (RFC 8628) for providers that cannot use
 * the loopback redirect engine: no redirect URI, no PKCE, no client secret.
 * The user opens a verification URL and types a short code while the plugin
 * polls the token endpoint until the provider releases the tokens.
 *
 * The request shape is configurable per provider: GitHub speaks form-encoded
 * fields with no extra headers, while Kimi/Qwen send JSON bodies with device
 * headers. The management model (one attempt per provider,
 * `isBusy`/`pending`/`cancel`) mirrors {@link OAuthFlowManager} so the auth
 * controller can treat both engines uniformly.
 *
 * Transport failures are retried without minting new codes: a dropped poll
 * connection is not an answer, and re-requesting a device code would orphan
 * the user's current authorization window.
 */
import { proxiedFetch } from '../http.js'

/** Default poll interval when the device-code response omits one. */
const DEFAULT_INTERVAL_SEC = 5

/** Default device-code lifetime when the device-code response omits one. */
const DEFAULT_EXPIRES_IN_SEC = 900

/** Transport attempts for one device-code request. */
const DEVICE_CODE_ATTEMPTS = 3

/** Base backoff between device-code attempts; grows linearly per retry. */
const DEVICE_CODE_BACKOFF_MS = 400

/** Consecutive transport failures a poll may survive before the login fails. */
const POLL_TRANSPORT_ATTEMPTS = 5

/** Static per-provider device-flow facts. */
export interface DeviceFlowSpec {
  /** Public client id the device code is requested for. */
  clientId: string
  /** Scope string requested at device-code time (omitted when empty). */
  scope?: string
  /** Device-code endpoint (e.g. `https://github.com/login/device/code`). */
  deviceCodeUrl: string
  /** Token polling endpoint (e.g. `https://github.com/login/oauth/access_token`). */
  tokenUrl: string
  /** Extra headers sent on both requests (device identity, user agent). */
  headers?: Readonly<Record<string, string>>
  /** Open `verification_uri_complete` when the provider returns it. */
  preferCompleteUri?: boolean
  /** Fetch implementation (injectable for tests). */
  fetchFn?: typeof fetch
}

/** The tokens a successful device grant released. */
export interface DeviceTokenSet {
  accessToken: string
  /** Present when the grant issued a refresh token (Kimi, Qwen). */
  refreshToken?: string
  /** Access-token lifetime in seconds, when reported. */
  expiresIn?: number
  scope?: string
  tokenType?: string
}

/** One in-flight device-flow login attempt. */
export interface DeviceAttempt {
  /** URL the user opens to authorize (e.g. `https://github.com/login/device`). */
  readonly verificationUrl: string
  /** Short code the user types at the verification URL. */
  readonly userCode: string
  /**
   * Poll until the provider releases the access token.
   * @returns the OAuth access token; rejects on timeout, denial, or cancel.
   */
  waitToken(): Promise<string>
  /**
   * Poll until the provider releases the full token set (refresh token
   * included). Providers whose login mints a session from more than the
   * access token use this instead of {@link waitToken}.
   */
  waitTokens(): Promise<DeviceTokenSet>
  /** Abort the attempt; `waitToken` rejects with a cancellation error. */
  cancel(): void
}

/** Raw device-code response shape (subset). */
interface DeviceCodeWire {
  device_code?: string
  user_code?: string
  verification_uri?: string
  verification_uri_complete?: string
  interval?: number
  expires_in?: number
}

/** Raw token-poll response shape (subset): success or an RFC 8628 error code. */
interface DeviceTokenWire {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
}

/** Sleep for `ms`, rejecting early when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Sleep without a cancellation signal (used before an attempt exists). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Headers for both RFC 8628 form requests, plus the provider's device headers. */
function requestHeaders(spec: DeviceFlowSpec): Record<string, string> {
  return {
    'accept': 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    ...spec.headers,
  }
}

/**
 * Request a device code, retrying transport failures.
 *
 * A device-code request is not idempotent: every call mints a new code. A retry
 * is therefore only safe when the transport failed before any response arrived,
 * which is exactly when `fetch` rejects. Any response — success or an HTTP error
 * — ends the retries so a slow network cannot orphan issued codes.
 * @param fetchFn - fetch implementation (injected by tests).
 * @param spec - the flow facts for this provider.
 * @returns the device-code response, once one arrives.
 */
async function requestDeviceCode(fetchFn: typeof fetch, spec: DeviceFlowSpec): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchFn(spec.deviceCodeUrl, {
        method: 'POST',
        headers: requestHeaders(spec),
        body: new URLSearchParams({
          client_id: spec.clientId,
          ...spec.scope === undefined || spec.scope.length === 0 ? {} : { scope: spec.scope },
        }).toString(),
      })
    } catch (error) {
      if (attempt >= DEVICE_CODE_ATTEMPTS) throw error
      await wait(DEVICE_CODE_BACKOFF_MS * attempt)
    }
  }
}

/**
 * Own the set of in-flight device-flow attempts, keyed by provider. One
 * attempt per provider at a time; an attempt removes itself when it settles.
 */
export class DeviceFlowManager {
  private attempts = new Map<string, DeviceAttempt>()

  /**
   * Whether a device-flow attempt is running for one provider.
   * @param provider - the provider route.
   * @returns true while an attempt is polling.
   */
  isBusy(provider: string): boolean {
    return this.attempts.has(provider)
  }

  /**
   * The pending attempt for one provider, when any.
   * @param provider - the provider route.
   * @returns the in-flight attempt, or `undefined`.
   */
  pending(provider: string): DeviceAttempt | undefined {
    return this.attempts.get(provider)
  }

  /**
   * Start a device-flow attempt: request a device code, then poll the token
   * endpoint in the background of `waitToken`.
   * @param provider - the provider route (one attempt at a time).
   * @param spec - static flow facts for this provider.
   * @returns the live attempt; its `waitToken()` settles the login.
   * @throws when an attempt is already running or the device-code request fails.
   */
  async start(provider: string, spec: DeviceFlowSpec): Promise<DeviceAttempt> {
    if (this.attempts.has(provider)) {
      throw new Error(`a ${provider} login attempt is already in progress`)
    }
    const fetchFn = spec.fetchFn ?? proxiedFetch
    const headers = requestHeaders(spec)
    const response = await requestDeviceCode(fetchFn, spec)
    if (!response.ok) {
      throw new Error(`${provider} device-code request failed (HTTP ${String(response.status)})`)
    }
    const wire = await response.json() as DeviceCodeWire
    if (typeof wire.device_code !== 'string' || wire.device_code.length === 0
      || typeof wire.user_code !== 'string' || wire.user_code.length === 0
      || typeof wire.verification_uri !== 'string' || wire.verification_uri.length === 0) {
      throw new Error(`${provider} device-code response is missing device_code/user_code/verification_uri`)
    }
    const intervalSec = typeof wire.interval === 'number' && wire.interval > 0
      ? wire.interval
      : DEFAULT_INTERVAL_SEC
    const expiresInSec = typeof wire.expires_in === 'number' && wire.expires_in > 0
      ? wire.expires_in
      : DEFAULT_EXPIRES_IN_SEC

    const controller = new AbortController()
    let resolveTokens!: (tokens: DeviceTokenSet) => void
    let rejectTokens!: (error: Error) => void
    const tokensPromise = new Promise<DeviceTokenSet>((resolve, reject) => {
      resolveTokens = resolve
      rejectTokens = reject
    })
    // The promise settles exactly once, from the poll loop below; an unhandled
    // rejection must not surface if nobody awaited waitToken after a cancel.
    tokensPromise.catch(() => undefined)

    const settle = (error?: Error, tokens?: DeviceTokenSet): void => {
      // Identity check: a late settle from a stale attempt (its poll loop or a
      // cancel arriving after it already settled) must not kill a NEW attempt
      // the user started for the same provider.
      if (this.attempts.get(provider) !== attempt) return
      this.attempts.delete(provider)
      if (error !== undefined) rejectTokens(error)
      else if (tokens !== undefined) resolveTokens(tokens)
    }

    const poll = async (): Promise<void> => {
      let intervalMs = intervalSec * 1000
      let transportFailures = 0
      const deadline = Date.now() + expiresInSec * 1000
      while (true) {
        await sleep(intervalMs, controller.signal)
        if (Date.now() >= deadline) {
          settle(new Error(`login timed out after ${String(Math.round(expiresInSec))}s`))
          return
        }
        let pollResponse: Response
        let result: DeviceTokenWire
        try {
          pollResponse = await fetchFn(spec.tokenUrl, {
            method: 'POST',
            headers,
            body: new URLSearchParams({
              client_id: spec.clientId,
              device_code: wire.device_code as string,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }).toString(),
            signal: controller.signal,
          })
          result = await pollResponse.json() as DeviceTokenWire
        } catch (error) {
          // A cancel rejects through this same path and must surface, never retry.
          if (controller.signal.aborted) throw error
          // A dropped connection is not an answer from the provider: keep the
          // login alive instead of burning the user's remaining window.
          transportFailures += 1
          if (transportFailures >= POLL_TRANSPORT_ATTEMPTS) throw error
          continue
        }
        transportFailures = 0
        if (typeof result.access_token === 'string' && result.access_token.length > 0) {
          settle(undefined, {
            accessToken: result.access_token,
            ...typeof result.refresh_token === 'string' && result.refresh_token.length > 0
              ? { refreshToken: result.refresh_token } : {},
            ...typeof result.expires_in === 'number' && result.expires_in > 0
              ? { expiresIn: result.expires_in } : {},
            ...typeof result.scope === 'string' ? { scope: result.scope } : {},
            ...typeof result.token_type === 'string' ? { tokenType: result.token_type } : {},
          })
          return
        }
        switch (result.error) {
          case 'authorization_pending':
            break
          case 'slow_down':
            // RFC 8628 §3.5: add five seconds to the poll interval.
            intervalMs += 5000
            break
          case 'access_denied':
            settle(new Error(`login declined on the ${provider} authorization page`))
            return
          case 'expired_token':
            settle(new Error('the device code expired before authorization completed'))
            return
          default:
            settle(new Error(
              `${provider} device-flow polling failed: ${result.error_description ?? result.error ?? `HTTP ${String(pollResponse.status)}`}`,
            ))
            return
        }
      }
    }

    const attempt: DeviceAttempt = {
      verificationUrl: spec.preferCompleteUri === true && typeof wire.verification_uri_complete === 'string'
        && wire.verification_uri_complete.length > 0
        ? wire.verification_uri_complete
        : wire.verification_uri,
      userCode: wire.user_code,
      waitToken: async () => (await tokensPromise).accessToken,
      waitTokens: () => tokensPromise,
      cancel: () => {
        controller.abort(new Error('login cancelled'))
        settle(new Error('login cancelled'))
      },
    }
    this.attempts.set(provider, attempt)

    void poll().catch((error: unknown) => {
      // Aborts land here from sleep/fetch; everything else is a transport or
      // parse failure worth surfacing as the login failure.
      settle(error instanceof Error ? error : new Error(String(error)))
    })
    return attempt
  }
}
