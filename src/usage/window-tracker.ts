/**
 * The usage window tracker turns observed quota snapshots
 * into window boundaries and places finished requests' token counts into
 * one aggregate entry per account, window kind and scope.
 *
 * The tracker is pure and synchronous. It owns no clock, timer, file or
 * network access: every method takes the instant it applies at, and the
 * caller supplies it. The store handles persistence. Entries leave memory through
 * {@link WindowTracker.drainClosed}.
 *
 * Model of one account:
 * - Before the account's first snapshot its kinds are unknown, so counts go
 *   to one account-level Window 0 of kind `pending`.
 * - Each reported window is a *series*, keyed by the provider's own kind and
 *   scope, because an `other` window's tracker kind can change once its
 *   observed length classifies it while it stays the same window.
 * - A series is first *unanchored*: counts go to its Window 0. It anchors at
 *   the first snapshot that reports a reset and a start from rules 1–3, or
 *   at the first reported reset R1 when no start is derivable. From then on
 *   it always has an open real entry, except after a chained entry with no
 *   reported reset has outlived its length: then counts are held
 *   until the next snapshot opens a window.
 */
import { errorMessage } from '../http.js'
import type { ProviderUsage, UsageWindow } from '../providers/common.js'
import { matchesWindow } from '../providers/codex.js'
import { windowApplies } from '../providers/pool-usage.js'
import {
  DISCLOSED_START_SOURCE, NOMINAL_LENGTH_MS, REDEMPTION_RESET_KINDS, REPORTED_KIND, RESET_MATCH_TOLERANCE_MS,
  USAGE_TRACKED_PROVIDERS, WINDOW_LENGTH_MS, type TrackedProvider, type WindowKind,
} from './constants.js'

export type { TrackedProvider, WindowKind } from './constants.js'

/** A Window 0 before the account's first snapshot has no kind yet. */
export type EntryKind = WindowKind | 'pending'

/**
 * Where an entry's `startsAt` came from. The common sources are
 * `disclosed`, `length`, `nominal` and `previous-reset`; `redemption` is an
 * exact in-plugin credit redemption; `first-usage` marks Window 0; and
 * `observed` means no rule gave a start, so the window starts at the
 * observation that opened it (a fallback after an early reset).
 */
export type StartSource = 'disclosed' | 'length' | 'nominal' | 'previous-reset' | 'redemption' | 'first-usage' | 'observed'

/** Disjoint token buckets of one model; the two cache-write durations are subsets of `cacheWriteTokens`. */
export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
}

/** The disjoint buckets every model sum has; exported so the store sums and validates the same set. */
export const REQUIRED_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
/** The cache-write duration subsets of `cacheWriteTokens`, Claude only. */
export const SPLIT_BUCKETS = ['cacheWrite5mTokens', 'cacheWrite1hTokens'] as const

/** One aggregate window entry. */
export interface WindowUsageEntry {
  v: 1
  /** Fixed when the entry is created, unique, and kept through reclassification. */
  id: string
  provider: TrackedProvider
  account: string
  kind: EntryKind
  /** Set only on Window 0 entries. */
  window0?: 'tracking-start' | 'cleared'
  scope?: string
  /** Absent on Window 0. */
  startsAt?: number
  startSource: StartSource
  /** Latest observed reset; absent while a chained window's reset is not reported ("boundaries not known yet"). */
  resetsAt?: number
  /** Minimum and maximum observed reset, so a later tolerance can re-merge entries on read. */
  resetRange?: [number, number]
  status: 'open' | 'closed' | 'ended-early'
  /** Set on ended-early entries, a closed Window 0, and a chained entry closed at its start + length. */
  endedAt?: number
  /** Ended-early only: `detected` from a snapshot or an exact `redemption` (no note). */
  endReason?: 'detected' | 'redemption'
  countedFrom: number
  lastAddedAt?: number
  models: Record<string, TokenCounts>
  /** Actual UTC dates of recorded requests; legacy entries need not have any. */
  days?: Record<string, Record<string, TokenCounts>>
}

/** What the latest snapshot said about one series, for the view. */
export interface ObservedWindow {
  kind: WindowKind
  scope?: string
  /** False shows "reset time not reported". */
  resetReported: boolean
  /** The disclosed or nominal length, when known. */
  lengthMs?: number
}

/** Counts held for a series between a stale chained entry and the next snapshot. */
export interface HeldSum {
  kind: WindowKind
  scope?: string
  countedFrom: number
  lastAddedAt: number
  models: Record<string, TokenCounts>
  /** Actual UTC dates of recorded requests; legacy entries need not have any. */
  days?: Record<string, Record<string, TokenCounts>>
}

