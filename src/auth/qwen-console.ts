/**
 * Qwen 千问AI平台 console login (quota only).
 *
 * The platform never exposes account quota to an inference API key. The
 * official CLI obtains it through a PKCE device flow at `t.qianwenai.com`,
 * exchanges the resulting token for a CLI access token, and then calls the
 * console gateway. This module implements that chain so the plugin can show
 * the same quota/reset data as the foreign subscription providers.
 *
 * It is an undocumented management surface (the official CLI itself uses it);
 * inference stays on the API key and is never routed through these tokens.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { platform, arch } from 'node:os'
import { proxiedFetch } from '../http.js'

const DEVICE_HOST = 'https://t.qianwenai.com'
const CLI_GATEWAY = 'https://cli.qianwenai.com/data/v2/api.json'
const CONSOLE_GATEWAY = 'https://cs-data.qianwenai.com/cli/api.json'
const REGION = 'cn-beijing'
/** Same product/console metadata the official CLI sends. */
const CORNERSTONE = {
  protocol: 'V2',
  console: 'ONE_CONSOLE',
  productCode: 'p_efm',
  switchUserType: 3,
  consoleSite: 'QIANWENAI',
} as const
const USER_AGENT = `qianwen-cli/1.10.0 (${platform()}; ${arch()})`
const REQUEST_TIMEOUT_MS = 30_000
const MIN_POLL_MS = 2000

/** Stored console credentials (quota reads only). */
export interface QwenConsoleCredentials {
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds at which the console access token expires. */
  expiresAt: number
  /** Short-lived gateway token exchanged from `accessToken`, cached. */
  cliAccessToken?: string
  /** Display identity the flow returned, when any. */
  user?: string
}

/** One in-flight console login. */
export interface QwenConsoleAttempt {
  /** URL the user opens to authorize. */
  readonly authorizeUrl: string
  wait(): Promise<QwenConsoleCredentials>
  cancel(): void
}

/** Injectable transport for tests. */
export interface QwenConsoleOptions {
  fetchFn?: typeof fetch
  /** Test seam: poll cadence floor. */
  minPollMs?: number
}

interface ConsoleEnvelope {
  Data?: {
    Token?: string
    ExpiresIn?: number
    VerificationUrl?: string
    Interval?: number
    Status?: string
    Credentials?: {
      AccessToken?: string
      RefreshToken?: string
      ExpireTime?: number | string
      User?: unknown
    }
  }
  Success?: boolean
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function instant(value: unknown): number | undefined {
  const asNumber = numeric(value)
  if (asNumber !== undefined) {
    if (asNumber > 1e12) return asNumber
    if (asNumber > 1e9) return asNumber * 1000
    return undefined
  }
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('login cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('login cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** One JSON POST with a bounded deadline and no redirects. */
async function postJson(
  fetchFn: typeof fetch,
  url: string,
  init: { body?: unknown; headers?: Record<string, string>; signal: AbortSignal },
  what: string,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    headers: {
      'accept': 'application/json',
      'user-agent': USER_AGENT,
      ...init.body === undefined ? {} : { 'content-type': 'application/json' },
      ...init.headers,
    },
    ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
  })
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new Error('Qwen console login redirects are not followed')
  }
  const body = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    throw new Error(`Qwen ${what} failed (HTTP ${String(response.status)})`)
  }
  return record(body) ?? {}
}

