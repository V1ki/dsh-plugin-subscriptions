import { useEffect, useState } from 'react'
import type { ProviderUsage } from './SubscriptionsSection.js'
import type { SubscriptionsKey } from './locales.js'
import type { QuotaDisplayMode } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Never coerce null, missing or non-finite telemetry into a full allowance. */
export function quotaPercent(used: unknown, mode: QuotaDisplayMode): number | undefined {
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined
  const percent = Math.min(100, Math.max(0, used))
  return Math.round(mode === 'remaining' ? 100 - percent : percent)
}

export function quotaText(used: unknown, mode: QuotaDisplayMode, t: Translate): string {
  const percent = quotaPercent(used, mode)
  return percent === undefined ? t('quotaUnknown') : t(mode === 'remaining' ? 'quotaRemainingPercent' : 'quotaUsedPercent', { percent })
}

export function quotaIsStale(usage: ProviderUsage, now = Date.now()): boolean {
  return usage.stale === true || usage.refreshFailed === true
    || (usage.staleAt !== undefined && now >= usage.staleAt)
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

export function UsageFreshness({ usage, t }: { usage: ProviderUsage; t: Translate }) {
  const now = useQuotaClock()
  const parts = [
    usage.refreshFailed ? t('quotaRefreshFailed') : quotaIsStale(usage, now) ? t('quotaStale') : undefined,
    usage.fetchedAt === undefined ? t('quotaFreshnessUnknown') : t('quotaFetchedAt', { date: new Date(usage.fetchedAt).toLocaleString() }),
    usage.retryAt === undefined ? undefined : t('quotaRetryAt', { date: new Date(usage.retryAt).toLocaleString() }),
  ].filter(Boolean)
  return <p style={{ margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{parts.join(' · ')}</p>
}