/** One reported window of one account, followed across snapshots. Exported as a type so the store can validate restored state. */
export interface SeriesState {
  /** {@link seriesKey}: the provider's kind and scope; the identity of one reported window across snapshots. */
  key: string
  kind: WindowKind
  scope?: string
  resetReported: boolean
  /** The disclosed or nominal length; an observed reset-to-reset length is not used for it. */
  lengthMs?: number
  /** Last reported reset, for classifying an `other` window by its observed length. */
  lastReset?: number
  /** A start-less series anchors when this first observed reset is reached (R1). */
  pendingR1?: number
  anchored: boolean
  /**
   * First observation of a series that appeared after the account's first
   * snapshot. Its earlier requests were not counted for it, so its
   * first real entry may not claim to count from before this instant.
   */
  countFloor?: number
  window0?: string
  open?: string
  /** End of the last real entry, when the series has no open entry . */
  lastEnd?: number
  held?: Omit<HeldSum, 'kind' | 'scope'>
  /**
   * The account's latest snapshot did not report this window (a renamed
   * scope, a model dropped from Antigravity's list, a bucket a provider
   * omits for one fetch). It keeps counting into whatever target it already
   * has, its open entry, open Window 0 or held sum, until that ends, so a
   * one-fetch omission loses nothing; it creates nothing new: no chained
   * entry, Window 0, held sum or redemption split. It resumes by the normal rules when a later
   * snapshot reports it again.
   */
  absent?: true
  /**
   * A request applicable to this series was turned away while it was
   * absent with nothing to count into. The next entry it opens then counts
   * from its own opening observation, not from the previous end, so it
   * never claims coverage of requests it did not receive.
   */
  turnedAway?: true
  /**
   * Ids of the series' entries still in memory. While the series is
   * unclassified this also keeps drained ids, so the reclassification event
   * can name already saved entries, which become visible too.
   */
  entryIds: string[]
}

/** One account's tracker memory. Exported as a type so the store can validate restored state. */
export interface AccountState {
  provider: TrackedProvider
  account: string
  snapshotSeen: boolean
  pending?: string
  series: SeriesState[]
}

/** Serialisable tracker memory: what {@link WindowTracker.state} returns and the constructor restores. */
export interface TrackerState {
  v: 1
  /** Latest instant applied; absent before the first event (JSON has no -Infinity). */
  now?: number
  accounts: AccountState[]
  entries: WindowUsageEntry[]
}

/** A series classified after some of its entries were created: those entries now have `kind`. */
export interface Reclassification {
  provider: TrackedProvider
  account: string
  kind: WindowKind
  /** Every entry of the series, including ones already drained by {@link WindowTracker.drainClosed}. */
  ids: string[]
}

export interface WindowTrackerOptions {
  /** When tracking started; nothing earlier is counted or anchors a window. */
  trackingStartedAt: number
  /** Per-provider clear instants; nothing earlier is counted or anchors a window. */
  clearedAt?: Partial<Record<TrackedProvider, number>>
  state?: TrackerState
  /**
   * Called once each time an entry leaves `open`; the store saves at window close. Like `onReclassify`, it runs after the operation that caused it
   * has finished, so it may call back into the tracker; its errors go to
   * `onWarn` and never reach the tracker's caller.
   */
  onClose?: (entry: WindowUsageEntry) => void
  /** Called when a series is classified, naming its entries, drained ones included. */
  onReclassify?: (change: Reclassification) => void
  /** Rejected counts and callback errors. */
  onWarn?: (message: string) => void
}

interface Start {
  startsAt: number
  startSource: StartSource
}

/** Whether `provider` is one of the tracked subscription routes. */
export function isTrackedProvider(provider: string): provider is TrackedProvider {
  return (USAGE_TRACKED_PROVIDERS as readonly string[]).includes(provider)
}

/** Classify a window length (inclusive ranges); anything else is unclassified. */
export function classifyLength(lengthMs: number): WindowKind {
  if (matchesWindow(lengthMs, WINDOW_LENGTH_MS.fiveHour)) return '5h'
  if (matchesWindow(lengthMs, WINDOW_LENGTH_MS.weekly)) return 'weekly'
  if (lengthMs >= WINDOW_LENGTH_MS.monthlyMin && lengthMs <= WINDOW_LENGTH_MS.monthlyMax) return 'monthly'
  return 'unclassified'
}

/** Classify one reported window: `session` and `weekly` by name, `other` by its disclosed length. */
export function classifyWindow(window: UsageWindow): WindowKind {
  if (window.kind !== 'other') return REPORTED_KIND[window.kind]
  const length = validLength(window.durationMs)
  return length === undefined ? 'unclassified' : classifyLength(length)
}

