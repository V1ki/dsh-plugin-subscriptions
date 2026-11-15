/**
 * Qwen 千问AI平台 quota, reset instant and balance.
 *
 * An inference API key cannot read quota. This module therefore uses the
 * console credentials stored by the device login (see `auth/qwen-console.ts`)
 * to call the same Token Plan management APIs as the official CLI:
 *
 * - `usage` reports the monthly (or legacy weekly) used ratio and reset time;
 * - `subscription` reports the plan code and term;
 * - `quota-config` (public) supplies the tier's credit allotment, so the
 *   remaining credits can be derived without guessing;
 * - pay-as-you-go accounts instead report their cash balance through
 *   `GetFundAccountAvailableAmount`.
 */
import type { QwenSession } from '../auth/store.js'
import {
  exchangeQwenCliToken,
  qwenConsoleApi,
} from '../auth/qwen-console.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn, ProviderUsage, UsageWindow } from './common.js'

const TOKEN_PLAN_USAGE = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'
const TOKEN_PLAN_SUBSCRIPTION = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription'
const TOKEN_PLAN_QUOTA = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config'
const BSS_GATEWAY = 'https://cli.qianwenai.com/data/v2/api.json'

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

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
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

/** One Token Plan usage payload. */
interface QwenUsageWire {
  per1MonthPercentage?: number
  per1MonthResetTime?: number
  per1WeekPercentage?: number
  per1WeekResetTime?: number
}

/** One subscription payload. */
interface QwenSubscriptionWire {
  status?: string
  specCode?: string
  remainingDays?: number
  endTime?: number
}

/** Result of one quota read, plus a session update worth persisting. */
export interface QwenUsageResult {
  usage: ProviderUsage
  updated?: QwenSession
}

/**
 * Read the account balance of a pay-as-you-go account through the CLI gateway.
 * @returns the available amount and currency, when disclosed.
 */
async function fetchBalance(
  credentials: NonNullable<QwenSession['console']>,
  fetchFn: FetchFn,
  signal: AbortSignal,
): Promise<{ amount: string; currency?: string } | undefined> {
  const response = await fetchFn(BSS_GATEWAY, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'authorization': `Bearer ${credentials.accessToken}`,
      'user-agent': 'qianwen-cli/1.10.0',
    },
    body: JSON.stringify({
      product: 'BssOpenAPI-V3',
      action: 'GetFundAccountAvailableAmount',
      version: '2026-02-10',
      region: 'cn-beijing',
      params: {},
    }),
  })
  if (!response.ok) return undefined
  const body = await response.json().catch(() => undefined) as unknown
  const envelope = record(body)
  if (envelope === undefined || text(envelope.code) !== '200') return undefined
  const data = record(envelope.data)
  const amount = numeric(data?.AvailableAmount)
  if (amount === undefined) return undefined
  const currency = text(data?.Currency)
  return {
    amount: amount.toFixed(2),
    ...currency === undefined ? {} : { currency },
  }
}

/**
 * Read one Qwen account's quota, reset instants and remaining balance.
 * @param session - the stored platform-key session; console credentials are required.
 * @param fetchFn - transport (injectable for tests).
 * @param signal - caller cancellation.
 * @returns the usage snapshot and, when a gateway token was refreshed, the session to persist.
 */
export async function fetchQwenUsage(
  session: QwenSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<QwenUsageResult> {
  const credentials = session.console
  if (credentials === undefined) {
    // No console session yet: the card explains how to connect one. A thrown
    // error here would stick in the client error cache even after login.
    return { usage: { supported: false } }
  }
  const controller = signal ?? new AbortController().signal

  let cliAccessToken = credentials.cliAccessToken
  let updated: QwenSession | undefined
  let freshlyExchanged = false
  if (cliAccessToken === undefined) {
    cliAccessToken = await exchangeQwenCliToken(credentials.accessToken, fetchFn, controller)
    freshlyExchanged = true
    updated = { ...session, console: { ...credentials, cliAccessToken } }
  }

  /** Run one console call, exchanging a fresh gateway token once on failure. */
  const call = async (api: string, data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      return await qwenConsoleApi(api, data, cliAccessToken as string, fetchFn, controller)
    } catch (first) {
      // A cached CLI token may have expired; the device token can mint another.
      if (freshlyExchanged) throw first
      cliAccessToken = await exchangeQwenCliToken(credentials.accessToken, fetchFn, controller)
      freshlyExchanged = true
      updated = { ...session, console: { ...credentials, cliAccessToken } }
      return qwenConsoleApi(api, data, cliAccessToken, fetchFn, controller)
    }
  }

  const usageWire = await call(TOKEN_PLAN_USAGE, {}) as QwenUsageWire
  const subscription = await call(TOKEN_PLAN_SUBSCRIPTION, {
    commodityCode: 'sfm_tokenplansolo_public_cn',
  }) as QwenSubscriptionWire
  const quotaWire = await call(TOKEN_PLAN_QUOTA, {})
  const plan = text(subscription.specCode) ?? text(subscription.status)

  // Usage reports a 0–1 USED ratio, never a percentage. The account cycle is
  // monthly on current plans; older plans still report weekly.
  const monthly = numeric(usageWire.per1MonthPercentage)
  const weekly = numeric(usageWire.per1WeekPercentage)
  const usedRatio = monthly ?? weekly
  if (usedRatio === undefined) {
    // No Token Plan on this account: fall back to the cash balance of a
    // pay-as-you-go account.
    const balance = await fetchBalance(credentials, fetchFn, controller)
    return {
      usage: {
        supported: true,
        ...plan === undefined ? {} : { plan },
        ...balance === undefined ? {} : {
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: balance.amount,
            unit: 'currency' as const,
            ...balance.currency === undefined ? {} : { currency: balance.currency },
          },
        },
      },
      ...updated === undefined ? {} : { updated },
    }
  }

  const percent = Math.min(100, Math.max(0, usedRatio * 100))
  const resetAt = instant(monthly !== undefined
    ? usageWire.per1MonthResetTime
    : usageWire.per1WeekResetTime)
  const window: UsageWindow = {
    kind: 'other',
    scope: monthly !== undefined ? 'Monthly' : 'Weekly',
    usedPercent: percent,
    ...resetAt === undefined ? {} : { resetsAt: resetAt },
  }

  // quota-config is a tier table keyed by specCode; derive the remaining
  // credits so the card can show a real balance rather than only a percentage.
  let credits: ProviderUsage['credits']
  if (plan !== undefined) {
    const tier = record(quotaWire[plan])
    const total = numeric(tier?.monthly) ?? numeric(tier?.weekly)
    if (total !== undefined && total > 0) {
      credits = {
        hasCredits: true,
        unlimited: false,
        balance: (total * (1 - usedRatio)).toFixed(0),
        unit: 'credit',
      }
    }
  }

  return {
    usage: {
      supported: true,
      windows: [window],
      ...plan === undefined ? {} : { plan },
      ...credits === undefined ? {} : { credits },
    },
    ...updated === undefined ? {} : { updated },
  }
}
