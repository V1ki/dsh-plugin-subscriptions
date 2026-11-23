import type { TrackedProvider } from '../usage/usage-schema.js'
import type { DashboardDailyBucket } from '../usage/usage-dashboard.js'
import type { KindOption, ViewMarker } from '../usage/window-view.js'
import type { SubscriptionsKey } from './locales.js'

export type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Display metadata for the four usage-tracked subscription providers. */
export const TRACKED_PROVIDERS: readonly { id: TrackedProvider; name: string; colorVar: string }[] = [
  { id: 'codex', name: 'Codex', colorVar: 'var(--dsh-provider-codex, #10a37f)' },
  { id: 'claude', name: 'Claude', colorVar: 'var(--dsh-provider-claude, #d97757)' },
  { id: 'grok', name: 'Grok', colorVar: 'var(--dsh-provider-grok, #7c6cff)' },
  { id: 'antigravity', name: 'Antigravity', colorVar: 'var(--dsh-provider-antigravity, #3b82f6)' },
]

export function providerDisplayName(provider: TrackedProvider): string {
  return TRACKED_PROVIDERS.find(entry => entry.id === provider)?.name ?? provider
}

export function providerAccentColor(provider: TrackedProvider): string {
  return TRACKED_PROVIDERS.find(entry => entry.id === provider)?.colorVar ?? 'var(--dsw-alias-state-business-primary, #3b82f6)'
}

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
  return Math.round(count).toLocaleString()
}

/** Compact human-readable token count (e.g. `12.4K`, `1.85M`, `2.3B`). */
export function formatCompactTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) {
    const val = count / 1_000
    return `${val >= 100 ? Math.round(val) : Number(val.toFixed(1))}K`
  }
  if (count < 1_000_000_000) {
    const val = count / 1_000_000
    return `${val >= 100 ? Math.round(val) : Number(val.toFixed(val >= 10 ? 1 : 2))}M`
  }
  const val = count / 1_000_000_000
  return `${val >= 100 ? Math.round(val) : Number(val.toFixed(2))}B`
}

/** Share percentage string (`0%`, `<0.1%`, `12.4%`, `100%`). */
export function formatPercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  const pct = share * 100
  if (pct < 0.1) return '<0.1%'
  if (pct >= 99.95) return '100%'
  return `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(1)}%`
}

/** An absolute instant in the browser locale. */
export function formatInstant(at: number): string {
  return new Date(at).toLocaleString()
}

