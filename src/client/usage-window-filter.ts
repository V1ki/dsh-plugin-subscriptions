import type { SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'

/** Matches Antigravity group scopes (or legacy model IDs) against the active visible models set. */
export function antigravityScopeMatches(scope: string | undefined, selected: Set<string>): boolean {
  if (!scope) return true
  if (selected.has(scope)) return true
  if (scope.includes(' ')) {
    const s = scope.toLowerCase()
    if (s.includes('argon')) {
      return [...selected].some(m => m.includes('argon'))
    }
    if (s.includes('gemini')) {
      return [...selected].some(m => m.startsWith('gemini-') && !m.includes('argon'))
    }
    const matchClaude = s.includes('claude') && [...selected].some(m => m.startsWith('claude-'))
    const matchGpt = s.includes('gpt') && [...selected].some(m => m.startsWith('gpt-'))
    if (s.includes('claude') || s.includes('gpt')) {
      return matchClaude || matchGpt
    }
  }
  return false
}

/** Presentation only: never trim the raw snapshots used by quota/routing logic. */
export function visibleUsageWindows(
  provider: SubscriptionProvider,
  windows: UsageWindow[] | undefined,
  visibleModels: readonly string[] | undefined,
): UsageWindow[] {
  const all = windows ?? []
  if (provider !== 'antigravity' || visibleModels === undefined) return all
  const selected = new Set(visibleModels)
  return all.filter(window => !window.scope || antigravityScopeMatches(window.scope, selected))
}