function validLength(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Every bucket a non-negative safe integer; exported so the store can validate a usage chunk once. */
export function validCounts(counts: TokenCounts): boolean {
  const values = [
    ...REQUIRED_BUCKETS.map(bucket => counts[bucket]),
    ...SPLIT_BUCKETS.flatMap(bucket => counts[bucket] === undefined ? [] : [counts[bucket]]),
  ]
  return values.every(value => Number.isSafeInteger(value) && value >= 0)
}

/** All buckets zero: such a chunk adds nothing and creates no entry. */
export function emptyCounts(counts: TokenCounts): boolean {
  return REQUIRED_BUCKETS.every(bucket => counts[bucket] === 0)
    && SPLIT_BUCKETS.every(bucket => (counts[bucket] ?? 0) === 0)
}

function zeroCounts(): TokenCounts {
  return Object.fromEntries(REQUIRED_BUCKETS.map(bucket => [bucket, 0])) as Record<typeof REQUIRED_BUCKETS[number], number>
}

/** Whether adding `counts` to `models[model]` would pass `MAX_SAFE_INTEGER` in any bucket; exported for the before-tracking fold. */
export function overflows(models: Record<string, TokenCounts>, model: string, counts: TokenCounts): boolean {
  const sum = models[model]
  if (sum === undefined) return false
  return [...REQUIRED_BUCKETS, ...SPLIT_BUCKETS].some(bucket => !Number.isSafeInteger((sum[bucket] ?? 0) + (counts[bucket] ?? 0)))
}

/** Add `counts` into `models[model]` in place; exported for the before-tracking fold. */
export function addModel(models: Record<string, TokenCounts>, model: string, counts: TokenCounts): void {
  const sum = models[model] ?? zeroCounts()
  for (const bucket of REQUIRED_BUCKETS) sum[bucket] += counts[bucket]
  for (const bucket of SPLIT_BUCKETS) {
    const value = counts[bucket]
    if (value !== undefined) sum[bucket] = (sum[bucket] ?? 0) + value
  }
  models[model] = sum
}

/** Add every model sum of `from` (those `applies` accepts) into `models`, in place. */
export function addModels(models: Record<string, TokenCounts>, from: Record<string, TokenCounts>, applies: (model: string) => boolean = () => true): void {
  for (const [model, counts] of Object.entries(from)) if (applies(model)) addModel(models, model, counts)
}

/** A running sum one request is added to: an entry, or a series' held sum. */
type Sum = Pick<WindowUsageEntry, 'models' | 'lastAddedAt' | 'days'>

/** Where one request goes for one series; `id` is absent for a held sum, which is not an entry yet. */
interface Target {
  sum: Sum
  id?: string
}

/** Add one request's `counts` for `model`, finished at `at`, to `sum`. */
function addTo(sum: Sum, model: string, counts: TokenCounts, at: number, day: string | undefined): void {
  addModel(sum.models, model, counts)
  if (day !== undefined) addModel((sum.days ??= {})[day] ??= {}, model, counts)
  sum.lastAddedAt = at
}

export class WindowTracker {
  private now = Number.NEGATIVE_INFINITY
  private readonly accounts = new Map<string, AccountState>()
  private readonly entryById = new Map<string, WindowUsageEntry>()
  private readonly clearedAt: Partial<Record<TrackedProvider, number>>
  private readonly trackingStartedAt: number
  private readonly options: WindowTrackerOptions
  /**
   * Callbacks raised during an operation, run once it has finished. Running
   * them mid-transition would let a throwing or re-entrant callback leave a
   * series closed with no successor.
   */
  private readonly notifications: (() => void)[] = []
  private depth = 0

  constructor(options: WindowTrackerOptions) {
    this.options = options
    this.trackingStartedAt = options.trackingStartedAt
    this.clearedAt = { ...options.clearedAt }
    if (options.state !== undefined) {
      const state = structuredClone(options.state)
      if (state.now !== undefined) this.now = state.now
      for (const entry of state.entries) this.entryById.set(entry.id, entry)
      for (const account of state.accounts) this.accounts.set(accountKey(account.provider, account.account), account)
    }
  }

  /**
   * Record one completed usage fetch, observed at `observedAt` (the fetch
   * completion time). Opens, updates, chains or ends entries; never
   * throws for an untracked provider or an unsupported snapshot.
   */
  observe(provider: string, account: string, snapshot: ProviderUsage, observedAt: number): void {
    if (!this.admits(provider, observedAt)) return
    const windows = snapshot.windows ?? []
    if (!snapshot.supported || windows.length === 0) return
    this.operation(() => {
      const at = this.advanceTo(observedAt)
      const state = this.accountState(provider, account)
      const observed = this.matchSeries(state, windows).map(({ window, series }) => ({
        window, series: this.upsertSeries(state, window, series, at),
      }))
      const reported = new Set(observed.map(({ series }) => series))
      for (const series of state.series) {
        if (reported.has(series)) delete series.absent
        else series.absent = true
      }
      // A series reported again applies what came due while it was absent
      // (its R1, see `reachR1`) before this snapshot's reset replaces it.
      for (const series of reported) this.advanceSeries(state, series)
      if (!state.snapshotSeen) {
        state.snapshotSeen = true
        this.splitPending(state)
      }
      for (const { window, series } of observed) this.applyReset(state, series, window, at)
    })
  }

  /**
   * Add one finished request's counts for `model`, finished at `finishedAt`,
   * to every window of the account it applies to.
   * @returns the ids of the entries that received the counts; held counts
   *   and ignored requests return none.
   */
  add(provider: string, account: string, model: string, finishedAt: number, counts: TokenCounts): string[] {
    if (!this.admits(provider, finishedAt) || emptyCounts(counts)) return []
    if (!validCounts(counts)) {
      this.warn(`usage counts rejected for ${provider}/${model}: every bucket must be a non-negative safe integer`)
      return []
    }
    return this.operation(() => {
      // Time advances to `finishedAt` even when the chunk is then rejected
      // That is an observation of the clock, not of the chunk.
      const at = this.advanceTo(finishedAt)
      const state = this.accountState(provider, account)
      const date = new Date(finishedAt)
      const day = Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999
        ? date.toISOString().slice(0, 10) : undefined
      return state.snapshotSeen ? this.addToSeries(state, model, counts, at, day) : this.addToPending(state, model, counts, at, day)
    })
  }

  /**
   * A credit redeemed through the plugin at `at` (confirmed success only):
   * the account's open 5-hour and weekly entries end early, exactly, and new
   * entries open from `at`. An absent series
   * is skipped because it creates no new entry; its open entry keeps
   * counting, and the moved reset is applied by the snapshot rules
   * once the window is reported again.
   */
  redeem(provider: string, account: string, at: number): void {
    if (!this.admits(provider, at)) return
    this.operation(() => {
      const instant = this.advanceTo(at)
      const state = this.accounts.get(accountKey(provider, account))
      if (state === undefined) return
      for (const series of state.series) {
        const open = this.openEntry(series)
        if (open === undefined || series.absent === true || !REDEMPTION_RESET_KINDS.includes(series.kind)) continue
        this.endEarly(open, instant, 'redemption')
        this.openReal(state, series, { startsAt: instant, startSource: 'redemption' }, instant)
      }
    })
  }

  /**
   * Apply every transition due by `now`: resets reached (even with
   * no request), first resets R1 reached, and stale chained entries closed
   * at start + length. Called by every mutating method first; the store also calls
   * it from a timer so windows close on time without traffic.
   * @returns the instant applied (never earlier than one already applied).
   */
  advance(now: number): number {
    return this.operation(() => this.advanceTo(now))
  }

  /**
   * Forget one provider's memory after a clear at `clearedAt`; later Window
   * 0 are `cleared`. Notifications already queued for it are
   * still delivered; the store's `clearedAt` cut-off drops them.
   */
  clear(provider: string, clearedAt: number): void {
    if (!isTrackedProvider(provider)) return
    this.clearedAt[provider] = Math.max(this.clearedAt[provider] ?? Number.NEGATIVE_INFINITY, clearedAt)
    for (const [key, state] of this.accounts) if (state.provider === provider) this.accounts.delete(key)
    for (const [id, entry] of this.entryById) if (entry.provider === provider) this.entryById.delete(id)
  }

  /** Copies of the entries in memory (open and not yet drained), oldest `countedFrom` first. */
  entries(provider?: string, account?: string): WindowUsageEntry[] {
    return [...this.entryById.values()]
      .filter(entry => (provider === undefined || entry.provider === provider) && (account === undefined || entry.account === account))
      .sort((a, b) => a.countedFrom - b.countedFrom)
      .map(entry => structuredClone(entry))
  }

  /** The windows the account's latest snapshot reported, with what it said; stored entries of others stay in `entries`. */
  observedWindows(provider: string, account: string): ObservedWindow[] {
    return (this.accounts.get(accountKey(provider, account))?.series ?? []).filter(series => series.absent !== true).map(series => ({
      kind: series.kind,
      ...scopeField(series.scope),
      resetReported: series.resetReported,
      ...series.lengthMs === undefined ? {} : { lengthMs: series.lengthMs },
    }))
  }

  /** Counts held between a stale chained entry and the next snapshot. */
  heldSums(provider: string, account: string): HeldSum[] {
    return (this.accounts.get(accountKey(provider, account))?.series ?? []).flatMap(series => series.held === undefined ? [] : [{
      kind: series.kind,
      ...scopeField(series.scope),
      ...structuredClone(series.held),
    }])
  }

  /** Remove the closed and ended-early entries from memory and return them, for the store to append. */
  drainClosed(): WindowUsageEntry[] {
    const closed = [...this.entryById.values()].filter(entry => entry.status !== 'open')
    for (const entry of closed) this.entryById.delete(entry.id)
    const drained = new Set(closed.map(entry => entry.id))
    for (const state of this.accounts.values()) {
      for (const series of state.series) {
        if (series.kind !== 'unclassified') series.entryIds = series.entryIds.filter(id => !drained.has(id))
      }
    }
    return closed
  }

  /**
   * A JSON-serialisable deep copy of the whole tracker memory. The store persists
   * the open entries from this (not by merging ids), because a pending
   * Window 0 copied into per-kind Window 0 entries is discarded without an
   * event.
   */
  state(): TrackerState {
    return structuredClone({
      v: 1 as const,
      ...Number.isFinite(this.now) ? { now: this.now } : {},
      accounts: [...this.accounts.values()],
      entries: [...this.entryById.values()],
    })
  }

  /** Run one public operation; queued callbacks run after the outermost one finishes. */
  private operation<T>(work: () => T): T {
    this.depth++
    try {
      return work()
    } finally {
      this.depth--
      if (this.depth === 0) {
        for (let next = this.notifications.shift(); next !== undefined; next = this.notifications.shift()) {
          try {
            next()
          } catch (error) {
            this.warn(`usage window callback failed: ${errorMessage(error)}`)
          }
        }
      }
    }
  }

  private warn(message: string): void {
    this.options.onWarn?.(message)
  }

  /**
   * Move the clock to `now` (never backwards) and apply what became due. A
   * non-finite instant is ignored: `+Infinity` would close every window at
   * once, and the clock could never come back from it.
   */
  private advanceTo(now: number): number {
    if (!Number.isFinite(now)) return this.now
    this.now = Math.max(this.now, now)
    for (const state of this.accounts.values()) {
      for (const series of state.series) this.advanceSeries(state, series)
    }
    return this.now
  }

  /** Tracked provider, finite instant, and not before tracking start or the provider's clear. */
  private admits(provider: string, at: number): provider is TrackedProvider {
    return isTrackedProvider(provider) && Number.isFinite(at) && at >= this.cutoff(provider)
  }

  private accountState(provider: TrackedProvider, account: string): AccountState {
    const key = accountKey(provider, account)
    let state = this.accounts.get(key)
    if (state === undefined) {
      state = { provider, account, snapshotSeen: false, series: [] }
      this.accounts.set(key, state)
    }
    return state
  }

  /** Before the account's first snapshot its kinds are unknown: the request goes to the pending Window 0. */
  private addToPending(state: AccountState, model: string, counts: TokenCounts, at: number, day: string | undefined): string[] {
    const existing = this.lookup(state.pending)
    if (existing !== undefined && this.rejectsOverflow(state, model, counts, [existing])) return []
    const pending = existing ?? this.createWindow0(state, 'pending', undefined, at)
    state.pending = pending.id
    addTo(pending, model, counts, at, day)
    return [pending.id]
  }

  /** After the first snapshot: into the {@link target} of every series the model applies to. */
  private addToSeries(state: AccountState, model: string, counts: TokenCounts, at: number, day: string | undefined): string[] {
    const applicable = state.series.filter(series => windowApplies(series, model, state.provider))
    // check every existing target before anything is created or
    // added, so a rejected chunk changes no window (a target created below
    // starts at zero and cannot overflow).
    const existing = applicable.flatMap(series => this.existingTarget(series)?.sum ?? [])
    if (this.rejectsOverflow(state, model, counts, existing)) return []
    const ids: string[] = []
    for (const series of applicable) {
      const target = this.target(state, series, at)
      if (target === undefined) {
        series.turnedAway = true
        continue
      }
      addTo(target.sum, model, counts, at, day)
      if (target.id !== undefined) ids.push(target.id)
    }
    return ids
  }

  /** Whether adding `counts` would pass `MAX_SAFE_INTEGER` in any of `sums`; warns when it would. */
  private rejectsOverflow(state: AccountState, model: string, counts: TokenCounts, sums: readonly Sum[]): boolean {
    if (!sums.some(sum => overflows(sum.models, model, counts))) return false
    this.warn(`usage counts rejected for ${state.provider}/${model}: a window sum would pass MAX_SAFE_INTEGER`)
    return true
  }

  /**
   * Where a request for `series` goes: what the series already has
   * ({@link existingTarget}), else a new held sum (anchored) or a
   * new Window 0 (created lazily before anchoring).
   *
   * An absent series creates nothing new (decision T2-4), so with no
   * existing target the request is turned away. What it already has keeps
   * counting, so each entry covers exactly the requests it received.
   * A renamed scope that still matches by `windowApplies` counts
   * into the old target too until it ends or the user clears.
   */
  private target(state: AccountState, series: SeriesState, at: number): Target | undefined {
    const existing = this.existingTarget(series)
    if (existing !== undefined || series.absent === true) return existing
    if (series.anchored) {
      series.held = { countedFrom: at, lastAddedAt: at, models: {} }
      return { sum: series.held }
    }
    const window0 = this.createWindow0(state, series.kind, series.scope, at)
    this.attachWindow0(series, window0)
    return { sum: window0, id: window0.id }
  }

  /** The series' open real entry; else, once anchored, its held sum; before anchoring, its Window 0. */
  private existingTarget(series: SeriesState): Target | undefined {
    const open = this.openEntry(series)
    if (open !== undefined) return { sum: open, id: open.id }
    if (series.anchored) return series.held === undefined ? undefined : { sum: series.held }
    const window0 = this.lookup(series.window0)
    return window0 === undefined ? undefined : { sum: window0, id: window0.id }
  }

  /**
   * Pair each window of a snapshot with the account's existing series.
   *
   * A series is identified by the provider's kind and scope ({@link seriesKey}).
   * Keying by order or by disclosed class instead would re-key a series when
   * a provider reorders windows or starts or stops disclosing `durationMs`
   * (Grok's legacy billing never does), and the abandoned series would keep
   * counting: one request in two windows, which no per-request record could
   * undo. Several windows with one key in a snapshot (two unscoped
   * `other` windows, from Claude's unknown `limits[]` kinds or Codex's odd
   * lengths) are paired with that key's series as a whole, best pair first
   * ({@link pairScore}), so a newly reported window cannot take an existing
   * window's series and read as its early reset. Windows left over get
   * new series.
   * @returns the windows with their series; `undefined` where a new series is needed.
   */
  private matchSeries(state: AccountState, windows: readonly UsageWindow[]): { window: UsageWindow, series: SeriesState | undefined }[] {
    const pairs = windows.flatMap((window, index) => state.series
      .filter(series => series.key === seriesKey(window))
      .map(series => ({ index, series, score: pairScore(series, window) })))
      .sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1])
    const matched = new Map<number, SeriesState>()
    const taken = new Set<SeriesState>()
    for (const { index, series } of pairs) {
      if (matched.has(index) || taken.has(series)) continue
      matched.set(index, series)
      taken.add(series)
    }
    return windows.map((window, index) => ({ window, series: matched.get(index) }))
  }

  /** Create the series of one reported window if needed, and record what this snapshot says about it. */
  private upsertSeries(state: AccountState, window: UsageWindow, existing: SeriesState | undefined, at: number): SeriesState {
    let series = existing
    if (series === undefined) {
      series = {
        key: seriesKey(window), kind: 'unclassified', resetReported: false, anchored: false, entryIds: [],
        ...scopeField(window.scope),
        ...state.snapshotSeen ? { countFloor: at } : {},
      }
      state.series.push(series)
    }
    const reset = futureReset(window, at)
    const disclosed = validLength(window.durationMs)
    this.reclassify(state, series, classifyWindow(window))
    if (disclosed !== undefined) series.lengthMs = disclosed
    else if (series.kind === 'unclassified' && reset !== undefined && series.lastReset !== undefined
      && series.lastReset <= at && reset - series.lastReset > RESET_MATCH_TOLERANCE_MS
      && adjacentResets(series.lastReset, reset, at)) {
      // an `other` window with no disclosed length is classified by its
      // observed length R2 − R1, only when R1 and R2 end adjacent windows
      // only. Otherwise it stays unclassified until an adjacent pair. A
      // reset within the tolerance of R1 is R1 reported again (jitter),
      // not the next reset, so it measures no length.
      this.reclassify(state, series, classifyLength(reset - series.lastReset))
    }
    series.resetReported = reset !== undefined
    // A length once disclosed is kept when a later snapshot omits it (Grok's
    // legacy shape); otherwise the nominal length of the kind, if any.
    if (disclosed === undefined) {
      const nominal = NOMINAL_LENGTH_MS[series.kind]
      if (nominal !== undefined) series.lengthMs ??= nominal
    }
    if (reset !== undefined) series.lastReset = reset
    return series
  }

  /**
   * Classify an unclassified series once (`unclassified` itself is a
   * no-op); its in-memory entries take the kind, ids unchanged, and
   * `onReclassify` names every entry so the store can update the ones already
   * saved. A classified series never changes kind again: a later different
   * disclosed length is read as jitter of the provider's report, not as a
   * different window.
   */
  private reclassify(state: AccountState, series: SeriesState, kind: WindowKind): void {
    if (kind === 'unclassified' || series.kind !== 'unclassified') return
    series.kind = kind
    for (const id of series.entryIds) {
      const entry = this.entryById.get(id)
      if (entry !== undefined) entry.kind = kind
    }
    const change: Reclassification = { provider: state.provider, account: state.account, kind, ids: [...series.entryIds] }
    series.entryIds = series.entryIds.filter(id => this.entryById.has(id))
    const notify = this.options.onReclassify
    if (notify !== undefined && change.ids.length > 0) this.notifications.push(() => { notify(change) })
  }

  /** copy the pending Window 0 into a Window 0 per reported series, per model by `windowApplies`, then discard it. */
  private splitPending(state: AccountState): void {
    const pending = this.lookup(state.pending)
    delete state.pending
    if (pending === undefined) return
    this.entryById.delete(pending.id)
    for (const series of state.series) {
      const models: Record<string, TokenCounts> = {}
      addModels(models, pending.models, model => windowApplies(series, model, state.provider))
      if (Object.keys(models).length === 0) continue
      const window0 = this.createWindow0(state, series.kind, series.scope, pending.countedFrom)
      window0.models = models
      for (const [day, sums] of Object.entries(pending.days ?? {})) {
        const applicable = Object.fromEntries(Object.entries(sums).filter(([model]) => windowApplies(series, model, state.provider)))
        if (Object.keys(applicable).length > 0) (window0.days ??= {})[day] = structuredClone(applicable)
      }
      if (pending.lastAddedAt !== undefined) window0.lastAddedAt = pending.lastAddedAt
      this.attachWindow0(series, window0)
    }
  }

  /** One reported window's reset applied to its series; a window with no future reset changes nothing here. */
  private applyReset(state: AccountState, series: SeriesState, window: UsageWindow, at: number): void {
    const reset = futureReset(window, at)
    if (reset === undefined) return
    const start = startFor(state.provider, series.kind, window, reset)
    const open = this.openEntry(series)
    if (open?.resetsAt !== undefined) this.compareReset(state, series, open, open.resetsAt, reset, start, at)
    else if (open !== undefined) learnReset(open, reset, start)
    else if (series.anchored) this.reopen(state, series, start ?? observedStart(at), reset, at)
    // no derivable start, so the first observed reset R1 is the anchor.
    else if (start === undefined) series.pendingR1 = reset
    else this.anchor(state, series, start, reset, at)
  }

  /** An open entry with a known reset sees `reset`: jitter of the same window, or an early reset. */
  private compareReset(
    state: AccountState, series: SeriesState, open: WindowUsageEntry, knownReset: number, reset: number, start: Start | undefined, at: number,
  ): void {
    const [low, high] = open.resetRange ?? [knownReset, knownReset]
    if (reset >= high - RESET_MATCH_TOLERANCE_MS && reset <= low + RESET_MATCH_TOLERANCE_MS) {
      // matching both ends keeps the whole range within the tolerance,
      // so a reset drifting a little per fetch cannot creep unnoticed.
      open.resetsAt = reset
      open.resetRange = [Math.min(low, reset), Math.max(high, reset)]
      return
    }
    // C1, beyond the tolerance, later or earlier, while the open
    // reset has not passed (advance would have closed it otherwise).
    this.endEarly(open, at, 'detected')
    this.openReal(state, series, start ?? observedStart(at), at, reset)
  }

  /**
   * the first reset reported after the series' last entry ended
   * opens the next window, which takes the held counts. It counts from the
   * first held request; else from the opening observation if a request was
   * turned away meanwhile (it must not claim that request); else from the
   * window's start, but not before the previous entry's end.
   */
  private reopen(state: AccountState, series: SeriesState, start: Start, reset: number, at: number): void {
    const held = series.held
    delete series.held
    const countedFrom = held?.countedFrom
      ?? (series.turnedAway === true ? at : Math.max(start.startsAt, series.lastEnd ?? Number.NEGATIVE_INFINITY))
    const entry = this.openReal(state, series, start, countedFrom, reset)
    if (held !== undefined) {
      addModels(entry.models, held.models)
      if (held.days !== undefined) entry.days = structuredClone(held.days)
      entry.lastAddedAt = held.lastAddedAt
    }
  }

  /**
   * The first real entry of a series with a derivable start. It counts from the anchoring observation when a Window 0
   * closes there, or when a request was turned away before it (it must not
   * claim that request); otherwise from max(start, tracking start or clear,
   * the series' first observation).
   */
  private anchor(state: AccountState, series: SeriesState, start: Start, reset: number, at: number): void {
    const hadWindow0 = this.closeWindow0(series, at)
    const countedFrom = hadWindow0 || series.turnedAway === true
      ? at
      : Math.max(start.startsAt, this.cutoff(state.provider), series.countFloor ?? Number.NEGATIVE_INFINITY)
    this.openReal(state, series, start, countedFrom, reset)
  }

  /** Apply the transitions due by `this.now` to one series, oldest first, until none is due. */
  private advanceSeries(state: AccountState, series: SeriesState): void {
    while (this.chainAtReset(state, series) || this.closeStale(series) || this.reachR1(state, series)) {
      // Each call applies one transition; the window it opens may be due too.
    }
  }

  /** an open entry whose reset is reached closes there, and the next window opens from it. */
  private chainAtReset(state: AccountState, series: SeriesState): boolean {
    const open = this.openEntry(series)
    if (open?.resetsAt === undefined || open.resetsAt > this.now) return false
    const reset = open.resetsAt
    this.close(open, 'closed')
    // An absent series opens nothing; a later report reopens it.
    if (series.absent === true) this.endSeries(series, reset)
    else this.openReal(state, series, { startsAt: reset, startSource: 'previous-reset' }, reset)
    return true
  }

  /**
   * a chained entry whose reset was never reported closes at its
   * start + length, kept even when empty, with no chaining across missed
   * windows. A series with no disclosed or nominal length (monthly or
   * unclassified without `durationMs`) never does: it stays open, still
   * counting, until the next observed reset closes it.
   */
  private closeStale(series: SeriesState): boolean {
    const open = this.openEntry(series)
    if (open === undefined || open.resetsAt !== undefined || open.startsAt === undefined || series.lengthMs === undefined) return false
    const end = open.startsAt + series.lengthMs
    if (end > this.now) return false
    open.endedAt = end
    this.close(open, 'closed')
    this.endSeries(series, end)
    return true
  }

  /**
   * a start-less series anchors exactly at its first observed reset R1
   * once R1 is reached. An absent series opens nothing, so if R1
   * passes while it is absent, it waits until the window is reported again.
   * - If its Window 0 kept counting past R1 meanwhile, the split at
   *   R1 is no longer exact, and Window 0 closes only at an exact R1 (plan
   *   §3.3): R1 is dropped and the next reported reset anchors instead.
   * - If a request was turned away (no Window 0), the entry still starts at
   *   R1 but counts from its own opening, like {@link anchor}, so it never
   *   claims that request.
   */
  private reachR1(state: AccountState, series: SeriesState): boolean {
    const r1 = series.pendingR1
    if (series.anchored || series.absent === true || r1 === undefined || r1 > this.now) return false
    delete series.pendingR1
    if ((this.lookup(series.window0)?.lastAddedAt ?? Number.NEGATIVE_INFINITY) >= r1) return true
    this.closeWindow0(series, r1)
    this.openReal(state, series, { startsAt: r1, startSource: 'previous-reset' }, series.turnedAway === true ? this.now : r1)
    return true
  }

  /** The series has no open entry from `end` until a reported reset reopens it . */
  private endSeries(series: SeriesState, end: number): void {
    delete series.open
    series.lastEnd = end
  }

  /** A new open Window 0 counted from `at`; the caller attaches it. */
  private createWindow0(state: AccountState, kind: EntryKind, scope: string | undefined, at: number): WindowUsageEntry {
    return this.create(state, {
      kind,
      window0: this.clearedAt[state.provider] === undefined ? 'tracking-start' : 'cleared',
      ...scopeField(scope),
      startSource: 'first-usage',
      countedFrom: at,
    })
  }

  private attachWindow0(series: SeriesState, window0: WindowUsageEntry): void {
    series.window0 = window0.id
    series.entryIds.push(window0.id)
  }

  /** Close the series' Window 0 at `at`, if it has one; the caller opens the first real entry. */
  private closeWindow0(series: SeriesState, at: number): boolean {
    const window0 = this.lookup(series.window0)
    delete series.window0
    if (window0 === undefined) return false
    window0.endedAt = at
    this.close(window0, 'closed')
    return true
  }

  private openReal(state: AccountState, series: SeriesState, start: Start, countedFrom: number, reset?: number): WindowUsageEntry {
    const entry = this.create(state, {
      kind: series.kind,
      ...scopeField(series.scope),
      ...start,
      ...reset === undefined ? {} : { resetsAt: reset, resetRange: [reset, reset] as [number, number] },
      countedFrom,
    })
    series.anchored = true
    series.open = entry.id
    series.entryIds.push(entry.id)
    delete series.lastEnd
    delete series.turnedAway
    return entry
  }

  private create(state: AccountState, fields: Omit<WindowUsageEntry, 'v' | 'id' | 'provider' | 'account' | 'status' | 'models'>): WindowUsageEntry {
    // Include the provider, account, kind, scope, startsAt and countedFrom: a
    // window that reopens with the same start (an early reset there and
    // back) must not reuse a drained entry's id, which the store
    // de-duplicates by. Two processes give a chained entry the same id
    // (both parts come from the provider's reset), but not a first real
    // entry or one after an early reset, whose countedFrom is each
    // process's own observation. The store merges identical ids when writing;
    // the usage view can merge different ids describing the same window.
    // The suffix separates same-instant entries still in memory only.
    const base = [state.provider, state.account, fields.kind, fields.scope ?? '', fields.startsAt ?? ENTRY_ID.window0Start, fields.countedFrom]
      .map(part => encodeURIComponent(String(part))).join(ENTRY_ID.separator)
    let id = base
    for (let n = ENTRY_ID.firstDuplicate; this.entryById.has(id); n++) id = `${base}${ENTRY_ID.duplicateMark}${n}`
    const entry: WindowUsageEntry = { v: 1, id, provider: state.provider, account: state.account, status: 'open', models: {}, ...fields }
    this.entryById.set(id, entry)
    return entry
  }

  private lookup(id: string | undefined): WindowUsageEntry | undefined {
    return id === undefined ? undefined : this.entryById.get(id)
  }

  private openEntry(series: SeriesState): WindowUsageEntry | undefined {
    const entry = this.lookup(series.open)
    return entry?.status === 'open' ? entry : undefined
  }

  private endEarly(entry: WindowUsageEntry, at: number, reason: 'detected' | 'redemption'): void {
    entry.endedAt = at
    entry.endReason = reason
    this.close(entry, 'ended-early')
  }

  /** Mark `entry` closed and queue `onClose` with a copy: the entry may change again before the callback runs. */
  private close(entry: WindowUsageEntry, status: 'closed' | 'ended-early'): void {
    entry.status = status
    const notify = this.options.onClose
    if (notify === undefined) return
    const closed = structuredClone(entry)
    this.notifications.push(() => { notify(closed) })
  }

  private cutoff(provider: TrackedProvider): number {
    return Math.max(this.trackingStartedAt, this.clearedAt[provider] ?? Number.NEGATIVE_INFINITY)
  }
}

