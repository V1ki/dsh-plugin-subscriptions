import type { SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'

/** Presentation only: never trim the raw snapshots used by quota/routing logic. */
export function visibleUsageWindows(
  provider: SubscriptionProvider,
  windows: UsageWindow[] | undefined,
  visibleModels: readonly string[] | undefined,
): UsageWindow[] {
  const all = windows ?? []
  // Other providers may scope quotas by family rather than exact model ID.
  if (provider !== 'antigravity' || visibleModels === undefined) return all
  const selected = new Set(visibleModels)
  return all.filter(window => !window.scope || selected.has(window.scope))
}
