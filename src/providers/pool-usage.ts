/**
 * Quota tracking for pool members: polls the providers' usage endpoints
 * (the same normalized `ProviderUsage` shape the Settings page consumes) and
 * turns the windows into a scheduling score.
 *
 * The score is a REQUIRED BURN RATE: the fraction of the window that must be
 * consumed per millisecond for the quota to be exactly used up at reset time
 * (`remaining / timeUntilReset`). Subscription quota does not roll over, so a
 * window about to reset with plenty left is the most urgent to spend — the
 * `quota_aware` strategy therefore prefers the highest-urgency member, which
 * over time converges on every window hitting zero right at its reset.
 */
import { antigravityQuotaApplies } from '../antigravity-model-id.js'

import { isMissingOrInvalidCredential, OAuthEndpointError } from './common.js'
import type { ProviderUsage, UsageWindow } from './common.js'
import type { ProviderId } from '../auth/store.js'
import type { ConcretePoolMember } from './pool-family.js'

/** Near-full members are tried only after members below this fill level. */
export const QUOTA_FULL_PERCENT = 95
/** Exhausted subscription windows must not silently spill over into paid credits. */
export const QUOTA_EXHAUSTED_PERCENT = 100
/** How long a usage snapshot is trusted before a background refresh. */
export const USAGE_TTL_MS = 5 * 60_000

/** Assumed window length when the provider discloses no `resetsAt`. */
const FALLBACK_HORIZON_MS: Record<UsageWindow['kind'], number> = {
  session: 5 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  other: 30 * 24 * 60 * 60_000,
}

/** The scheduling view of one member's quota. */
export interface MemberQuota {
  /** False when a window is near-full or the login is gone. */
  available: boolean
  /** A known exhausted window: exclude even if the upstream would accept paid credits. */
  exhausted?: true
  /** Burn rate in strategy-specific units; 0 when unmeasured. */
  urgency: number
  /** Epoch ms of the snapshot this was computed from; 0 when none. */
  fetchedAt: number
}

/** A successful snapshot, cached until `ttlMs` (or the entry's own `cooldownMs`) elapses. */
interface SnapshotEntry {
  snapshot: ProviderUsage
  error?: undefined
  at: number
  cooldownMs?: undefined
}

/**
 * A cached fetch failure — the negative-cache counterpart of {@link SnapshotEntry}.
 * Without this, a failing endpoint (a 429, a timeout) is retried on every
 * single `quotaFor`/`snapshotFor` call, since nothing about a rejected
 * promise ever reached `entries`. For an endpoint that rate-limits
 * progressively (each hit within the window pushes the next one further
 * out), that retry storm is a permanent lockout, not a transient blip.
 *
 * `lastSnapshot` carries forward the most recent successful fetch, when one
 * exists, so a member/display that was showing real data before this
 * failure keeps showing it (stale, but not blank) through the cooldown
 * instead of falling back to the zero-urgency/no-data degraded state.
 */
interface FailureEntry {
  snapshot?: undefined
  error: unknown
  at: number
  /** Overrides `ttlMs` — the endpoint's own `retry-after` when it sent one. */
  cooldownMs: number
  /** The last successful snapshot before this failure, when one exists. */
  lastSnapshot?: ProviderUsage
}

type CacheEntry = SnapshotEntry | FailureEntry

/**
 * Per-ACCOUNT usage snapshots with in-flight dedupe and
 * stale-while-revalidate refresh. Providers without a usage endpoint
 * (copilot) resolve no fetcher and score a constant zero urgency — which
 * naturally ranks them behind every measured member. Fetchers are resolved
 * lazily per (provider, account) so accounts added after startup join
 * tracking on their first score.
 */
export class PoolUsageTracker {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<ProviderUsage>>()

  constructor(
    private readonly fetcherFor: (provider: ProviderId, account: string) => (() => Promise<ProviderUsage>) | undefined,
    private readonly ttlMs = USAGE_TTL_MS,
  ) {}