/** Start the PKCE device login the official CLI performs. */
export async function startQwenConsoleLogin(options: QwenConsoleOptions = {}): Promise<QwenConsoleAttempt> {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const controller = new AbortController()
  const clientId = randomUUID()
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  const authorize = new URL(`${DEVICE_HOST}/cli/device/code`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('code_challenge_method', 'S256')
  const start = await postJson(fetchFn, authorize.toString(), { signal: controller.signal }, 'console login start')
  const device = (start.Data ?? {}) as ConsoleEnvelope['Data']
  const token = text(device?.Token)
  const authorizeUrl = text(device?.VerificationUrl)
  if (token === undefined || authorizeUrl === undefined) {
    throw new Error('Qwen console login start returned no device token or verification URL')
  }
  const intervalMs = Math.max(options.minPollMs ?? MIN_POLL_MS, (numeric(device?.Interval) ?? 2) * 1000)
  const expiresAt = Date.now() + Math.max(30, numeric(device?.ExpiresIn) ?? 300) * 1000

  let settled = false
  let resolveLogin!: (credentials: QwenConsoleCredentials) => void
  let rejectLogin!: (error: Error) => void
  const waitPromise = new Promise<QwenConsoleCredentials>((resolve, reject) => {
    resolveLogin = resolve
    rejectLogin = reject
  })
  waitPromise.catch(() => undefined)
  const settle = (error?: Error, credentials?: QwenConsoleCredentials): void => {
    if (settled) return
    settled = true
    if (error !== undefined) rejectLogin(error)
    else if (credentials !== undefined) resolveLogin(credentials)
  }

  const pollUrl = new URL(`${DEVICE_HOST}/cli/device/token`)
  pollUrl.searchParams.set('client_id', clientId)
  pollUrl.searchParams.set('token', token)
  pollUrl.searchParams.set('code_verifier', verifier)

  const poll = async (): Promise<void> => {
    let interval = intervalMs
    while (true) {
      await sleep(interval, controller.signal)
      if (Date.now() >= expiresAt) {
        settle(new Error('Qwen console login timed out before authorization completed'))
        return
      }
      const result = await postJson(fetchFn, pollUrl.toString(), { signal: controller.signal }, 'console login poll')
      const data = (result.Data ?? {}) as ConsoleEnvelope['Data']
      const status = text(data?.Status)
      if (status === 'authorization_pending') continue
      if (status === 'slow_down') {
        interval += 5000
        continue
      }
      if (status === 'access_denied') {
        settle(new Error('Qwen console login was declined'))
        return
      }
      if (status === 'expired_token') {
        settle(new Error('Qwen console login expired; start again'))
        return
      }
      const credentials = data?.Credentials
      const accessToken = text(credentials?.AccessToken)
      if (status === 'complete' || accessToken !== undefined) {
        if (accessToken === undefined) {
          settle(new Error('Qwen console login finished without an access token'))
          return
        }
        const user = record(credentials?.User)
        const refreshToken = text(credentials?.RefreshToken)
        const userLabel = text(user?.email) ?? text(user?.name) ?? text(user?.username)
        settle(undefined, {
          accessToken,
          expiresAt: instant(credentials?.ExpireTime) ?? Date.now() + 30 * 24 * 60 * 60_000,
          ...refreshToken === undefined ? {} : { refreshToken },
          ...userLabel === undefined ? {} : { user: userLabel },
        })
        return
      }
      settle(new Error(`Qwen console login returned an unexpected status${status === undefined ? '' : ` ${status}`}`))
      return
    }
  }

  void poll().catch((error: unknown) => {
    settle(error instanceof Error ? error : new Error(String(error)))
  })

  return {
    authorizeUrl,
    wait: () => waitPromise,
    cancel: () => {
      controller.abort(new Error('login cancelled'))
      settle(new Error('login cancelled'))
    },
  }
}

/**
 * Exchange the device-flow token for the short-lived gateway credential the
 * console API accepts.
 */
export async function exchangeQwenCliToken(
  accessToken: string,
  fetchFn: typeof fetch = proxiedFetch,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const body = await postJson(fetchFn, CLI_GATEWAY, {
    headers: { authorization: `Bearer ${accessToken}` },
    body: {
      product: 'ModelStudioRegional',
      action: 'GenerateCLIAccessToken',
      version: '2026-02-10',
      region: REGION,
      params: {},
    },
    signal,
  }, 'console token exchange')
  if (text(body.code) !== '200') {
    throw new Error('Qwen console token exchange was rejected; log in again')
  }
  const data = record(body.data)
  const cliAccessToken = text(data?.cliAccessToken)
  if (cliAccessToken === undefined) throw new Error('Qwen console token exchange returned no CLI token')
  return cliAccessToken
}

/** Unwrap the console gateway's nested envelope to the business payload. */
function unwrapGateway(body: Record<string, unknown>): Record<string, unknown> {
  const layer1 = record(body.data)
  if (text(layer1?.errorCode) !== undefined) {
    throw new Error(`Qwen console login is required (${String(layer1?.errorCode)})`)
  }
  const layer2 = record(layer1?.DataV2)
  const layer3 = record(layer2?.data)
  const layer4 = record(layer3?.data)
  const payload = layer4 ?? layer3 ?? layer2 ?? layer1 ?? {}
  if (payload.success === false) throw new Error(text(payload.errorCode) ?? 'Qwen console request failed')
  return payload
}

/**
 * Call one Token Plan management API on the console gateway.
 * @param api - the inner `zeldaHttp.apikeyMgr....` path.
 * @param data - the inner request payload.
 */
export async function qwenConsoleApi(
  api: string,
  data: Record<string, unknown>,
  cliAccessToken: string,
  fetchFn: typeof fetch = proxiedFetch,
  signal: AbortSignal = new AbortController().signal,
): Promise<Record<string, unknown>> {
  const url = new URL(CONSOLE_GATEWAY)
  url.searchParams.set('action', 'BroadScopeAspnGateway')
  url.searchParams.set('product', 'sfm_bailian')
  url.searchParams.set('api', api)
  const params = JSON.stringify({
    Api: api,
    V: '1.0',
    Data: { ...data, cornerstoneParam: CORNERSTONE },
  })
  const response = await fetchFn(url.toString(), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    headers: {
      'accept': 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'authorization': `Bearer ${cliAccessToken}`,
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ params, region: REGION }).toString(),
  })
  if (!response.ok) throw new Error(`Qwen console request failed (HTTP ${String(response.status)})`)
  const body = await response.json().catch(() => undefined) as unknown
  const envelope = record(body)
  if (envelope === undefined || text(envelope.code) !== '200') {
    throw new Error('Qwen console request was rejected; log in again')
  }
  return unwrapGateway(envelope)
}