/** Short UTC date label like `Nov 23` from a `YYYY-MM-DD` string. */
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export function formatShortUtcDate(isoDate: string): string {
  const parts = isoDate.split('-')
  if (parts.length !== 3) return isoDate
  const month = Number(parts[1]) - 1
  const day = Number(parts[2])
  if (month < 0 || month > 11 || !Number.isFinite(day)) return isoDate
  return `${SHORT_MONTHS[month]} ${day}`
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

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatUtcMdHm(ts: number): { date: string; time: string } {
  const d = new Date(ts)
  return {
    date: `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    time: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
  }
}

/** Compact, scannable UTC cycle range like `11-22 14:00 – 19:00 UTC` or `11-16 00:00 – 11-23 00:00 UTC`. */
export function formatCycleTimeRange(
  t: Translate,
  cycle: { startsAt?: number; countedFrom: number; endsAt?: number },
): string {
  const startTs = cycle.startsAt ?? cycle.countedFrom
  const start = formatUtcMdHm(startTs)
  if (cycle.endsAt === undefined) {
    return t('usageRangeOpen', { start: `${start.date} ${start.time} UTC` })
  }
  const end = formatUtcMdHm(cycle.endsAt)
  if (start.date === end.date) {
    return `${start.date} ${start.time} – ${end.time} UTC`
  }
  return `${start.date} ${start.time} – ${end.date} ${end.time} UTC`
}

/** Compact relative duration like `3d 4h`, `2h 15m`, `45m`, `<1m`. */
export function formatRelativeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '<1m'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return '<1m'
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** Semantic severity tone for quota percentage consumption. */
export function quotaProgressTone(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** Compact UTC axis label for a quota cycle (`11-22 14h` for 5h windows, `11-16` for weekly/monthly). */
export function formatCycleAxisLabel(cycle: { kind: KindOption['kind']; startsAt?: number; countedFrom: number }): string {
  const ts = cycle.startsAt ?? cycle.countedFrom
  const d = new Date(ts)
  const md = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  if (cycle.kind === '5h') {
    return `${md} ${pad2(d.getUTCHours())}h`
  }
  return md
}

/** Compute 4–5 clean rounded Y-axis ticks from 0 to >= maxValue. */
export function computeNiceTicks(maxValue: number, segments = 4): number[] {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return [0, 1]
  const rawStep = maxValue / segments
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const residual = rawStep / magnitude
  const niceFactor = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10
  const step = niceFactor * magnitude
  const top = Math.ceil(maxValue / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step * 0.001; v += step) {
    ticks.push(Math.round(v))
  }
  return ticks
}

/** Classify a day's token count into a 0..4 heatmap intensity level using sqrt scaling so moderate days remain distinct. */
export function heatmapLevel(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(tokens) || tokens <= 0 || maxTokens <= 0) return 0
  const ratio = Math.sqrt(tokens / maxTokens)
  if (ratio < 0.28) return 1
  if (ratio < 0.54) return 2
  if (ratio < 0.78) return 3
  return 4
}

export interface HeatmapCell {
  date?: string
  bucket?: DashboardDailyBucket
  level: 0 | 1 | 2 | 3 | 4
}

export interface HeatmapGrid {
  weeks: HeatmapCell[][]
  monthLabels: { col: number; label: string }[]
  maxTokens: number
}

/** Arrange chronological UTC daily buckets into Sun..Sat week columns for a GitHub-style calendar heatmap. */
export function buildHeatmapWeeks(days: readonly DashboardDailyBucket[]): HeatmapGrid {
  if (days.length === 0) return { weeks: [], monthLabels: [], maxTokens: 0 }
  let maxTokens = 0
  for (const day of days) {
    if (day.totalTokens > maxTokens) maxTokens = day.totalTokens
  }
  const firstParts = days[0].date.split('-').map(Number)
  const firstDow = firstParts.length === 3
    ? new Date(Date.UTC(firstParts[0], firstParts[1] - 1, firstParts[2])).getUTCDay()
    : 0
  const weeks: HeatmapCell[][] = []
  let currentWeek: HeatmapCell[] = []
  for (let pad = 0; pad < firstDow; pad++) {
    currentWeek.push({ level: 0 })
  }
  for (const bucket of days) {
    currentWeek.push({
      date: bucket.date,
      bucket,
      level: heatmapLevel(bucket.totalTokens, maxTokens),
    })
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push({ level: 0 })
    weeks.push(currentWeek)
  }

  const monthLabels: { col: number; label: string }[] = []
  let lastMonth = -1
  for (let col = 0; col < weeks.length; col++) {
    const firstDated = weeks[col].find(cell => cell.date !== undefined)
    if (!firstDated?.date) continue
    const month = Number(firstDated.date.split('-')[1]) - 1
    if (month !== lastMonth && month >= 0 && month < 12) {
      const prev = monthLabels[monthLabels.length - 1]
      if (prev !== undefined && col - prev.col < 3) {
        // Replace a 1-2 week leading partial month at col 0 with the full incoming month.
        if (prev.col === 0) {
          monthLabels[monthLabels.length - 1] = { col, label: SHORT_MONTHS[month] }
        }
      } else {
        monthLabels.push({ col, label: SHORT_MONTHS[month] })
      }
      lastMonth = month
    }
  }
  return { weeks, monthLabels, maxTokens }
}