/** Joins key parts; a character no provider id, account key, kind or scope contains. */
const KEY_SEPARATOR = '\u0000'

/** Entry id format (see `WindowTracker.create`). */
const ENTRY_ID = {
  /** Joins the URI-encoded parts, so no part can contain it. */
  separator: '/',
  /** The `startsAt` part of a Window 0 id, which has no start. */
  window0Start: 'w0',
  /** Precedes the number that tells same-instant entries apart; never produced by URI encoding. */
  duplicateMark: '#',
  /** The second entry with one base id is `#2`; the first has no suffix. */
  firstDuplicate: 2,
} as const

function accountKey(provider: string, account: string): string {
  return [provider, account].join(KEY_SEPARATOR)
}

/** The identity of one reported window: the provider's kind and scope (see `WindowTracker.matchSeries`). */
function seriesKey(window: UsageWindow): string {
  return [window.kind, window.scope ?? ''].join(KEY_SEPARATOR)
}

/** `{ scope }` when there is one, so an unscoped object has no `scope` key (exactOptionalPropertyTypes, JSON). */
function scopeField(scope: string | undefined): { scope?: string } {
  return scope === undefined ? {} : { scope }
}

/**
 * How well a window continues a series of its key, lower first: a differing
 * disclosed length first (both sides disclose and disagree, so it is most
 * likely another window), then the distance between resets (a reset moves
 * only on an early reset). A window or series without a reset is
 * furthest. The order of the snapshot never matters.
 */
