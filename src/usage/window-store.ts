/**
 * The window usage store owns the {@link WindowTracker} of this process, feeds it the
 * snapshot, request-end and redemption hooks, and saves its entries behind
 * the request path.
 *
 * Shape of the work:
 * - The hooks are synchronous and do no I/O: an event only
 *   changes the in-memory tracker and arms the save timer.
 * - Saves are write-behind: after a fixed delay from the first unsaved
 *   change, at once when a window closes, and at shutdown. One save
 *   runs at a time in this process.
 * - A save is a read-merge-write under a per-provider lock file: it adds this
 *   process's *unsaved deltas* (counts since its last committed save) to the
 *   file's entries, so two processes sharing one DSH home never lose each
 *   other's committed sums.
 * - Closed entries are appended to their year file before `open.json` is
 *   rewritten; a crash between the two leaves one id in both, and the closed
 *   copy wins on load.
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import type { ProviderUsage } from '../providers/common.js'
import type { RequestEnd } from '../providers/replay.js'
import { errorMessage } from '../http.js'
import { parseJsonText } from '../json-text.js'
import {
  USAGE_ADVANCE_INTERVAL_MS, USAGE_DIR_SEGMENTS, USAGE_FILES, USAGE_LOCK_STALE_MS, USAGE_SAVE_DELAY_MS,
  USAGE_SHUTDOWN_LOCK_WAITS, USAGE_TRACKED_PROVIDERS, type TrackedProvider,
} from './constants.js'
import { requestCounts, servedModel } from './request-counts.js'
import {
  closedYear, combineDays, combineModels, parseOpenFile, pruneModels, sanitizeAccount, sanitizeEntry, zeroModels,
  type DaySums, type ModelSums, type OpenFile, type UsageMeta,
} from './usage-schema.js'
import {
  UsageLock, errorCode, nodeUsageFileSystem, readOptional, readUsageMeta, sleep, usageLock, usageLockWaitMs, writeAtomic,
  type UsageFileSystem,
} from './usage-files.js'
import {
  REQUIRED_BUCKETS, SPLIT_BUCKETS, WindowTracker, emptyCounts, isTrackedProvider, validCounts,
  type AccountState, type EntryKind, type SeriesState, type TokenCounts, type TrackerState, type WindowUsageEntry,
} from './window-tracker.js'

export { nodeUsageFileSystem, type UsageFileSystem } from './usage-files.js'

export interface WindowStoreOptions {
  /** The usage directory; defaults to `dshHomePath('plugins', 'subscriptions', 'usage')`, resolved at construction. */
  dir?: string
  fs?: UsageFileSystem
  /** The clock for tracking start, lock age, the timer-driven advance and dispose. */
  now?: () => number
  onWarn?: (message: string) => void
  saveDelayMs?: number
  lockStaleMs?: number
  advanceIntervalMs?: number
}

/** How one provider's save ended. */
type SaveOutcome = 'saved' | 'held' | 'failed'

type Aggregate = Pick<WindowUsageEntry, 'models' | 'days'>
type Held = NonNullable<SeriesState['held']>

/** A closed entry on its way to its year file: its final copy is `base` (the stored one) plus `delta`. */
interface ClosedWrite {
  entry: WindowUsageEntry
  delta: Aggregate
  /** Still open here but already closed by another process: only the delta is added, the stored line's fields stay. */
  intoExisting?: true
}

/** One line of a closed file, parsed when it is a valid entry; other lines are kept verbatim. */
export interface ClosedLine {
  text: string
  entry?: WindowUsageEntry
  /** 1-based line number in the file as read; absent on a line this process built. */
  line?: number
}

export class WindowStore {
  readonly dir: string
  readonly ready: Promise<void>
  private readonly fs: UsageFileSystem
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private readonly saveDelayMs: number
  private readonly lockStaleMs: number
  private live: WindowTracker | undefined
  private meta: UsageMeta | undefined
  /** Events that arrived before the files were loaded, applied in order once they are. */
  private readonly early: (() => void)[] = []
  /** Providers with changes not yet saved. */
  private readonly dirty = new Set<TrackedProvider>()
  /** Per provider and entry id: the model sums this process has committed for the entry (its last saved view). */
  private readonly baselines = new Map<TrackedProvider, Map<string, Aggregate>>()
  /** Last committed local view of held sums, by account and series. */
  private readonly heldBaselines = new Map<TrackedProvider, Map<string, Held>>()
  /** Unsaved held-sum promotions: heldKey(account, seriesKey) -> entryId that received the held counts. */
  private readonly heldPromotions = new Map<TrackedProvider, Map<string, string>>()
  /** Ids found both open and closed on disk at load (a crash between the two writes); removed from `open.json` at the next save. */
  private readonly staleOpen = new Map<TrackedProvider, Set<string>>()
  /** Set once loading finished, whether or not tracking is enabled. */
  private loaded = false
  /** Entries drained from the tracker after closing, until their closed line is committed. */
  private readonly closing = new Map<TrackedProvider, Map<string, WindowUsageEntry>>()
  /** Entry ids whose series was classified after they were saved, with the new kind. */
  private readonly reclassified = new Map<TrackedProvider, Map<string, EntryKind>>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private advanceTimer: ReturnType<typeof setInterval> | undefined
  private queue: Promise<void> = Promise.resolve()
  private disposing: Promise<void> | undefined

  constructor(options: WindowStoreOptions = {}) {
    this.dir = options.dir ?? dshHomePath(...USAGE_DIR_SEGMENTS)
    this.fs = options.fs ?? nodeUsageFileSystem
    this.now = options.now ?? Date.now
    this.warn = options.onWarn ?? (() => undefined)
    this.saveDelayMs = options.saveDelayMs ?? USAGE_SAVE_DELAY_MS
    this.lockStaleMs = options.lockStaleMs ?? USAGE_LOCK_STALE_MS
    // the first start's instant is taken now, before any request can
    // be counted; loading only decides whether an earlier start already set it.
    const startedAt = this.now()
    this.ready = this.load(startedAt).catch(error => {
      this.live = undefined
      this.warn(`usage tracking disabled: ${errorMessage(error)}`)
    }).finally(() => {
      this.loaded = true
      for (const run of this.early.splice(0)) run()
    })
    const interval = options.advanceIntervalMs ?? USAGE_ADVANCE_INTERVAL_MS
    this.advanceTimer = setInterval(() => { this.advance() }, interval)
    this.advanceTimer.unref?.()
  }

