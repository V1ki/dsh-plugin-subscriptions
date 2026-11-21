import type { KindOption, ViewMarker } from '../usage/window-view.js'
import type { SubscriptionsKey } from './locales.js'

export type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Locale keys for usage-window markers. */
export const MARKER_KEYS: Readonly<Record<ViewMarker, SubscriptionsKey>> = {
  'window0-tracking-start': 'usageMarkerWindow0TrackingStart',
  'window0-cleared': 'usageMarkerWindow0Cleared',
  'window0-pending': 'usageMarkerWindow0Pending',
  'since-first-observed': 'usageMarkerSinceFirstObserved',
  'since-tracking': 'usageMarkerSinceTracking',
  'since-cleared': 'usageMarkerSinceCleared',
  'ended-early': 'usageMarkerEndedEarly',
  'ended-early-later-usage': 'usageMarkerEndedEarlyLaterUsage',
  'reset-not-reported': 'usageMarkerResetNotReported',
  'boundaries-unknown': 'usageMarkerBoundariesUnknown',
}

const KIND_KEYS: Readonly<Record<KindOption['kind'], SubscriptionsKey>> = {
  '5h': 'usageSession',
  weekly: 'usageWeekly',
  monthly: 'usageMonthly',
  pending: 'usageNotObservedYet',
}

/** A token count in the browser locale. */
export function formatTokens(count: number): string {
  return count.toLocaleString()
}

/** An absolute instant in the browser locale. */
export function formatInstant(at: number): string {
  return new Date(at).toLocaleString()
}

/** "5-hour window", "Weekly · Opus", "Not observed yet". */
export function kindLabel(t: Translate, option: KindOption): string {
  const base = t(KIND_KEYS[option.kind])
  return option.scope === undefined ? base : `${base} · ${option.scope}`
}

/** A stable `<select>` value for a kind option. */
export function kindValue(option: KindOption): string {
  return option.scope === undefined ? option.kind : `${option.kind}\u0000${option.scope}`
}

export function parseKindValue(value: string): KindOption {
  const [kind, scope] = value.split('\u0000') as [KindOption['kind'], string | undefined]
  return scope === undefined ? { kind } : { kind, scope }
}

/** The window's start and end, or "from" when its end is not known yet. */
export function windowRangeText(t: Translate, window: { countedFrom: number, end?: number }): string {
  const start = formatInstant(window.countedFrom)
  return window.end === undefined ? t('usageRangeOpen', { start }) : t('usageRange', { start, end: formatInstant(window.end) })
}
