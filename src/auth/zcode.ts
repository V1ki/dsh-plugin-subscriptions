/**
 * ZCode (Zhipu / Z.ai GLM Coding Plan) authorization chain.
 *
 * The official ZCode clients log in through a server-mediated OAuth flow
 * (`cli/init` → browser → `cli/poll`) and then provision a long-lived
 * coding-plan API key through the business API. This module implements that
 * chain so the plugin can offer the same browser login as the upstream
 * subscription providers instead of asking for a pasted API key.
 *
 * Both stations speak the same protocol; they differ in the identity
 * provider (`bigmodel` vs `zai`), the business host, and whether the account
 * token must first be exchanged for a business JWT.
 *
 * No refresh token exists anywhere in this chain: the minted key is
 * long-lived and the business token can re-mint it. When either is rejected,
 * the user logs in again.
 */
import { randomBytes } from 'node:crypto'
import { proxiedFetch } from '../http.js'
import type { GlmSession } from './store.js'

/** Which ZCode station (identity provider) the user signs in with. */
export type GlmStation = 'bigmodel' | 'zai'

/** ZCode CLI flow host (same for both stations). */
export const ZCODE_HOST = 'https://zcode.z.ai'
/** OAuth flow lifetime reported by `cli/init` (300 s); used only as a fallback. */
const FLOW_TTL_MS = 300_000
/** Poll cadence floor; the server usually asks for 2 s. */
const MIN_POLL_MS = 2000
/** Consecutive transient poll failures tolerated before the attempt fails. */
const MAX_POLL_FAILURES = 5
/** One HTTP round trip bound; the whole login is separately bounded by the flow TTL. */
const REQUEST_TIMEOUT_MS = 30_000
/** Name of the key the official client provisions, so a re-login reuses it. */
const KEY_NAME = 'zcode-api-key'
/**
 * How long a minted key is trusted before the plugin re-mints it. The key
 * itself carries no documented expiry; a month keeps the credential fresh
 * without a browser round trip.
 */
const KEY_LIFETIME_MS = 30 * 24 * 60 * 60_000

/** Per-station business API facts. */
const STATIONS = Object.freeze({
  bigmodel: Object.freeze({
    bizHost: 'https://bigmodel.cn',
    /** The business API expects the account token verbatim (no Bearer prefix). */
    scheme: 'raw' as const,
    loginUrl: undefined,
    secretRequired: false,
  }),
  zai: Object.freeze({
    bizHost: 'https://api.z.ai',
    scheme: 'bearer' as const,
    loginUrl: 'https://api.z.ai/api/auth/z/login',
    secretRequired: true,
  }),
})

/** Envelope every ZCode endpoint answers with. */
interface Envelope {
  code?: number | string
  msg?: string
  message?: string
  data?: unknown
  success?: boolean
  logid?: string
}

/** One in-flight ZCode login. */
export interface GlmLoginAttempt {
  /** URL the user opens to authorize; use it verbatim. */
  readonly authorizeUrl: string
  /** Settle when the browser login and key provisioning finish. */
  wait(): Promise<GlmSession>
  /** Abort the attempt; `wait` rejects with a cancellation error. */
  cancel(): void
}

/** Injectable transport + clock, for tests. */
export interface ZcodeOptions {
  fetchFn?: typeof fetch
  now?: () => number
  /** Test seam: poll cadence floor (defaults to the server-friendly 2s). */
  minPollMs?: number
}

function failure(message: string): Error {
  return new Error(message)
}

/** Parse one envelope and require `code` 0/200. */
function okEnvelope(raw: unknown, what: string): unknown {
  if (typeof raw !== 'object' || raw === null) throw failure(`ZCode ${what} returned an unexpected response`)
  const envelope = raw as Envelope
  const code = envelope.code === undefined ? undefined : String(envelope.code)
  if (code !== undefined && code !== '0' && code !== '200') {
    const detail = envelope.msg ?? envelope.message
    // 1001 is "no Authorization parameter": the minting token is gone, which
    // a retry cannot fix.
    if (code === '1001') throw new ZcodeError(`ZCode ${what} was not authorized`, 401)
    throw failure(`ZCode ${what} failed${detail === undefined || detail.length === 0 ? '' : `: ${detail}`}`)
  }
  if (envelope.success === false) throw failure(`ZCode ${what} failed`)
  return envelope.data
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Sleep that rejects early when the attempt is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : failure('login cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : failure('login cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** One JSON request with a bounded deadline and no redirects. */
async function requestJson(
  fetchFn: typeof fetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; signal: AbortSignal },
  what: string,
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: init.method ?? 'GET',
    redirect: 'error',
    signal: AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    headers: {
      'accept': 'application/json',
      ...init.body === undefined ? {} : { 'content-type': 'application/json' },
      ...init.headers,
    },
    ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
  })
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw failure('ZCode redirected the login request; refusing to follow')
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw failure(`ZCode ${what} returned a non-JSON response (HTTP ${String(response.status)})`)
  }
  if (!response.ok) {
    // A 400 with code 3004 means the flow expired or was never created.
    const envelope = parsed as Envelope
    if (String(envelope.code) === '3004') throw new ZcodeError('the ZCode login flow expired; start again')
    throw new ZcodeError(`ZCode ${what} failed (HTTP ${String(response.status)})`, response.status)
  }
  return parsed
}