function pairScore(series: SeriesState, window: UsageWindow): [lengthMismatch: number, resetDistanceMs: number] {
  const length = validLength(window.durationMs)
  const mismatch = length !== undefined && series.lengthMs !== undefined && length !== series.lengthMs ? 1 : 0
  const reset = window.resetsAt
  const distance = reset === undefined || series.lastReset === undefined ? Number.POSITIVE_INFINITY : Math.abs(reset - series.lastReset)
  return [mismatch, distance]
}

/**
 * Whether the reset R2, first reported at `at`, ends the window that began
 * at the previous reset R1, so R2 − R1 is one window's length.
 *
 * The decided condition is "a snapshot fetched after R1 and before R2
 * reported R2". Alone, that does not exclude a gap: a daily quota fetched
 * on day 0 (R1 = day 1) and next on day 7 (R2 = day 8) meets it. Seeing R2
 * in the first half of [R1, R2) does: if unobserved resets fell between
 * R1 and R2, the windows would be at most half of R2 − R1 long (equal
 * lengths, as every classified kind has), and the window ending at R2
 * could not contain `at`. A later first sighting waits for the next pair.
 */
function adjacentResets(r1: number, r2: number, at: number): boolean {
  return at >= r1 && at < r2 && (at - r1) * 2 < r2 - r1
}