  /** When per-account tracking started; undefined before {@link ready} or when tracking is disabled. */
  get trackingStartedAt(): number | undefined {
    return this.live === undefined ? undefined : this.meta?.trackingStartedAt
  }

  /** The live in-memory tracker; undefined before {@link ready} or when tracking is disabled. */
  get tracker(): WindowTracker | undefined {
    return this.live
  }

  /**
   * This process's in-memory view of a provider's entries, for the reader
   * includes the tracker's open entries, with their unsaved counts, and the
   * closed ones not yet written to their year file. Copies; never I/O.
   */
  entries(provider: TrackedProvider): WindowUsageEntry[] {
    const closing = [...this.closing.get(provider)?.values() ?? []].map(entry => structuredClone(entry))
    return [...this.live?.entries(provider) ?? [], ...closing]
  }

  /**
   * This process's counts not yet saved, per entry id: its in-memory sums
   * minus what it last committed. A reader adds them to the stored
   * copy of an id another process may also write, because the in-memory
   * entry is never refreshed with that process's commits.
   */
  unsavedDeltas(provider: TrackedProvider): Map<string, ModelSums> {
    const baseline = this.baselineOf(provider)
    return new Map(this.entries(provider).map(entry => [entry.id, aggregateDelta(entry, baseline.get(entry.id)).models]))
  }

  /** Daily portion of unsavedDeltas; old window totals may have no date allocation. */
  unsavedDayDeltas(provider: TrackedProvider): Map<string, DaySums> {
    const baseline = this.baselineOf(provider)
    return new Map(this.entries(provider).map(entry => [entry.id, aggregateDelta(entry, baseline.get(entry.id)).days ?? {}]))
  }

  /** The provider's clear cut-off as this process knows it; undefined when never cleared or tracking is off. */
  clearedAt(provider: TrackedProvider): number | undefined {
    return this.live === undefined ? undefined : this.meta?.clearedAt[provider]
  }

  /** The snapshot hook: one completed usage fetch. */
  observe(provider: string, account: string, snapshot: ProviderUsage, observedAt: number): void {
    if (!isTrackedProvider(provider)) return
    this.event(tracker => {
      if (this.changes(provider, () => { tracker.observe(provider, account, snapshot, observedAt) })) this.markDirty(provider)
    })
  }

  /** The request-end hook: synchronous, no I/O, never throws. */
  recordRequest(end: RequestEnd): void {
    try {
      const provider = end.provider
      if (!isTrackedProvider(provider)) return
      const counts = requestCounts(end.chunk)
      const model = servedModel(end.model)
      this.event(tracker => {
        tracker.add(provider, end.account, model, end.finishedAt, counts)
        // An empty or rejected chunk changes nothing; a held count
        // returns no id but still changes what must be saved.
        if (!emptyCounts(counts) && validCounts(counts)) this.markDirty(provider)
      })
    } catch (error) {
      this.warn(`usage tracking failed for a request: ${errorMessage(error)}`)
    }
  }

  /** The redemption hook: a credit redeemed through the plugin at `at`. */
  redeem(provider: string, account: string, at: number): void {
    if (!isTrackedProvider(provider)) return
    this.event(tracker => {
      if (this.changes(provider, () => { tracker.redeem(provider, account, at) })) this.markDirty(provider)
    })
  }

  /** Save every provider with unsaved changes now, ignoring the delay; never rejects. */
  flush(): Promise<void> {
    return this.enqueue(() => this.saveDirty(0))
  }

  /** Resolves when no save is running or queued. */
  async settled(): Promise<void> {
    await this.ready
    for (let queue = this.queue; ; queue = this.queue) {
      await queue
      if (queue === this.queue) return
    }
  }

  /**
   * Clear one provider's stored usage: the `clearedAt` cut-off
   * is written first, then this process forgets the provider, then its
   * files are purged under its lock. Earlier failed purges of any provider
   * are retried too.
   * @throws when the cut-off cannot be written or the provider's purge fails;
   *   a written cut-off still holds for readers, and the purge is retried.
   */
  clearProvider(provider: string): Promise<void> {
    if (!isTrackedProvider(provider)) return Promise.resolve()
    let failure: unknown
    const done = this.enqueue(async () => {
      try {
        await this.clear(provider)
      } catch (error) {
        failure = error
      }
    })
    return done.then(() => {
      if (failure !== undefined) throw failure
    })
  }

  /**
   * Stop the timers and save what is pending without waiting for the delay
   * (within a bounded wait). A held lock is waited for up to the staleness limit; if
   * the sums still cannot be written, or a running save hangs that long,
   * they are dropped with a warning. Later events are ignored.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.shutdown()
    return this.disposing
  }

  private async shutdown(): Promise<void> {
    clearInterval(this.advanceTimer)
    this.cancelSaveTimer()
    await this.ready
    if (this.live === undefined) return
    let failed: TrackedProvider[] = []
    // Through the queue, so no other save of this process runs beside it.
    // A held lock is waited for inside; the bound also covers a
    // running save that hangs: a lock wait, plus a save's own time.
    const saved = this.enqueue(async () => { failed = await this.saveDirty(this.lockWaitMs()) })
    const finished = await finishesWithin(saved, USAGE_SHUTDOWN_LOCK_WAITS * this.lockWaitMs())
    this.live = undefined
    if (!finished) this.warn('usage save at shutdown timed out; unsaved usage counts were dropped')
    else if (failed.length > 0) this.warn(`usage counts for ${failed.join(', ')} could not be saved at shutdown and were dropped`)
  }

  /**
   * Run `apply` against the tracker now, or once loaded. An event is judged
   * when it arrives: one that arrived before dispose is applied even when
   * the load finishes after dispose was called (shutdown awaits `ready`,
   * which runs the queue before its final save); one that
   * arrives after dispose is ignored.
   */
  private event(apply: (tracker: WindowTracker) => void): void {
    if (this.disposing !== undefined) return
    const run = (): void => {
      const tracker = this.live
      if (tracker === undefined) return
      try {
        apply(tracker)
      } catch (error) {
        this.warn(`usage window tracking failed: ${errorMessage(error)}`)
      }
    }
    if (!this.loaded) this.early.push(run)
    else run()
  }

  /** Timer-driven advance: windows whose reset passed with no traffic close. */
  private advance(): void {
    this.event(tracker => {
      for (const provider of this.changedProviders(() => { tracker.advance(this.now()) })) this.markDirty(provider)
    })
  }

