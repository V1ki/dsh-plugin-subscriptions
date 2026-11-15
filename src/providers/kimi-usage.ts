/**
 * Kimi Code subscription usage.
 *
 * The official CLI's `/usage` reads one endpoint: `GET /coding/v1/usages`
 * with only the account's Bearer token. It returns ratio pools for the
 * rolling 5-hour window, the legacy weekly window, and the shared monthly
 * pool, plus the Extra Usage wallet. There is no reset-credit concept.
 */
import { KIMI_API_BASE } from '../auth/kimi.js'
import type { KimiSession } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn, ProviderUsage, UsageWindow } from './common.js'

/** One ratio pool: a 0–1 used ratio and an RFC3339 reset instant. */
interface KimiRatioPool {
  used_ratio?: number | string
  reset_time?: string
}

/** Legacy absolute-count window. */
interface KimiCountWindow {
  limit?: number | string
  used?: number | string
  remaining?: number | string
  resetTime?: string
}

/** Wire response of `GET /coding/v1/usages` (subset). */
interface KimiUsagesWire {
  usages?: {
    limit_5h?: KimiRatioPool
    limit_7d?: KimiRatioPool
    limit_month_total?: KimiRatioPool
    limit_month_code?: KimiRatioPool
  }
  limits?: { window?: { duration?: number; timeUnit?: string }; detail?: KimiCountWindow }[]
  usage?: KimiCountWindow
  user?: { membership?: { level?: string } }
  boosterWallet?: {
    status?: string
    balance?: { type?: string; amount?: number | string; amountLeft?: number | string }
    monthlyChargeLimit?: { currency?: string }
  }
}

/** `GET /coding/v1/me` subset. */
interface KimiMeWire {
  user_level_name?: string
  goods_version?: string
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** A used ratio (0–1) as a 0–100 percentage. */
function ratioPercent(value: unknown): number | undefined {
  const ratio = numeric(value)
  if (ratio === undefined) return undefined
  return Math.min(100, Math.max(0, ratio * 100))
}

/** An RFC3339 instant as epoch milliseconds. */
function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** A count window's used percentage, deriving `used` from the other fields. */
function countPercent(window: KimiCountWindow | undefined): number | undefined {
  if (window === undefined) return undefined
  const limit = numeric(window.limit)
  if (limit === undefined || limit <= 0) return undefined
  const used = numeric(window.used) ?? (() => {
    const remaining = numeric(window.remaining)
    return remaining === undefined ? undefined : limit - remaining
  })()
  if (used === undefined) return undefined
  return Math.min(100, Math.max(0, (used / limit) * 100))
}

/** One ratio pool as a usage window, when it reported a ratio. */
function ratioWindow(
  pool: KimiRatioPool | undefined,
  kind: UsageWindow['kind'],
  durationMs: number,
  scope?: string,
): UsageWindow[] {
  const usedPercent = ratioPercent(pool?.used_ratio)
  if (usedPercent === undefined) return []
  const resetsAt = instant(pool?.reset_time)
  return [{ kind, usedPercent, durationMs, ...scope === undefined ? {} : { scope }, ...resetsAt === undefined ? {} : { resetsAt } }]
}

/** Extra Usage wallet → a currency balance, when the wallet is active. */
function walletBalance(wallet: KimiUsagesWire['boosterWallet']): ProviderUsage['credits'] {
  if (wallet === undefined || wallet.status === 'STATUS_DISABLED' || wallet.status === 'STATUS_FROZEN') return undefined
  if (wallet.balance?.type !== 'BOOSTER') return undefined
  const fixed = numeric(wallet.balance.amountLeft) ?? numeric(wallet.balance.amount)
  if (fixed === undefined) return undefined
  // The wallet reports fixed point ×1e6; below one cent rounds up, matching
  // the official client.
  const amount = fixed / 1_000_000
  const cents = Math.round(amount * 100)
  return {
    hasCredits: true,
    unlimited: false,
    balance: (cents > 0 && cents < 1 ? 0.01 : amount).toFixed(2),
    unit: 'currency',
    ...wallet.monthlyChargeLimit?.currency === undefined
      ? {} : { currency: wallet.monthlyChargeLimit.currency },
  }
}

/**
 * Fetch one Kimi Code account's subscription usage.
 * @param session - the logged-in OAuth session.
 * @param fetchFn - transport (injectable for tests).
 * @param signal - caller cancellation.
 * @returns windows, Extra Usage balance, and the plan tier when disclosed.
 */
export async function fetchKimiUsage(
  session: KimiSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const headers = { 'authorization': `Bearer ${session.accessToken}`, 'accept': 'application/json' }
  const response = await fetchFn(`${KIMI_API_BASE}/usages`, {
    headers, ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(`Kimi Code usage query failed (HTTP ${String(response.status)})`)
  const wire = await response.json() as KimiUsagesWire

  const windows: UsageWindow[] = []
  const fiveHour = ratioWindow(wire.usages?.limit_5h, 'session', 5 * 60 * 60_000)
  windows.push(...fiveHour)
  windows.push(...ratioWindow(wire.usages?.limit_7d, 'weekly', 7 * 24 * 60 * 60_000))
  windows.push(...ratioWindow(wire.usages?.limit_month_total, 'other', 30 * 24 * 60 * 60_000, 'Monthly'))
  // The code share is a breakdown of the shared monthly pool, not another cap.
  windows.push(...ratioWindow(wire.usages?.limit_month_code, 'other', 30 * 24 * 60 * 60_000, 'Code'))
  if (windows.length === 0) {
    // Legacy plans report absolute counts instead of ratio pools.
    for (const entry of wire.limits ?? []) {
      const minutes = entry.window?.timeUnit === 'TIME_UNIT_MINUTE'
        ? numeric(entry.window?.duration)
        : entry.window?.timeUnit === 'TIME_UNIT_HOUR'
          ? (numeric(entry.window?.duration) ?? 0) * 60
          : undefined
      const usedPercent = countPercent(entry.detail)
      if (minutes === undefined || usedPercent === undefined) continue
      const resetsAt = instant(entry.detail?.resetTime)
      windows.push({
        kind: minutes <= 360 ? 'session' : minutes >= 7 * 24 * 60 ? 'weekly' : 'other',
        usedPercent,
        durationMs: minutes * 60_000,
        ...resetsAt === undefined ? {} : { resetsAt },
      })
    }
    const legacyWeekly = countPercent(wire.usage)
    if (legacyWeekly !== undefined) {
      windows.push({
        kind: 'weekly',
        usedPercent: legacyWeekly,
        durationMs: 7 * 24 * 60 * 60_000,
        ...instant(wire.usage?.resetTime) === undefined ? {} : { resetsAt: instant(wire.usage?.resetTime)! },
      })
    }
  }

  // The tier name lives on a separate endpoint; a failure must not hide usage.
  let plan = typeof wire.user?.membership?.level === 'string' && wire.user.membership.level.length > 0
    ? wire.user.membership.level : undefined
  try {
    const meResponse = await fetchFn(`${KIMI_API_BASE}/me`, {
      headers, ...signal === undefined ? {} : { signal },
    })
    if (meResponse.ok) {
      const me = await meResponse.json() as KimiMeWire
      if (typeof me.user_level_name === 'string' && me.user_level_name.length > 0) plan = me.user_level_name
    }
  } catch {
    // Best-effort only.
  }

  const credits = walletBalance(wire.boosterWallet)
  return {
    supported: true,
    windows,
    ...plan === undefined ? {} : { plan },
    ...credits === undefined ? {} : { credits },
  }
}