  /**
   * The quota view of one member. A cold cache awaits the first fetch; a
   * stale non-exhausted snapshot answers immediately while refreshing in the
   * background. Exhausted snapshots await their expired-cache refresh so a
   * reset can restore routing on this call. A live failure cooldown never
   * triggers another fetch.
   *
   * Failures discard stale urgency but preserve known exhaustion: an outage
   * must not turn a blocked subscription into permission to spend credits.
   * Only a successful usage lookup (or explicit invalidation) clears it.
   * @param member - the pool member to score (account resolved).
   * @returns availability plus the urgency score.
   */
  async quotaFor(member: ConcretePoolMember, normalized = false): Promise<MemberQuota> {
    const key = `${member.provider}/${member.account}`
    const fetcher = this.fetcherFor(member.provider, member.account)
    if (fetcher === undefined) return { available: true, urgency: 0, fetchedAt: 0 }
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      const fresh = Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs)
      if (entry.snapshot !== undefined) {
        const quota = this.score(member, entry, normalized)
        if (fresh) return quota
        if (!quota.exhausted && entry.at !== Number.NEGATIVE_INFINITY) {
          void this.refresh(key, fetcher).catch(() => undefined)
          return quota
        }
        // A reset may have restored the subscription since the last lookup.
      } else if (fresh) {
        return this.failedQuota(member, entry.error, entry.lastSnapshot)
      }
      // The cooldown expired: fall through to a fresh, blocking attempt.
    }
    try {
      const snapshot = await this.refresh(key, fetcher)
      return this.score(member, { snapshot, at: Date.now() }, normalized)
    } catch (error: unknown) {
      return this.failedQuota(member, error, entry?.snapshot ?? entry?.lastSnapshot)
    }
  }

  /** Keep a known credit-spending risk blocked through usage-endpoint failures. */
  private failedQuota(member: ConcretePoolMember, error: unknown, snapshot?: ProviderUsage): MemberQuota {
    const degraded = degradedQuota(error)
    if (snapshot !== undefined && this.score(member, { snapshot, at: 0 }).exhausted) {
      return { ...degraded, available: false, exhausted: true }
    }
    return degraded
  }

  /**
   * Same cache as {@link quotaFor}, for direct display (the Settings page):
   * the raw snapshot, or the original fetch error, instead of a routing
   * score.
   * @param provider - the account's provider.
   * @param account - the account key.
   * @param force - bypass a fresh cached SNAPSHOT for an honest re-check (the
   *   manual Refresh button). A live failure cooldown is never bypassed —
   *   retrying through it is exactly what turns a 429 into a permanent
   *   lockout, so even a forced call still answers from the negative cache.
   * @returns `{ supported: false }` when the provider has no usage fetcher.
   */
  async snapshotFor(provider: ProviderId, account: string, force = false): Promise<ProviderUsage> {
    const fetcher = this.fetcherFor(provider, account)
    if (fetcher === undefined) return { supported: false }
    const key = `${provider}/${account}`
    const entry = this.entries.get(key)
    if (entry !== undefined && Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs)) {
      if (entry.snapshot !== undefined) {
        if (!force) return entry.snapshot
      } else if (entry.lastSnapshot !== undefined) {
        // A stale-but-real snapshot beats surfacing the cooldown error to
        // every display surface — this is what was previously showing, so
        // keep showing it (even through a forced refresh: retrying past the
        // cooldown is exactly the retry storm `cooldownMs` exists to avoid).
        return entry.lastSnapshot
      } else {
        throw entry.error
      }
    }
    try {
      return await this.refresh(key, fetcher)
    } catch (error: unknown) {
      // Same fallback as the already-cooling-down branch above, for the
      // fetch that just failed on THIS call: `refresh` recorded whatever
      // snapshot was on record before it ran onto the new failure entry.
      const failed = this.entries.get(key)
      if (failed?.snapshot === undefined && failed?.lastSnapshot !== undefined) return failed.lastSnapshot
      throw error
    }
  }

  /** Recheck after an inference quota failure without erasing another model lane's exhaustion. */
  expire(provider: ProviderId, account: string): void {
    const key = `${provider}/${account}`
    const entry = this.entries.get(key)
    // Respect a usage-endpoint cooldown; inference errors do not lift it.
    if (entry?.snapshot !== undefined) this.entries.set(key, { ...entry, at: Number.NEGATIVE_INFINITY })
  }

  /** Drop cached snapshots: one account, or a whole provider when `account` is omitted. */
  invalidate(provider: ProviderId, account?: string): void {
    if (account !== undefined) {
      this.entries.delete(`${provider}/${account}`)
      return
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${provider}/`)) this.entries.delete(key)
    }
  }

  /**
   * Run (or join) the single in-flight fetch for one account key, caching
   * either outcome. A missing/invalid credential is deliberately NOT
   * negative-cached: it costs no network round trip (the session lookup
   * fails before the request goes out) and re-checking live means the
   * member rejoins routing the instant its login is fixed, rather than
   * waiting out a stale cooldown.
   */
  private refresh(key: string, fetcher: () => Promise<ProviderUsage>): Promise<ProviderUsage> {
    let pending = this.inflight.get(key)
    if (pending === undefined) {
      // Captured before the fetch starts: whichever real snapshot is on
      // record right now is what a failure below should fall back to. A
      // failure entry's own `lastSnapshot` counts too — otherwise the stale
      // snapshot would survive exactly one cooldown and vanish on the next
      // consecutive failure, even though nothing newer ever replaced it.
      const prior = this.entries.get(key)
      const lastSnapshot = prior?.snapshot ?? prior?.lastSnapshot
      pending = fetcher().then(
        (snapshot) => {
          this.entries.set(key, { snapshot, at: Date.now() })
          return snapshot
        },
        (error: unknown) => {
          if (!isMissingOrInvalidCredential(error)) {
            this.entries.set(key, {
              error,
              at: Date.now(),
              cooldownMs: cooldownFor(error, this.ttlMs),
              ...lastSnapshot === undefined ? {} : { lastSnapshot },
            })
          }
          throw error
        },
      ).finally(() => {
        this.inflight.delete(key)
      })
      this.inflight.set(key, pending)
    }
    return pending
  }

  /** Score one member against a snapshot's windows. */
  private score(member: ConcretePoolMember, entry: SnapshotEntry, normalized = false): MemberQuota {
    const windows = (entry.snapshot.windows ?? []).filter(window => windowApplies(window, member.model, member.provider))
    let available = true
    let urgency = 0
    for (const window of windows) {
      if (window.usedPercent >= QUOTA_FULL_PERCENT) available = false
      urgency = Math.max(urgency, normalized ? normalizedWindowUrgency(window, Date.now()) : windowUrgency(window))
    }
    const exhausted = windows.some(window => window.usedPercent >= QUOTA_EXHAUSTED_PERCENT)
    return { available, urgency, fetchedAt: entry.at, ...exhausted ? { exhausted: true as const } : {} }
  }
}

/**
 * The routing view of a fetch failure. Logged out: the member cannot serve
 * at all. Any other failure (network, endpoint rate limit) must not block
 * routing — the member stays available with a zero score, degrading the
 * strategy to plain priority order for it.
 */
function degradedQuota(error: unknown): MemberQuota {
  return isMissingOrInvalidCredential(error)
    ? { available: false, urgency: 0, fetchedAt: 0 }
    : { available: true, urgency: 0, fetchedAt: 0 }
}

/** How long to hold a failure in the negative cache: the endpoint's own `retry-after`, or the default TTL. */
function cooldownFor(error: unknown, defaultTtlMs: number): number {
  return error instanceof OAuthEndpointError && error.retryAfterMs !== undefined ? error.retryAfterMs : defaultTtlMs
}

/**
 * Whether a window constrains this model: unscoped windows always do; a
 * model-scoped window (Claude's Opus/Sonnet lanes) applies when its scope
 * names the model family.
 */
function windowApplies(window: UsageWindow, model: string, provider: ProviderId): boolean {
  if (window.scope === undefined) return true
  if (provider === 'antigravity' && antigravityQuotaApplies(window.scope, model)) return true
  return model.toLowerCase().includes(window.scope.toLowerCase())
}

/** Dimensionless urgency for the opt-in strategy. Missing timing adds no reset bonus. */
export function normalizedWindowUrgency(window: UsageWindow, now: number): number {
  const remaining = Math.max(0, Math.min(1, 1 - window.usedPercent / 100))
  const { durationMs, resetsAt } = window
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0
    || resetsAt === undefined || !Number.isFinite(resetsAt)) return remaining
  const timeFraction = Math.min(1, Math.max(0.001, (resetsAt - now) / durationMs))
  return remaining / timeFraction
}

/** The required burn rate of one window (fraction per ms). */
function windowUrgency(window: UsageWindow, now = Date.now()): number {
  const remaining = Math.max(0, 1 - window.usedPercent / 100)
  const horizon = window.resetsAt !== undefined
    ? Math.max(window.resetsAt - now, 1)
    : FALLBACK_HORIZON_MS[window.kind]
  return remaining / horizon
}
