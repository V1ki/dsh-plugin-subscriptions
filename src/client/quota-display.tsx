import { useEffect, useState } from 'react'
import type { CreditBalance, ProviderUsage } from './SubscriptionsSection.js'
import type { SubscriptionsKey } from './locales.js'
import type { QuotaDisplayMode } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Never coerce null, missing or non-finite telemetry into a full allowance. */
export function quotaPercent(used: unknown, mode: QuotaDisplayMode): number | undefined {
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined
  const percent = Math.min(100, Math.max(0, used))
  return Math.round(mode === 'remaining' ? 100 - percent : percent)
}

/** Group a reported credit balance without inventing a currency conversion. */
export function formatCreditBalance(value: string): string {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return value
  const negative = amount < 0
  const [whole, fraction] = Math.abs(amount).toFixed(2).split('.')
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const text = fraction === '00' ? grouped : `${grouped}.${fraction!.replace(/0$/, '')}`
  return negative ? `-${text}` : text
}

/** Display line for a disclosed Codex credit balance; undefined when absent. */
export function creditBalanceText(credits: CreditBalance | undefined, t: Translate): string | undefined {
  if (credits === undefined) return undefined
  if (credits.overageLimitReached === true) return t('creditsOverage')
  if (credits.unlimited) return t('creditsUnlimited')
  if (credits.balance !== undefined) return t('creditsBalance', { balance: formatCreditBalance(credits.balance) })
  return credits.hasCredits ? t('creditsAvailableUnknown') : undefined
}

export function quotaText(used: unknown, mode: QuotaDisplayMode, t: Translate): string {
  const percent = quotaPercent(used, mode)
  return percent === undefined ? t('quotaUnknown') : t(mode === 'remaining' ? 'quotaRemainingPercent' : 'quotaUsedPercent', { percent })
}

export function quotaIsStale(usage: ProviderUsage, now = Date.now()): boolean {
  return usage.stale === true || usage.refreshFailed === true
    || (validTimestamp(usage.staleAt) && now >= usage.staleAt)
}

/** Ticks only the local presentation clock; never fetches usage. */
export function useQuotaClock(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Availability is separate from the age of an existing quota snapshot. */
export function quotaUnavailableText(usage: ProviderUsage | undefined, failed: boolean, t: Translate): string | undefined {
  if (usage?.supported === false) return t('quotaUnsupported')
  if (usage?.windows?.length) return undefined
  if (failed || usage?.refreshFailed) return t('quotaFailedNoData')
  return t('usageEmpty')
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && !Number.isNaN(new Date(value).getTime())
}

/** Receipt time is diagnostic only: a successful RPC can still return an old cache. */
export function usageFreshnessText(usage: ProviderUsage | undefined, failed: boolean, t: Translate, now = Date.now()): string {
  const unavailable = quotaUnavailableText(usage, failed, t)
  if (unavailable !== undefined) return unavailable
  const snapshot = usage!
  const time = validTimestamp(snapshot.fetchedAt)
    ? t('quotaFetchedAt', { date: new Date(snapshot.fetchedAt).toLocaleString() })
    : validTimestamp(snapshot.receivedAt)
      ? t('quotaReceivedAt', { date: new Date(snapshot.receivedAt).toLocaleString() })
      : t('quotaUpdateTimeMissing')
  return [
    failed || snapshot.refreshFailed ? t('quotaRefreshFailed') : quotaIsStale(snapshot, now) ? t('quotaStale') : undefined,
    time,
    validTimestamp(snapshot.retryAt) ? t('quotaRetryAt', { date: new Date(snapshot.retryAt).toLocaleString() }) : undefined,
  ].filter(Boolean).join(' · ')
}

export function UsageFreshness({ usage, failed = false, t }: { usage: ProviderUsage | undefined; failed?: boolean; t: Translate }) {
  const now = useQuotaClock()
  return <p style={{ margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{usageFreshnessText(usage, failed, t, now)}</p>
}
