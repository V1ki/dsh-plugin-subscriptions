import type { ProviderUsage } from './SubscriptionsSection.js'
import type { SubscriptionsKey } from './locales.js'
import { useQuotaClock } from './quota-display.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Reported exhaustion is independent of support for a usage-query endpoint. */
export function quotaExhaustionText(exhaustion: ProviderUsage['quotaExhaustion'], t: Translate, now = Date.now()): string | undefined {
  if (exhaustion === undefined) return undefined
  const reset = exhaustion.resetsAt
  const validReset = typeof reset === 'number' && Number.isFinite(reset) && reset >= 0 && !Number.isNaN(new Date(reset).getTime())
  // Include the browser's local timezone explicitly; never imply the server's zone.
  const resetText = validReset
    ? t('quotaExhaustionResetAt', { date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(reset)) })
    : t('quotaExhaustionResetUnknown')
  return [t('quotaExhausted'), resetText, validReset && reset <= now ? t('quotaExhaustionAwaiting') : undefined].filter(Boolean).join(' · ')
}

export function QuotaExhaustionNotice({ exhaustion, t }: { exhaustion: ProviderUsage['quotaExhaustion']; t: Translate }) {
  const now = useQuotaClock()
  const text = quotaExhaustionText(exhaustion, t, now)
  if (text === undefined) return null
  return <p role="status" style={{ margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-state-warn-label)', overflowWrap: 'anywhere' }}>{text}</p>
}
