/**
 * Refresh scheduling for the composer usage badge: decides whether a request
 * starts a round, joins the one in flight, or queues one forced round, and
 * whether a click may bypass the server's shared usage cache.
 *
 * Kept free of React and RPC so the policy is testable with a fake clock; the
 * badge owns the round itself (what a "refresh" fetches and renders).
 */
import { messageOf } from './subscriptions-rpc.js'

/** Feature constants for click-to-refresh. */
export const USAGE_REFRESH = {
  /**
   * Least time between two forced (cache-bypassing) rounds, measured from
   * the start of the previous forced round. A forced round asks every
   * logged-in account's provider for a fresh snapshot, so repeated clicks
   * inside this interval re-read the shared cache that the previous forced
   * round just refreshed instead of hitting the providers again. Claude's
   * usage endpoint rate-limits progressively (each hit in the window pushes
   * `retry-after` further out, see pool-usage.ts), so the floor stays well
   * above a double-click; it is far below the server's 5-minute TTL, which
   * keeps a click useful. Revisit if a provider documents its own limit.
   */
  MIN_FORCED_INTERVAL_MS: 60_000,
} as const

/** One refresh round; `force` true bypasses the server's fresh cache. */
export type UsageRefreshRun = (force: boolean) => Promise<void>

/** The round currently running. */
interface Round {
  force: boolean
  promise: Promise<void>
}

/** Swallow a settled round's outcome when only its completion matters. */
const ignore = (): void => {}

/**
 * Serializes refresh rounds. At most one round runs; requests made while it
 * runs join it, except that a click arriving during a plain (poll) round,
 * when forcing is allowed, queues exactly one forced round after it, which
 * later clicks join. A rejected round rejects only its own callers.
 */
export class UsageRefreshGate {
  private current: Round | undefined
  private queued: Promise<void> | undefined
  private lastForcedAt: number | undefined

  /**
   * @param run - performs one round.
   * @param now - clock in epoch ms (injected for tests).
   * @param minForcedIntervalMs - least time between forced round starts.
   */
  constructor(
    private readonly run: UsageRefreshRun,
    private readonly now: () => number = Date.now,
    private readonly minForcedIntervalMs: number = USAGE_REFRESH.MIN_FORCED_INTERVAL_MS,
  ) {}

  /**
   * Request a refresh.
   * @param wantForce - true for a user click, false for polls and reads.
   * @returns resolves when the round this request started or joined completes.
   */
  request(wantForce: boolean): Promise<void> {
    if (this.queued !== undefined) return this.queued
    const force = wantForce && this.forceAllowed()
    if (this.current === undefined) return this.start(force)
    if (!force || this.current.force) return this.current.promise
    this.queued = this.current.promise.then(ignore, ignore).then(() => {
      this.queued = undefined
      return this.start(true)
    })
    return this.queued
  }

  private forceAllowed(): boolean {
    return this.lastForcedAt === undefined || this.now() - this.lastForcedAt >= this.minForcedIntervalMs
  }

  private start(force: boolean): Promise<void> {
    if (force) this.lastForcedAt = this.now()
    const promise = this.run(force).finally(() => { this.current = undefined })
    this.current = { force, promise }
    return promise
  }
}

/**
 * The failure message of one round's per-account usage results.
 * @param results - settled `usage` calls of one round.
 * @returns the first rejection's message, or undefined when all fulfilled.
 */
export function usageRefreshFailure(results: readonly PromiseSettledResult<unknown>[]): string | undefined {
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  return failed === undefined ? undefined : messageOf(failed.reason)
}