/** The fallback start: the instant the window was observed to begin. */
function observedStart(at: number): Start {
  return { startsAt: at, startSource: 'observed' }
}

/** The window's reset when reported and still ahead of the observation; a passed reset anchors nothing. */
function futureReset(window: UsageWindow, at: number): number | undefined {
  const reset = window.resetsAt
  return reset !== undefined && Number.isFinite(reset) && reset > at ? reset : undefined
}

/**
 * An open entry with no reset yet (chained, R1-anchored or redeemed)
 * learns it. A rule-4 start (`previous-reset`) is replaced only by a
 * provider-disclosed one (rules 1–2): a nominal start is a guess, and an
 * exact redemption instant is better than either.
 */
function learnReset(open: WindowUsageEntry, reset: number, start: Start | undefined): void {
  open.resetsAt = reset
  open.resetRange = [reset, reset]
  if (start !== undefined && open.startSource === 'previous-reset' && start.startSource !== 'nominal') Object.assign(open, start)
}

/** Use the disclosed or nominal start; otherwise the series waits for an observed reset. */
function startFor(provider: TrackedProvider, kind: WindowKind, window: UsageWindow, reset: number): Start | undefined {
  const disclosed = DISCLOSED_START_SOURCE[provider]
  const length = validLength(window.durationMs)
  if (disclosed !== undefined && length !== undefined) return { startsAt: reset - length, startSource: disclosed }
  const nominal = NOMINAL_LENGTH_MS[kind]
  return nominal === undefined ? undefined : { startsAt: reset - nominal, startSource: 'nominal' }
}
