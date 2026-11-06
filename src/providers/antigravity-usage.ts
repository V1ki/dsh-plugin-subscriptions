/** Parse the provider's shared quota windows; never infer them from equal model percentages. */
import { antigravityQuotaScope } from '../antigravity-model-id.js'
import type { UsageWindow } from './common.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function parseAntigravityQuotaSummary(payload: unknown): UsageWindow[] {
  const groups = record(payload)?.groups
  if (!Array.isArray(groups)) return []
  const windows: UsageWindow[] = []
  for (const value of groups) {
    const group = record(value)
    const name = group?.displayName ?? group?.display_name
    const scope = antigravityQuotaScope(typeof name === 'string' ? name : undefined)
    if (!scope || !Array.isArray(group?.buckets)) continue
    for (const value of group.buckets) {
      const bucket = record(value)
      if (!bucket) continue
      const raw = bucket.remainingFraction ?? bucket.remaining_fraction
      const fraction = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim()
        ? (raw.trim().endsWith('%') ? Number(raw.trim().slice(0, -1)) / 100 : Number(raw)) : NaN
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue
      const label = [bucket.window, bucket.displayName, bucket.display_name, bucket.description].filter(value => typeof value === 'string').join(' ').toLowerCase()
      const kind = /week|7[ _-]?(?:day|d)\b/.test(label) ? 'weekly'
        : /(?:5|five)[ _-]?(?:hour|h)\b/.test(label) ? 'session' : undefined
      if (!kind) continue
      const reset = bucket.resetTime ?? bucket.reset_time
      const resetsAt = typeof reset === 'string' ? Date.parse(reset) : NaN
      windows.push({ kind, scope, usedPercent: (1 - fraction) * 100,
        ...Number.isFinite(resetsAt) ? { resetsAt } : {},
      })
    }
  }
  return windows
}
