/**
 * The single snapshot hook of the usage window tracker.
 *
 * Wrap the Settings fetcher table (also used by the Codex pool) so only a
 * completed provider fetch is observed. The other pool fetchers report
 * separately, preserving their existing timeout and account lookup.
 */
import type { ProviderId } from '../auth/store.js'
import { errorMessage } from '../http.js'
import type { ProviderUsage } from '../providers/common.js'

export type UsageFetcher = (account: string, signal: AbortSignal) => Promise<ProviderUsage>
/** Per-provider per-account usage lookup; providers without a usage endpoint (copilot) are absent. */
export type UsageFetchers = Partial<Record<ProviderId, UsageFetcher>>
export type SnapshotObserver = (provider: ProviderId, account: string, snapshot: ProviderUsage, completedAt: number) => void

/**
 * Wrap every present fetcher of `fetchers` in place so each successful fetch
 * is reported to `observe` after it completes. A failed fetch is not
 * reported. An observer exception goes to `onWarn` and never reaches the
 * fetch caller, which always receives the fetcher's own snapshot.
 * Call it once per table: a second call wraps the wrappers, and every fetch
 * would then be observed twice.
 * @returns the same `fetchers` object.
 */
export function observeUsageFetchers(
  fetchers: UsageFetchers,
  observe: SnapshotObserver,
  onWarn: (message: string) => void = () => undefined,
  now: () => number = Date.now,
): UsageFetchers {
  for (const provider of Object.keys(fetchers) as ProviderId[]) {
    const fetcher = fetchers[provider]
    if (fetcher === undefined) continue
    fetchers[provider] = async (account, signal) => {
      const snapshot = await fetcher(account, signal)
      try {
        observe(provider, account, snapshot, now())
      } catch (error) {
        onWarn(`usage window tracking failed for ${provider}: ${errorMessage(error)}`)
      }
      return snapshot
    }
  }
  return fetchers
}
