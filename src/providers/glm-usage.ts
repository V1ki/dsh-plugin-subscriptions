/**
 * GLM Coding Plan usage and banked reset cards.
 *
 * The official ZCode client reads the Coding Plan windows from the same
 * `monitor` plane an API key can call: `GET {root}/api/monitor/usage/quota/limit`
 * with the minted `<id>.<secret>` key as a bare `authorization` header. The
 * minted key can also list the account's banked 5-hour/week reset cards.
 *
 * The response carries the 5-hour and weekly credit windows, the plan tier,
 * and one reset instant per window; there is no cash balance on this plane.
 */
import type { GlmSession } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn, ProviderUsage, ResetCredit, UsageWindow } from './common.js'

/** Business/usage plane per station. */
function rootOf(station: GlmSession['station']): string {
  return station === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn'
}

/** Envelope every ZCode business endpoint answers with. */
interface Envelope {
  code?: number | string
  msg?: string
  message?: string
  success?: boolean
  data?: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Epoch ms, epoch seconds, or an ISO/local datetime as epoch milliseconds. */
function instant(value: unknown): number | undefined {
  const asNumber = numeric(value)
  if (asNumber !== undefined) {
    if (asNumber > 1e12) return asNumber
    if (asNumber > 1e9) return asNumber * 1000
    return undefined
  }
  if (typeof value !== 'string' || value.length === 0) return undefined
  // Dashboard timestamps omit a zone; the account plane is Beijing time.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}+08:00`
    : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Call one business endpoint, sending the minted key bare first (what the
 * official client does) and retrying once with `Bearer` because several
 * shipping clients use that form.
 * @returns the envelope's `data` object.
 * @throws with the provider's own message when the call fails.
 */
async function glmJson(
  url: string,
  key: string,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const attempt = async (authorization: string): Promise<{ response: Response; body: Envelope | undefined }> => {
    const response = await fetchFn(url, {
      headers: { 'authorization': authorization, 'accept': 'application/json' },
      ...signal === undefined ? {} : { signal },
    })
    const body = await response.json().catch(() => undefined) as Envelope | undefined
    return { response, body }
  }
  let { response, body } = await attempt(key)
  const firstCode = body?.code === undefined ? '' : String(body.code)
  if (response.status === 401 || firstCode === '401' || firstCode === '1000') {
    ({ response, body } = await attempt(`Bearer ${key}`))
  }
  if (!response.ok) throw new Error(`GLM usage query failed (HTTP ${String(response.status)})`)
  if (body === undefined) throw new Error('GLM usage query returned a non-JSON response')
  const code = body.code === undefined ? '' : String(body.code)
  if ((code !== '' && code !== '0' && code !== '200') || body.success === false) {
    const message = body.msg ?? body.message ?? `business error ${code}`
    if (/不存在\s*coding plan|coding.?plan.*不存在|no active coding plan/i.test(message)) {
      throw new Error('this GLM account has no active Coding Plan subscription')
    }
    throw new Error(message)
  }
  return record(body.data) ?? {}
}

/** One `limits[]` row of the quota response. */
interface GlmLimit {
  type?: string
  unit?: number
  number?: number
  usage?: number | string
  percentage?: number | string
  nextResetTime?: number | string
}

/** Map one limit row onto a usage window, or undefined when it is not a cap. */
function limitWindow(limit: GlmLimit): UsageWindow | undefined {
  const type = limit.type ?? ''
  const unit = numeric(limit.unit)
  const number = numeric(limit.number) ?? 1
  const usedPercent = numeric(limit.percentage)
  const resetsAt = instant(limit.nextResetTime)
  const base = {
    ...usedPercent === undefined ? {} : { usedPercent: Math.min(100, Math.max(0, usedPercent)) },
    ...resetsAt === undefined ? {} : { resetsAt },
  }
  if ((type === 'CREDIT_LIMIT' || type === 'TOKENS_LIMIT') && unit === 3) {
    return { kind: 'session', usedPercent: base.usedPercent ?? 0, durationMs: Math.max(1, number) * 60 * 60_000, ...base }
  }
  if ((type === 'CREDIT_LIMIT' || type === 'TOKENS_LIMIT') && unit === 6) {
    return { kind: 'weekly', usedPercent: base.usedPercent ?? 0, durationMs: Math.max(1, number) * 7 * 24 * 60 * 60_000, ...base }
  }
  if (type === 'TIME_LIMIT' && unit === 5 && (numeric(limit.usage) ?? 0) > 0) {
    return { kind: 'other', scope: 'MCP', usedPercent: base.usedPercent ?? 0, durationMs: Math.max(1, number) * 30 * 24 * 60 * 60_000, ...base }
  }
  return undefined
}

/** One banked reset card from the reset-list endpoint. */
interface GlmResetCard {
  recordId?: number | string
  id?: number | string
  expireTime?: string
  available?: boolean
  status?: string
  state?: string
}

const SPENT_RESET_STATES = new Set(['consumed', 'redeeming', 'redeemed', 'used', 'expired', 'unavailable'])

function resetCards(value: unknown, now: number): ResetCredit[] {
  if (!Array.isArray(value)) return []
  const cards: ResetCredit[] = []
  for (const entry of value) {
    const card = record(entry) as GlmResetCard | undefined
    if (card === undefined) continue
    if (card.available === false) continue
    const state = (card.status ?? card.state ?? '').toLowerCase()
    if (SPENT_RESET_STATES.has(state)) continue
    const expiresAt = instant(card.expireTime)
    if (expiresAt !== undefined && expiresAt <= now) continue
    const id = card.recordId ?? card.id
    cards.push({
      ...id === undefined ? {} : { id: String(id) },
      ...expiresAt === undefined ? {} : { expiresAt },
    })
  }
  return cards
}

/**
 * Fetch one GLM account's Coding Plan usage and banked reset cards.
 * @param session - the minted-key session.
 * @param fetchFn - transport (injectable for tests).
 * @param signal - caller cancellation.
 * @returns windows, plan tier, and the available reset cards.
 */
export async function fetchGlmUsage(
  session: GlmSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const root = rootOf(session.station)
  const data = await glmJson(`${root}/api/monitor/usage/quota/limit`, session.accessToken, fetchFn, signal)
  const ranges = Array.isArray(data.limits) ? data.limits : []
  const windows: UsageWindow[] = []
  for (const entry of ranges) {
    const limit = record(entry) as GlmLimit | undefined
    if (limit === undefined) continue
    const window = limitWindow(limit)
    if (window !== undefined) windows.push(window)
  }
  const plan = typeof data.planName === 'string' && data.planName.length > 0
    ? data.planName
    : typeof data.level === 'string' && data.level.length > 0 ? data.level : undefined

  // Banked reset cards are an optional extra: a failure must not hide usage.
  let resetCredits: ResetCredit[] | undefined
  let resetCreditsError: string | undefined
  try {
    const reset = await glmJson(`${root}/api/biz/customer-package-reset/list?targetType=PERSONAL`,
      session.accessToken, fetchFn, signal)
    const now = Date.now()
    resetCredits = [
      ...resetCards(reset.fiveHourResets, now),
      ...resetCards(reset.weekResets, now),
    ]
  } catch (error) {
    resetCreditsError = error instanceof Error ? error.message : String(error)
  }

  return {
    supported: true,
    windows,
    ...plan === undefined ? {} : { plan },
    ...resetCredits === undefined ? {} : { resetCredits },
    ...resetCreditsError === undefined ? {} : { resetCreditsError },
  }
}