  /** Whether `work` changed what would be saved for `provider` (any provider when undefined). */
  private changes(provider: TrackedProvider | undefined, work: () => void): boolean {
    const changed = this.changedProviders(work)
    return provider === undefined ? changed.length > 0 : changed.includes(provider)
  }

  /** The providers whose saved state `work` changed (the tracker's clock is not saved, so it does not count). */
  private changedProviders(work: () => void): TrackedProvider[] {
    const before = this.fingerprints()
    work()
    const after = this.fingerprints()
    return USAGE_TRACKED_PROVIDERS.filter(provider => before.get(provider) !== after.get(provider))
  }

  private fingerprints(): Map<TrackedProvider, string> {
    const state = this.live?.state()
    return new Map(USAGE_TRACKED_PROVIDERS.map(provider => [provider, JSON.stringify([
      state?.accounts.filter(account => account.provider === provider),
      state?.entries.filter(entry => entry.provider === provider),
    ])]))
  }

  /** the delay counts from the first unsaved change, so later changes do not re-arm it. */
  private markDirty(provider: TrackedProvider): void {
    this.dirty.add(provider)
    this.armSave()
  }

  private armSave(): void {
    if (this.saveTimer !== undefined || this.disposing !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush()
    }, this.saveDelayMs)
    this.saveTimer.unref?.()
  }

  private cancelSaveTimer(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
  }

  /** Run `work` after every queued save or clear; its errors become warnings. */
  private enqueue(work: () => Promise<unknown>): Promise<void> {
    this.queue = this.queue.then(() => this.ready).then(work).then(() => undefined, error => {
      this.warn(`usage store failed: ${errorMessage(error)}`)
    })
    return this.queue
  }

  /**
   * Save every dirty provider; one whose lock was held or whose write failed
   * stays dirty and is re-tried after the save delay.
   * @param lockWaitMs - how long to wait for a held lock (shutdown only).
   * @returns the providers that could not be saved.
   */
  private async saveDirty(lockWaitMs: number): Promise<TrackedProvider[]> {
    const tracker = this.live
    if (tracker === undefined) return []
    // Apply resets due by now first, so a window another process already
    // closed at the same reset is closed here too before it is merged.
    for (const provider of this.changedProviders(() => { tracker.advance(this.now()) })) this.dirty.add(provider)
    this.collectClosed()
    const failed: TrackedProvider[] = []
    for (const provider of [...this.dirty]) {
      this.dirty.delete(provider)
      const outcome = await this.saveProvider(provider, lockWaitMs)
      if (outcome !== 'saved') {
        failed.push(provider)
        this.markDirty(provider)
      }
    }
    return failed
  }

  private baselineOf(provider: TrackedProvider): Map<string, Aggregate> {
    return getOrCreate(this.baselines, provider, () => new Map())
  }

  /** Move the tracker's closed entries into {@link closing}, so they are saved even if the tracker forgets them. */
  private collectClosed(): void {
    for (const entry of this.live?.drainClosed() ?? []) this.closingOf(entry.provider).set(entry.id, entry)
  }

  private closingOf(provider: TrackedProvider): Map<string, WindowUsageEntry> {
    return getOrCreate(this.closing, provider, () => new Map())
  }

  /** How long a waiting caller waits for a held lock: long enough for a lock held from the start to turn stale. */
  private lockWaitMs(): number {
    return usageLockWaitMs(this.lockStaleMs)
  }

  private lock(name: string): UsageLock {
    return usageLock(this.fs, this.dir, name, this.now, this.lockStaleMs)
  }

  private providerDir(provider: TrackedProvider): string {
    return join(this.dir, provider)
  }

  private openPath(provider: TrackedProvider): string {
    return join(this.providerDir(provider), USAGE_FILES.open)
  }

  private closedPath(provider: TrackedProvider, year: number): string {
    return join(this.providerDir(provider), `${USAGE_FILES.closedPrefix}${year}${USAGE_FILES.closedSuffix}`)
  }

  private async closedPaths(provider: TrackedProvider): Promise<string[]> {
    return (await this.fs.readdir(this.providerDir(provider)))
      .filter(name => name.startsWith(USAGE_FILES.closedPrefix) && name.endsWith(USAGE_FILES.closedSuffix))
      .map(name => join(this.providerDir(provider), name))
  }

  private async saveProvider(provider: TrackedProvider, lockWaitMs: number): Promise<SaveOutcome> {
    let release: (() => Promise<void>) | undefined
    try {
      release = await this.lock(provider).acquire(lockWaitMs)
      if (release === undefined) return 'held'
      // Again under the lock: a window that closed while this waited must be
      // saved as closed, not written into `open.json` with a closed status.
      this.collectClosed()
      await this.adoptNewerClear(provider)
      await this.writeProvider(provider)
      return 'saved'
    } catch (error) {
      this.warn(`usage save failed for ${provider}; the counts are kept and retried: ${errorMessage(error)}`)
      return 'failed'
    } finally {
      await release?.().catch(error => { this.warn(`usage lock release failed for ${provider}: ${errorMessage(error)}`) })
    }
  }

  /**
   * another process cleared `provider` since this one last looked.
   * Deltas of entries counted before the clear are dropped. Entries
   * counted from it on are committed, closed at this instant because this
   * process stops following them, and the provider is forgotten, so later
   * requests go to a Window 0 `cleared`.
   */
  private async adoptNewerClear(provider: TrackedProvider): Promise<void> {
    const stored = await this.readMeta()
    const clearedAt = stored?.clearedAt[provider]
    const tracker = this.live
    if (clearedAt === undefined || tracker === undefined || this.meta === undefined || clearedAt <= (this.meta.clearedAt[provider] ?? Number.NEGATIVE_INFINITY)) return
    this.meta.clearedAt[provider] = clearedAt
    const at = this.now()
    const closing = this.closingOf(provider)
    for (const entry of [...tracker.entries(provider), ...closing.values()]) {
      if (entry.countedFrom < clearedAt) closing.delete(entry.id)
      else if (entry.status === 'open') closing.set(entry.id, closeAtDiscovery(entry, at))
    }
    this.reclassified.delete(provider)
    this.heldBaselines.delete(provider)
    this.heldPromotions.delete(provider)
    tracker.clear(provider, clearedAt)
  }

  /** The read-merge-write of one provider, under its lock. */
  private async writeProvider(provider: TrackedProvider): Promise<void> {
    const tracker = this.live
    if (tracker === undefined) return
    const state = tracker.state()
    // `inMemory`: the open entries the tracker holds (not counts held between windows).
    const inMemory = state.entries.filter(entry => entry.provider === provider)
    const closing = [...this.closingOf(provider).values()]
    const accounts = state.accounts.filter(account => account.provider === provider)
    const cutoff = this.meta?.clearedAt[provider] ?? Number.NEGATIVE_INFINITY
    const file = await this.readOpen(provider)
    const stored = new Map(file.entries.map(entry => [entry.id, entry]))
    const mine = new Set([...inMemory, ...closing].map(entry => entry.id))
    const baseline = this.baselineOf(provider)
    const stale = this.staleOpen.get(provider) ?? new Set<string>()

    const current = stateUnderClear(file, cutoff)
    const otherAccounts = current.filter(account => !accounts.some(own => own.account === account.account))
    const held = mergeHeldAccounts(
      accounts, current, this.heldBaselines.get(provider), this.heldPromotions.get(provider), stored,
    )

    // Any in-memory entry (even one never saved by this process whose deterministic
    // id was independently derived by another process) may have been closed
    // elsewhere. Check closed year files for all in-memory entries so late deltas
    // merge into the closed line instead of being written back as stale open rows.
    const closedElsewhere = inMemory.length === 0 ? new Set<string>() : await this.closedIds(provider, inMemory)
    const vanished = new Set(inMemory.filter(entry => !stored.has(entry.id) && baseline.has(entry.id)).map(entry => entry.id))
    const open = new Map<string, WindowUsageEntry>()
    const closed: ClosedWrite[] = []
    for (const entry of inMemory) {
      if (entry.countedFrom < cutoff) continue
      const delta = mergeAggregates(aggregateDelta(entry, baseline.get(entry.id)), held.transfers.get(entry.id))
      if (closedElsewhere.has(entry.id)) closed.push({ entry, delta, intoExisting: true })
      // Gone with no closed line (a corrupt file moved aside): write this process's whole view.
      else if (vanished.has(entry.id)) open.set(entry.id, withSums(entry, entry, held.transfers.get(entry.id) ?? { models: {} }))
      else open.set(entry.id, withSums(entry, stored.get(entry.id), delta))
    }
    for (const entry of closing) {
      if (entry.countedFrom >= cutoff) {
        const delta = mergeAggregates(aggregateDelta(entry, baseline.get(entry.id)), held.transfers.get(entry.id))
        closed.push({ entry, delta })
      }
    }
    for (const entry of file.entries) {
      if (mine.has(entry.id) || stale.has(entry.id) || entry.countedFrom < cutoff) continue
      const share = baseline.get(entry.id)
      if (share !== undefined) {
        // Saved earlier and no longer held: the pending Window 0, whose
        // counts moved into per-kind Window 0 copies. Without taking
        // this process's share out, those counts would be stored twice.
        const left = aggregateDelta(entry, share)
        if (!zeroModels(left.models)) open.set(entry.id, { ...entry, ...left, models: pruneModels(left.models) })
      } else open.set(entry.id, withSums(entry, entry, held.transfers.get(entry.id) ?? { models: {} }))
    }

    const reclassified = this.reclassified.get(provider) ?? new Map<string, EntryKind>()
    await this.writeClosed(provider, closed, stored, reclassified)
    const next: OpenFile = {
      v: 1, ...Number.isFinite(cutoff) ? { clearedAt: cutoff } : {},
      entries: [...open.values()].map(entry => this.allowed(entry)).filter(isEntry),
      accounts: [...otherAccounts, ...held.accounts].map(account => this.allowedAccount(provider, account)).filter(isAccount),
    }
    const text = `${JSON.stringify(next, null, 2)}\n`
    if (text !== file.text) {
      await this.keepDroppedAside(provider, file)
      if (next.entries.length === 0 && next.accounts.length === 0) await this.fs.rm(this.openPath(provider))
      else await writeAtomic(this.fs, this.openPath(provider), text)
    }

    // Committed: what was written becomes this process's baseline. Closed
    // entries are final, so only the open ones in memory keep one.
    this.baselines.set(provider, new Map(inMemory.filter(entry => entry.countedFrom >= cutoff).map(entry => [entry.id, pickAggregate(entry)])))
    this.heldBaselines.set(provider, heldState(accounts))
    this.heldPromotions.delete(provider)
    // The rest of the snapshot: entries counted before the cut-off, dropped.
    for (const entry of closing) this.closingOf(provider).delete(entry.id)
    this.staleOpen.delete(provider)
    reclassified.clear()
  }

  /**
   * The closed lines are on disk, even if the `open.json` rewrite after them
   * fails: record that now, so a retry does not add the same delta to them
   * again. A closed entry leaves {@link closing}, and its open copy, still in
   * `open.json` until the rewrite succeeds, is stale (the closed copy wins,
   * so readers use the closed copy). An entry still open here but closed by another process
   * gets its baseline moved to what was just added.
   */
  private closedCommitted(provider: TrackedProvider, closed: readonly ClosedWrite[]): void {
    const baseline = this.baselineOf(provider)
    const stale = getOrCreate(this.staleOpen, provider, () => new Set<string>())
    for (const { entry, intoExisting } of closed) {
      if (intoExisting === true) {
        baseline.set(entry.id, pickAggregate(entry))
        continue
      }
      this.closingOf(provider).delete(entry.id)
      baseline.delete(entry.id)
      stale.add(entry.id)
    }
  }

  /**
   * Write closed entries to their year files, before `open.json`,
   * and apply pending reclassifications to saved lines. A new id is
   * appended; an id already in its file gets the delta added to that line,
   * which is then the final copy (an append that crashed before the open
   * rewrite, or another process's close of a shared entry).
   */
  private async writeClosed(
    provider: TrackedProvider, closed: readonly ClosedWrite[], stored: ReadonlyMap<string, WindowUsageEntry>, reclassified: ReadonlyMap<string, EntryKind>,
  ): Promise<void> {
    const byPath = new Map<string, ClosedWrite[]>()
    for (const write of closed) {
      const path = this.closedPath(provider, closedYear(write.entry))
      byPath.set(path, [...byPath.get(path) ?? [], write])
    }
    if (reclassified.size > 0) for (const path of await this.closedPaths(provider)) if (!byPath.has(path)) byPath.set(path, [])
    for (const [path, writes] of byPath) {
      const text = await readOptional(this.fs, path) ?? ''
      const lines = parseClosed(provider, text)
      const index = new Map(lines.flatMap((line, at) => line.entry === undefined ? [] : [[line.entry.id, at] as const]))
      let rewrite = false
      const appended: string[] = []
      for (const line of lines) {
        const kind = line.entry === undefined ? undefined : reclassified.get(line.entry.id)
        if (line.entry === undefined || kind === undefined || line.entry.kind === kind) continue
        line.entry = { ...line.entry, kind }
        line.text = JSON.stringify(line.entry)
        rewrite = true
      }
      for (const { entry, delta, intoExisting } of writes) {
        const at = index.get(entry.id)
        if (intoExisting === true) {
          const line = at === undefined ? undefined : lines[at].entry
          if (line === undefined || at === undefined) continue
          const merged = withSums(line, line, delta)
          const final = this.allowed({ ...merged, ...mergeQuotaFields(merged, entry) })
          if (final === undefined) continue
          lines[at] = { text: JSON.stringify(final), entry: final }
          rewrite = true
          continue
        }
        // Once a closed line exists it is authoritative, even if a failed
        // open-file rewrite left a stale copy of the same id.
        const base = (at === undefined ? undefined : lines[at].entry) ?? stored.get(entry.id)
        const final = this.allowed(withSums({ ...entry, kind: reclassified.get(entry.id) ?? entry.kind }, base, delta))
        if (final === undefined) continue
        if (at === undefined) {
          appended.push(JSON.stringify(final))
          index.set(entry.id, lines.length)
          lines.push({ text: JSON.stringify(final), entry: final })
        } else {
          lines[at] = { text: JSON.stringify(final), entry: final }
          rewrite = true
        }
      }
      if (rewrite) await writeAtomic(this.fs, path, lines.map(line => `${line.text}\n`).join(''))
      else if (appended.length > 0) {
        await this.fs.mkdir(this.providerDir(provider))
        // An earlier append cut short (a full disk) left a line with no end:
        // start on a new line, so the next entry is not glued to it and lost.
        const separator = text === '' || text.endsWith('\n') ? '' : '\n'
        await this.fs.appendFile(path, `${separator}${appended.map(line => `${line}\n`).join('')}`)
      }
      // Per file: a later file's failure must not make this one's retry add its deltas twice.
      this.closedCommitted(provider, writes)
    }
  }

  /** Ids of the valid lines in the provider's closed files: all of them, or the year files of `entries`. */
  private async closedIds(provider: TrackedProvider, entries?: readonly WindowUsageEntry[]): Promise<Set<string>> {
    const ids = new Set<string>()
    const paths = entries === undefined
      ? await this.closedPaths(provider)
      : [...new Set(entries.map(entry => this.closedPath(provider, closedYear(entry))))]
    for (const path of paths) {
      for (const line of await this.readClosed(provider, path)) if (line.entry !== undefined) ids.add(line.entry.id)
    }
    return ids
  }

  /** The allowlisted copy of an entry; an entry that fails validation is not written. */
  private allowed(entry: WindowUsageEntry): WindowUsageEntry | undefined {
    const clean = sanitizeEntry(entry.provider, entry)
    if (clean === undefined) this.warn(`usage entry ${entry.id} failed validation and was not saved`)
    return clean
  }

  /** The allowlisted copy of an account state; an invalid account state is not written to `open.json`. */
  private allowedAccount(provider: TrackedProvider, account: AccountState): AccountState | undefined {
    const clean = sanitizeAccount(provider, account)
    if (clean === undefined) this.warn(`usage account state ${provider}/${account.account} failed validation and was not saved`)
    return clean
  }

  private readMeta(): Promise<UsageMeta | undefined> {
    return readUsageMeta(this.fs, this.dir)
  }

  /**
   * Read `open.json` with its exact text (so an unchanged save writes
   * nothing). A file that is not JSON or not an open file is moved aside
   * with a warning and read as empty, so one damaged file stops neither
   * counting nor saving.
   */
  private async readOpen(provider: TrackedProvider): Promise<OpenFile & { text?: string, dropped?: number }> {
    const path = this.openPath(provider)
    const text = await readOptional(this.fs, path)
    if (text === undefined) return { v: 1, entries: [], accounts: [] }
    let parsed: ReturnType<typeof parseOpenFile>
    try {
      parsed = parseOpenFile(provider, parseJsonText(text))
    } catch {
      parsed = undefined
    }
    if (parsed === undefined) {
      const aside = `${path}${USAGE_FILES.corruptMark}${this.now()}`
      try {
        await this.fs.rename(path, aside)
      } catch (error) {
        // Another process moved it aside first: it is gone either way.
        if (errorCode(error) !== 'ENOENT') throw error
      }
      this.warn(`usage file ${path} was unreadable and was moved to ${aside}`)
      return { v: 1, entries: [], accounts: [] }
    }
    if (parsed.dropped > 0) this.warn(`usage file ${path}: ${parsed.dropped} invalid record(s) ignored`)
    return { ...parsed.file, text, dropped: parsed.dropped }
  }

  /**
   * Before a save rewrites an `open.json` that had invalid records, keep its
   * original text aside: usage is kept until the user clears it, and
   * the rewrite would remove them for good. A clear removes the copy with
   * the rest; after the rewrite there is nothing left to copy, so
   * this happens once per damage.
   */
  private async keepDroppedAside(provider: TrackedProvider, file: { text?: string, dropped?: number }): Promise<void> {
    if ((file.dropped ?? 0) === 0 || file.text === undefined) return
    const aside = `${this.openPath(provider)}${USAGE_FILES.corruptMark}${this.now()}`
    await writeAtomic(this.fs, aside, file.text)
    this.warn(`usage file ${this.openPath(provider)}: the original with its invalid record(s) was copied to ${aside}`)
  }

  /** The lines of one closed file; a line that is not a valid entry is kept verbatim and skipped by readers. */
  private async readClosed(provider: TrackedProvider, path: string): Promise<ClosedLine[]> {
    return parseClosed(provider, await readOptional(this.fs, path) ?? '')
  }

  /** Load meta, purge what earlier clears left, and restore each provider's open entries and window state. */
  private async load(startedAt: number): Promise<void> {
    const meta = await this.loadMeta(startedAt)
    const state: TrackerState = { v: 1, accounts: [], entries: [] }
    for (const provider of USAGE_TRACKED_PROVIDERS) {
      if (meta.clearedAt[provider] !== undefined) {
        await this.purge(provider, meta.clearedAt[provider]).catch(error => {
          this.warn(`usage history for ${provider} could not be fully removed after its clear; retried later: ${errorMessage(error)}`)
        })
      }
      const restored = await this.restore(provider, startedAt, meta.clearedAt[provider] ?? Number.NEGATIVE_INFINITY)
      state.accounts.push(...restored.accounts)
      state.entries.push(...restored.entries)
    }
    this.live = new WindowTracker({
      trackingStartedAt: meta.trackingStartedAt,
      clearedAt: { ...meta.clearedAt },
      state,
      onWarn: this.warn,
      onClose: entry => {
        this.markDirty(entry.provider)
        void this.flush()
      },
      onReclassify: change => {
        const map = this.reclassified.get(change.provider) ?? new Map<string, EntryKind>()
        for (const id of change.ids) map.set(id, change.kind)
        this.reclassified.set(change.provider, map)
        this.markDirty(change.provider)
      },
      onHeldPromote: promotion => {
        const map = getOrCreate(this.heldPromotions, promotion.provider, () => new Map())
        map.set(heldKey(promotion.account, promotion.seriesKey), promotion.entryId)
      },
    })
    this.meta = meta
    this.live.advance(this.now())
    for (const provider of USAGE_TRACKED_PROVIDERS) {
      if ((this.staleOpen.get(provider)?.size ?? 0) > 0 || (this.closing.get(provider)?.size ?? 0) > 0) this.markDirty(provider)
    }
  }

  /**
   * `meta.json`: read it, or create it on the first start. It is
   * written under the meta lock, so two processes starting at once agree on
   * one `trackingStartedAt`. An invalid file disables tracking (thrown) and
   * is never overwritten.
   */
  private async loadMeta(startedAt: number): Promise<UsageMeta> {
    const release = await this.acquireMetaLock()
    try {
      const existing = await this.readMeta()
      if (existing !== undefined) return existing
      const created: UsageMeta = { v: 1, trackingStartedAt: startedAt, clearedAt: {} }
      await writeAtomic(this.fs, join(this.dir, USAGE_FILES.meta), `${JSON.stringify(created, null, 2)}\n`)
      return created
    } finally {
      await release()
    }
  }

  /**
   * The meta lock, or a throw when it stays held past the wait: `meta.json`
   * written by two processes at once could disagree on `trackingStartedAt`
   * or lose a `clearedAt`, so neither the first start nor a clear goes on
   * without it.
   */
  private async acquireMetaLock(): Promise<() => Promise<void>> {
    const release = await this.lock(USAGE_FILES.metaLock).acquire(this.lockWaitMs())
    if (release === undefined) throw new Error(`the usage ${USAGE_FILES.meta} lock is held`)
    return release
  }

  /**
   * One provider's open entries and window state from `open.json`.
   * - An entry already in a closed file (a crash between the append and the
   *   open rewrite) is taken from there: the stale open copy is not
   *   restored, and the series that referred to it continues without it.
   * - An open entry no restored series refers to was another process's
   *   (both write one file, and the last writer's window state wins). No
   *   process may follow it after a restart, so it is closed at `at`, like
   *   an entry this process stops following after a clear, and
   *   moved to its closed file at the next save. A process still running
   *   that holds it adds its later counts to that closed line.
   * - What a failed purge left of a clear at `cutoff` (entries counted
   *   before it, window state written before it) is not restored;
   *   the purge is retried at the next clear or startup.
   */
  private async restore(provider: TrackedProvider, at: number, cutoff: number): Promise<{ accounts: AccountState[], entries: WindowUsageEntry[] }> {
    const file = await this.readOpen(provider)
    const closedIds = await this.closedIds(provider)
    const stale = new Set(file.entries.filter(entry => closedIds.has(entry.id)).map(entry => entry.id))
    if (stale.size > 0) this.staleOpen.set(provider, stale)
    const entries = new Map(file.entries
      .filter(entry => entry.status === 'open' && !stale.has(entry.id) && entry.countedFrom >= cutoff)
      .map(entry => [entry.id, entry]))
    const accounts = stateUnderClear(file, cutoff)
    const referred = new Set<string>()
    for (const account of accounts) {
      if (account.pending !== undefined && !refer(account.pending)) delete account.pending
      for (const series of account.series) {
        if (series.open !== undefined && !refer(series.open)) delete series.open
        if (series.window0 !== undefined && !refer(series.window0)) delete series.window0
      }
    }
    const restored = [...entries.values()].filter(entry => referred.has(entry.id))
    const orphans = [...entries.values()].filter(entry => !referred.has(entry.id))
    for (const entry of orphans) this.closingOf(provider).set(entry.id, closeAtDiscovery(entry, at))
    // Loaded entries are already on disk: this process's committed share of
    // them is what it loaded, so only later counts are its delta.
    this.baselines.set(provider, new Map([...restored, ...orphans].map(entry => [entry.id, pickAggregate(entry)])))
    this.heldBaselines.set(provider, heldState(accounts))
    return { accounts, entries: restored }

    function refer(id: string): boolean {
      if (!entries.has(id)) return false
      referred.add(id)
      return true
    }
  }

  /** Clear in this process: cut-off first, then forget, then purge (this provider's failure is thrown). */
  private async clear(provider: TrackedProvider): Promise<void> {
    const at = this.now()
    const release = await this.acquireMetaLock()
    try {
      const meta = await this.readMeta() ?? this.meta
      if (meta === undefined) throw new Error('usage tracking is not active')
      const prev = meta.clearedAt[provider]
      meta.clearedAt[provider] = prev === undefined ? at : Math.max(prev + 1, at)
      await writeAtomic(this.fs, join(this.dir, USAGE_FILES.meta), `${JSON.stringify(meta, null, 2)}\n`)
      this.meta = { ...meta, clearedAt: { ...meta.clearedAt } }
    } finally {
      await release()
    }
    const clearedAt = this.meta.clearedAt[provider] ?? at
    this.forget(provider, clearedAt)
    for (const other of USAGE_TRACKED_PROVIDERS) {
      const cut = this.meta.clearedAt[other]
      if (other === provider || cut === undefined) continue
      await this.purge(other, cut).catch(error => {
        this.warn(`usage history for ${other} could not be fully removed after its clear; retried later: ${errorMessage(error)}`)
      })
    }
    await this.purge(provider, clearedAt)
  }

  /** Drop this process's memory of `provider` (entries, deltas, pending closes). */
  private forget(provider: TrackedProvider, clearedAt: number): void {
    const tracker = this.live
    this.baselines.delete(provider)
    this.heldBaselines.delete(provider)
    this.heldPromotions.delete(provider)
    this.staleOpen.delete(provider)
    this.closing.delete(provider)
    this.reclassified.delete(provider)
    this.dirty.delete(provider)
    tracker?.clear(provider, clearedAt)
  }

  /**
   * Remove everything of `provider` counted before `clearedAt`, under its
   * lock: `pre-tracking.json` (never recomputed after a clear, C4), entries
   * of `open.json` and the closed files counted before it (a file left empty
   * is deleted), the window state in `open.json`, and the directory once
   * empty. Idempotent, so it is safe to re-run at every startup.
   */
  private async purge(provider: TrackedProvider, clearedAt: number): Promise<void> {
    const release = await this.lock(provider).acquire(this.lockWaitMs())
    if (release === undefined) throw new Error(`the ${provider} usage lock is held`)
    try {
      await this.fs.rm(join(this.providerDir(provider), USAGE_FILES.preTracking))
      const file = await this.readOpen(provider)
      const kept = file.entries.filter(entry => entry.countedFrom >= clearedAt)
      const accounts = stateUnderClear(file, clearedAt)
      // Invalid records (no `countedFrom` to judge) go with the clear, like
      // the damaged files moved aside before it (below).
      if (kept.length === 0 && accounts.length === 0) await this.fs.rm(this.openPath(provider))
      else if (kept.length < file.entries.length || accounts.length < file.accounts.length || (file.dropped ?? 0) > 0) {
        const next: OpenFile = { v: 1, clearedAt, entries: kept, accounts }
        await writeAtomic(this.fs, this.openPath(provider), `${JSON.stringify(next, null, 2)}\n`)
      }
      for (const path of await this.closedPaths(provider)) {
        const lines = await this.readClosed(provider, path)
        const survivors = lines.filter(line => line.entry !== undefined && line.entry.countedFrom >= clearedAt)
        if (survivors.length === lines.length) continue
        if (survivors.length === 0) await this.fs.rm(path)
        else await writeAtomic(this.fs, path, survivors.map(line => `${line.text}\n`).join(''))
      }
      // A damaged `open.json` moved aside before the clear holds pre-clear data too.
      for (const name of await this.fs.readdir(this.providerDir(provider))) {
        const mark = name.indexOf(USAGE_FILES.corruptMark)
        if (mark >= 0 && Number(name.slice(mark + USAGE_FILES.corruptMark.length)) < clearedAt) await this.fs.rm(join(this.providerDir(provider), name))
      }
      if ((await this.fs.readdir(this.providerDir(provider))).length === 0) await this.removeEmptyDir(provider)
    } finally {
      await release()
    }
  }

  private async removeEmptyDir(provider: TrackedProvider): Promise<void> {
    try {
      await this.fs.rm(this.providerDir(provider), { recursive: true })
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
}

/**
 * The non-blank lines of a closed file, each with its line number: parsed and
 * allowlisted when it is a valid entry, kept verbatim with no
 * `entry` otherwise.
 */
export function parseClosed(provider: TrackedProvider, text: string): ClosedLine[] {
  return text.split('\n').flatMap((line, index) => {
    if (line.trim() === '') return []
    try {
      const entry = sanitizeEntry(provider, parseJsonText(line))
      return [entry === undefined ? { text: line, line: index + 1 } : { text: line, entry, line: index + 1 }]
    } catch {
      return [{ text: line, line: index + 1 }]
    }
  })
}

/**
 * The window state of `file` if it was written under the clear `cutoff`
 * excludes snapshots taken before that clear, which anchor windows to
 * snapshots taken before it, which must not re-open after it.
 */
function stateUnderClear(file: OpenFile, cutoff: number): AccountState[] {
  return (file.clearedAt ?? Number.NEGATIVE_INFINITY) === cutoff ? file.accounts : []
}

/** Reconcile latest & peak observed quota utilization across two copies of one entry. */
function mergeQuotaFields(
  a: Pick<WindowUsageEntry, 'quotaUsedPercent' | 'quotaPeakPercent' | 'quotaObservedAt'>,
  b: Pick<WindowUsageEntry, 'quotaUsedPercent' | 'quotaPeakPercent' | 'quotaObservedAt'> | undefined,
): Pick<WindowUsageEntry, 'quotaUsedPercent' | 'quotaPeakPercent' | 'quotaObservedAt'> {
  const peaks = [a.quotaPeakPercent, a.quotaUsedPercent, b?.quotaPeakPercent, b?.quotaUsedPercent]
    .filter((v): v is number => v !== undefined)
  const quotaPeakPercent = peaks.length === 0 ? undefined : Math.max(...peaks)

  let quotaUsedPercent: number | undefined
  let quotaObservedAt: number | undefined
  const aObs = a.quotaObservedAt
  const bObs = b?.quotaObservedAt
  if (a.quotaUsedPercent !== undefined && b?.quotaUsedPercent !== undefined) {
    if (aObs !== undefined && bObs !== undefined) {
      if (bObs > aObs) {
        quotaUsedPercent = b.quotaUsedPercent
        quotaObservedAt = bObs
      } else {
        quotaUsedPercent = a.quotaUsedPercent
        quotaObservedAt = aObs
      }
    } else if (bObs !== undefined) {
      quotaUsedPercent = b.quotaUsedPercent
      quotaObservedAt = bObs
    } else {
      quotaUsedPercent = a.quotaUsedPercent
      quotaObservedAt = aObs
    }
  } else if (a.quotaUsedPercent !== undefined) {
    quotaUsedPercent = a.quotaUsedPercent
    quotaObservedAt = aObs
  } else if (b?.quotaUsedPercent !== undefined) {
    quotaUsedPercent = b.quotaUsedPercent
    quotaObservedAt = bObs
  }

  return {
    ...quotaUsedPercent === undefined ? {} : { quotaUsedPercent },
    ...quotaPeakPercent === undefined ? {} : { quotaPeakPercent },
    ...quotaObservedAt === undefined ? {} : { quotaObservedAt },
  }
}

/** `entry` (this process's view) with the stored copy's sums plus `delta`, reconciled quota %, and the later `lastAddedAt`. */
function withSums(entry: WindowUsageEntry, stored: WindowUsageEntry | undefined, delta: Aggregate): WindowUsageEntry {
  const lastAddedAt = Math.max(entry.lastAddedAt ?? Number.NEGATIVE_INFINITY, stored?.lastAddedAt ?? Number.NEGATIVE_INFINITY)
  const { days: _localDays, quotaUsedPercent: _lu, quotaPeakPercent: _lp, quotaObservedAt: _lo, ...base } = entry
  const days = combineDays(stored?.days, delta.days)
  const quota = mergeQuotaFields(entry, stored)
  return {
    ...base,
    models: combineModels(stored?.models ?? {}, delta.models),
    ...Object.keys(days).length === 0 ? {} : { days },
    ...Number.isFinite(lastAddedAt) ? { lastAddedAt } : {},
    ...quota,
  }
}

function pickAggregate(entry: Aggregate): Aggregate {
  return { models: entry.models, ...entry.days === undefined ? {} : { days: entry.days } }
}

function aggregateDelta(entry: Aggregate, baseline: Aggregate | undefined): Aggregate {
  return {
    models: combineModels(entry.models, baseline?.models ?? {}, -1),
    days: combineDays(entry.days, baseline?.days, -1),
  }
}

function heldKey(account: string, series: string): string {
  return JSON.stringify([account, series])
}

function heldState(accounts: readonly AccountState[]): Map<string, Held> {
  return new Map(accounts.flatMap(account => account.series.flatMap(series =>
    series.held === undefined ? [] : [[heldKey(account.account, series.key), structuredClone(series.held)] as const])))
}

function mergeAggregates(a: Aggregate, b: Aggregate | undefined): Aggregate {
  if (b === undefined) return a
  return { models: combineModels(a.models, b.models), days: combineDays(a.days, b.days) }
}

function clampNonNegativeModels(models: ModelSums): ModelSums {
  const clamped: ModelSums = {}
  for (const [model, counts] of Object.entries(models)) {
    const next = Object.fromEntries(REQUIRED_BUCKETS.map(bucket => [bucket, Math.max(0, counts[bucket])])) as unknown as TokenCounts
    for (const bucket of SPLIT_BUCKETS) {
      if (counts[bucket] !== undefined) next[bucket] = Math.max(0, counts[bucket])
    }
    if (!zeroModels({ next })) clamped[model] = next
  }
  return clamped
}

function clampNonNegativeDays(days: DaySums | undefined): DaySums | undefined {
  if (days === undefined) return undefined
  const clamped: DaySums = {}
  for (const [day, models] of Object.entries(days)) {
    const sums = clampNonNegativeModels(models)
    if (!zeroModels(sums)) clamped[day] = sums
  }
  return Object.keys(clamped).length === 0 ? undefined : clamped
}

/**
 * A held sum is shared on disk, but each process holds its own snapshot of
 * it. Merge just the unsaved model/day deltas. If a peer has already moved
 * this held period into an open successor, route stale-process deltas to
 * that successor and keep the disk series. Otherwise, when this process
 * promoted its held sum into a tracked entry id, route the disk held
 * adjustment to that exact entry (even if it already closed before flush),
 * never into an unrelated newer open window.
 */
function mergeHeldAccounts(
  own: readonly AccountState[], stored: readonly AccountState[], baseline: ReadonlyMap<string, Held> | undefined,
  promotions: ReadonlyMap<string, string> | undefined,
  entries: ReadonlyMap<string, WindowUsageEntry>,
): { accounts: AccountState[], transfers: ReadonlyMap<string, Aggregate> } {
  const current = new Map(stored.map(account => [account.account, new Map(account.series.map(series => [series.key, series]))]))
  const transfers = new Map<string, Aggregate>()
  const transfer = (id: string, sums: Aggregate) => transfers.set(id, mergeAggregates(transfers.get(id) ?? { models: {} }, sums))
  const accounts = own.map(account => ({ ...account, series: account.series.map(series => {
    const key = heldKey(account.account, series.key)
    const disk = current.get(account.account)?.get(series.key)
    const other = disk?.held
    const previous = baseline?.get(key)
    const local = series.held
    const promotedId = promotions?.get(key)
    const diskOpen = disk?.open === undefined ? undefined : entries.get(disk.open)

    if (local !== undefined && diskOpen !== undefined && diskOpen.countedFrom >= (series.lastEnd ?? local.countedFrom)) {
      transfer(diskOpen.id, aggregateDelta(local, previous))
      return disk ?? series
    }
    if (local === undefined && promotedId !== undefined && (other !== undefined || previous !== undefined)) {
      // The local tracker already included `previous` in `promotedId` (which
      // may still be open or may have closed before this flush). Replace that
      // committed snapshot with the current disk allocation, which is empty if
      // another process already promoted the same hold.
      transfer(promotedId, aggregateDelta(other ?? { models: {} }, previous))
      return series
    }

    const delta = aggregateDelta(local ?? { models: {} }, previous)
    const models = clampNonNegativeModels(combineModels(other?.models ?? {}, delta.models))
    const days = clampNonNegativeDays(combineDays(other?.days, delta.days))
    const output = { ...series }
    if ((local === undefined && other === undefined) || zeroModels(models)) {
      delete output.held
    } else {
      output.held = {
        countedFrom: Math.min(local?.countedFrom ?? Infinity, other?.countedFrom ?? Infinity),
        lastAddedAt: Math.max(local?.lastAddedAt ?? -Infinity, other?.lastAddedAt ?? -Infinity),
        models,
        ...days === undefined ? {} : { days },
      }
    }
    return output
  }) }))
  return { accounts, transfers }
}

/** an entry this process stops following at `at`; a Window 0 closes, a real entry ends early as detected. */
function closeAtDiscovery(entry: WindowUsageEntry, at: number): WindowUsageEntry {
  return entry.window0 === undefined
    ? { ...entry, status: 'ended-early', endedAt: at, endReason: 'detected' }
    : { ...entry, status: 'closed', endedAt: at }
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key)
  if (value === undefined) {
    value = create()
    map.set(key, value)
  }
  return value
}

function isEntry(entry: WindowUsageEntry | undefined): entry is WindowUsageEntry {
  return entry !== undefined
}

function isAccount(account: AccountState | undefined): account is AccountState {
  return account !== undefined
}

/** Whether `work` settles within `ms`; the bound's timer is cleared as soon as it does. */
async function finishesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  const bound = sleep(ms)
  try {
    return await Promise.race([work.then(() => true, () => true), bound.then(() => false)])
  } finally {
    bound.cancel()
  }
}