/** Start the server-mediated login: create a flow and return its attempt. */
export async function startGlmLogin(
  station: GlmStation,
  options: ZcodeOptions = {},
): Promise<GlmLoginAttempt> {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const now = options.now ?? Date.now
  const controller = new AbortController()
  let pollToken = randomBytes(32).toString('hex')

  const init = await requestJson(fetchFn, `${ZCODE_HOST}/api/v1/oauth/cli/init`, {
    method: 'POST',
    headers: { authorization: `Bearer ${pollToken}` },
    body: { provider: station },
    signal: controller.signal,
  }, 'login start')
  const data = record(okEnvelope(init, 'login start'))
  const flowId = text(data?.flow_id)
  const authorizeUrl = text(data?.authorize_url)
  if (flowId === undefined || authorizeUrl === undefined) {
    throw failure('ZCode login start returned no flow id or authorization URL')
  }
  // The server may issue its own poll token; adopt it when present.
  pollToken = text(data?.poll_token) ?? pollToken
  const intervalMs = Math.max(
    options.minPollMs ?? MIN_POLL_MS,
    typeof data?.poll_interval_sec === 'number' && data.poll_interval_sec > 0
      ? data.poll_interval_sec * 1000 : MIN_POLL_MS,
  )
  // Prefer the server-relative lifetime: a skewed local clock must not make a
  // fresh 300-second flow look expired (or keep a dead one alive).
  const serverTime = typeof data?.server_time === 'number' ? data.server_time * 1000 : now()
  const ttlMs = typeof data?.expires_at === 'number'
    ? Math.max(0, data.expires_at * 1000 - serverTime)
    : FLOW_TTL_MS
  const expiresAt = now() + ttlMs

  let settled = false
  let rejectLogin!: (error: Error) => void
  let resolveLogin!: (session: GlmSession) => void
  const waitPromise = new Promise<GlmSession>((resolve, reject) => {
    resolveLogin = resolve
    rejectLogin = reject
  })
  waitPromise.catch(() => undefined)

  const settle = (error?: Error, session?: GlmSession): void => {
    if (settled) return
    settled = true
    if (error !== undefined) rejectLogin(error)
    else if (session !== undefined) resolveLogin(session)
  }

  const poll = async (): Promise<void> => {
    let failures = 0
    while (true) {
      await sleep(intervalMs, controller.signal)
      if (now() >= expiresAt) {
        settle(failure('the ZCode login timed out before authorization completed'))
        return
      }
      let polled: unknown
      try {
        polled = await requestJson(fetchFn, `${ZCODE_HOST}/api/v1/oauth/cli/poll/${flowId}`, {
          headers: { authorization: `Bearer ${pollToken}` },
          signal: controller.signal,
        }, 'login poll')
        failures = 0
      } catch (error) {
        if (controller.signal.aborted) throw error
        // An expired flow is terminal; a retry cannot revive it.
        if (error instanceof ZcodeError && /expired/.test(error.message)) throw error
        failures += 1
        if (failures > MAX_POLL_FAILURES) throw error
        continue
      }
      const state = record(okEnvelope(polled, 'login poll'))
      const status = text(state?.status)
      if (status === 'pending') continue
      if (status === 'failed') {
        settle(failure('the ZCode authorization was declined or failed'))
        return
      }
      if (status !== 'ready') {
        settle(failure('ZCode login returned an unexpected polling state'))
        return
      }
      settle(undefined, await completeLogin(station, state ?? {}, now, fetchFn, controller.signal))
      return
    }
  }

  void poll().catch((error: unknown) => {
    settle(error instanceof Error ? error : failure(String(error)))
  })

  return {
    authorizeUrl,
    wait: () => waitPromise,
    cancel: () => {
      controller.abort(failure('login cancelled'))
      settle(failure('login cancelled'))
    },
  }
}

/** Turn a `ready` poll payload into a stored session. */
async function completeLogin(
  station: GlmStation,
  ready: Record<string, unknown>,
  now: () => number,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<GlmSession> {
  const nested = record(station === 'zai' ? ready.zai : ready.bigmodel)
  const accountToken = text(nested?.access_token) ?? text(nested?.accessToken)
    ?? text(ready.access_token) ?? text(ready.accessToken)
  if (accountToken === undefined) {
    throw failure('ZCode login finished without an account token')
  }
  const user = record(ready.user) ?? record(nested?.user)
  const account = text(user?.email) ?? text(user?.name)
  const businessToken = await businessTokenOf(station, accountToken, fetchFn, signal)
  const apiKey = await mintKey(station, businessToken, fetchFn, signal)
  return {
    accessToken: apiKey,
    refreshToken: businessToken,
    expiresAt: now() + KEY_LIFETIME_MS,
    station,
    ...account === undefined ? {} : { account },
  }
}

/** Exchange the account token for the business credential the key APIs accept. */
async function businessTokenOf(
  station: GlmStation,
  accountToken: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const spec = STATIONS[station]
  if (spec.loginUrl === undefined) return accountToken
  const raw = await requestJson(fetchFn, spec.loginUrl, {
    method: 'POST',
    body: { token: accountToken },
    signal,
  }, 'business login')
  const data = record(okEnvelope(raw, 'business login'))
  const token = text(data?.access_token) ?? text(data?.accessToken)
  if (token === undefined) throw failure('ZCode business login returned no access token')
  return token
}

/**
 * Mint (or reuse) the coding-plan key on the station's business API.
 *
 * bigmodel's accepted Authorization form is not documented; two working
 * implementations send the token raw, so that is tried first and a `Bearer`
 * retry covers the other side of an API drift.
 */
export async function mintKey(
  station: GlmStation,
  businessToken: string,
  fetchFn: typeof fetch = proxiedFetch,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const spec = STATIONS[station]
  try {
    return await provisionKey(spec.bizHost, spec.secretRequired, spec.scheme === 'bearer'
      ? `Bearer ${businessToken}` : businessToken, fetchFn, signal)
  } catch (error) {
    if (station !== 'bigmodel' || !(error instanceof ZcodeError) || error.status !== 401) throw error
    return provisionKey(spec.bizHost, spec.secretRequired, `Bearer ${businessToken}`, fetchFn, signal)
  }
}

async function provisionKey(
  bizHost: string,
  secretRequired: boolean,
  authorization: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const biz = (path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> =>
    requestJson(fetchFn, `${bizHost}${path}`, {
      ...init.method === undefined ? {} : { method: init.method },
      headers: { authorization },
      ...init.body === undefined ? {} : { body: init.body },
      signal,
    }, 'business request')

  const customer = record(okEnvelope(await biz('/api/biz/customer/getCustomerInfo'), 'customer lookup'))
  const organizations = Array.isArray(customer?.organizations) ? customer.organizations : []
  const orgs = organizations.map(record).filter((org): org is Record<string, unknown> => org !== undefined)
  const projectsOf = (org: Record<string, unknown>): Record<string, unknown>[] =>
    (Array.isArray(org.projects) ? org.projects : [])
      .map(record).filter((project): project is Record<string, unknown> => project !== undefined)
  // Prefer the default organization among those that actually have a project;
  // an account without any project has no active coding plan.
  const withProjects = orgs.filter(org => projectsOf(org).length > 0)
  if (withProjects.length === 0) {
    throw failure('this GLM account has no organization with a coding-plan project')
  }
  const org = withProjects.find(entry => String(entry.organizationName ?? '').includes('默认机构')) ?? withProjects[0]
  const projects = projectsOf(org)
  const project = projects.find(entry => String(entry.projectName ?? '').includes('默认项目')) ?? projects[0]
  const organizationId = text(org.organizationId)
  const projectId = text(project.projectId)
  if (organizationId === undefined || projectId === undefined) {
    throw failure('ZCode could not resolve the coding-plan organization/project')
  }
  const keysPath = `/api/biz/v1/organization/${encodeURIComponent(organizationId)}`
    + `/projects/${encodeURIComponent(projectId)}/api_keys`

  const listed = await biz(keysPath)
  const listedKeys = okEnvelope(listed, 'key list')
  const keys = (Array.isArray(listedKeys) ? listedKeys : [])
    .map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined)
  let apiKey = keys.find(entry => entry.name === KEY_NAME)?.apiKey
  if (text(apiKey) === undefined) {
    const created = record(okEnvelope(await biz(keysPath, { method: 'POST', body: { name: KEY_NAME } }), 'key create'))
    apiKey = created?.apiKey
  }
  const keyId = text(apiKey)
  if (keyId === undefined) throw failure('ZCode did not return a coding-plan API key')

  let secret: string | undefined
  try {
    const copied = record(okEnvelope(
      await biz(`${keysPath}/copy/${encodeURIComponent(keyId)}`),
      'key copy',
    ))
    secret = text(copied?.secretKey)
  } catch (error) {
    // bigmodel tolerates a missing secret; zai needs it for signing.
    if (secretRequired) throw error
  }
  if (secretRequired && secret === undefined) {
    throw failure('ZCode did not return the key secret required by the z.ai station')
  }
  return secret === undefined ? keyId : `${keyId}.${secret}`
}

/**
 * Re-mint a stored GLM key from its business token. The chain has no refresh
 * grant; the business token is long-lived and re-running provisioning reuses
 * the same `zcode-api-key`.
 */
export async function refreshGlm(session: GlmSession, fetchFn: typeof fetch = proxiedFetch): Promise<GlmSession> {
  const apiKey = await mintKey(session.station, session.refreshToken, fetchFn)
  return { ...session, accessToken: apiKey, expiresAt: Date.now() + KEY_LIFETIME_MS }
}

/** Permanent rejection (401/403) means the business token itself is gone. */
export function isGlmPermanentRefreshError(error: unknown): boolean {
  return error instanceof ZcodeError && (error.status === 401 || error.status === 403)
}

/** An HTTP failure carrying the status the chain rejected with. */
export class ZcodeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ZcodeError'
  }
}
