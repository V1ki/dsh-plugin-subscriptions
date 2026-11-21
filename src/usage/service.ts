/**
 * The usage service: the side-effect
 * boundary between the stored entries and the pure view model.
 *
 * - Open entries come from this process's memory (the window store), so a
 *   finished request shows before any save. Other processes' committed open
 *   entries come from `open.json`, and closed windows from `closed-YYYY.jsonl`.
 * - A provider's files are read only when that provider is read. Each file is
 *   cached by size and modification time, so later navigation re-reads
 *   nothing, and an append or flush invalidates exactly that file.
 * - The before-tracking total is read once it is stored (or cleared); while
 *   "not computed" it is re-checked, so a scan finishing later shows up.
 * - No DSH session is scanned and no quota is fetched by this reader.
 * - A damaged file or line is skipped and named in `errors[]`; it never
 *   fails the result (SVC-ERRORS).
 */
import { isAbsolute, join, relative, sep } from 'node:path'
import { parseJsonText } from '../json-text.js'
import { USAGE_FILES, type TrackedProvider } from './constants.js'
import type { PreTracking, PreTrackingStatus } from './pre-tracking.js'
import { combineDays, combineModels, parseMeta, parseOpenFile, parsePreTracking } from './usage-schema.js'
import { errorCode, nodeUsageFileSystem, readOptional, type UsageFileSystem } from './usage-files.js'
import { parseClosed, type WindowStore } from './window-store.js'
import type { WindowUsageEntry } from './window-tracker.js'
import { buildUsageView, type UsageView, type ViewQuery } from './window-view.js'

/** What the service needs from the window store. */
export type UsageStoreView = Pick<WindowStore, 'dir' | 'ready' | 'trackingStartedAt' | 'tracker' | 'entries' | 'unsavedDeltas' | 'unsavedDayDeltas' | 'clearedAt' | 'clearProvider'>

export interface UsageServiceOptions {
  store: UsageStoreView
  /** The before-tracking totals; absent reads as "unavailable" (PRE-HEADLESS). */
  preTracking?: Pick<PreTracking, 'status'>
  fs?: UsageFileSystem
}

export interface AccountUsageQuery extends ViewQuery {
  provider: TrackedProvider
  account: string
}

export interface AccountUsageResult {
  view: UsageView
  /** Damaged files or lines that were skipped (SVC-ERRORS). */
  errors: string[]
}

/** What a clear would remove. */
export interface StoredSummary {
  /** Accounts with visible stored history. */
  accounts: number
  /** Earliest `countedFrom` of the stored windows; absent when nothing is stored. */
  from?: number
  /**
   * Latest end of the stored windows, each ending as §3.5 defines it:
   * `endedAt`, else its reset (also for an open window, so this can lie in
   * the future), else its last counted request; absent when nothing is stored.
   */
  to?: number
  /** A non-empty before-tracking total is stored; listed as "earlier history" without dates. */
  earlierHistory: boolean
}

export interface ClearResult {
  clearedAt: number
  /** A purge that failed after the cut-off was written: the cut-off holds and the purge is retried. */
  errors: string[]
}

/** Usage tracking is off in this process, or the service was disposed. */
export class UsageUnavailable extends Error {
  readonly code = 'USAGE_UNAVAILABLE'
}

/** Stands in for an error with no plain code. */
const NO_ERROR_CODE = 'no error code'

const SERVICE_ERRORS = {
  disposed: 'the usage service was disposed',
  inactive: 'usage tracking is not active',
  openInvalid: (path: string) => `${path}: not a valid open-entries file; its entries were skipped`,
  openDropped: (path: string, count: number) => `${path}: ${count} invalid record(s) skipped`,
  closedLine: (path: string, line: number) => `${path} line ${line}: not a valid entry; skipped`,
  preTrackingInvalid: (path: string) => `${path}: not a valid total; earlier history shows as not computed`,
  // Only a code, never the error's message: Node file errors quote absolute paths (SVC-ERRORS).
  unreadable: (path: string, error: unknown) => `${path}: could not be read (${errorCode(error) ?? NO_ERROR_CODE})`,
  clearIncomplete: (label: string, error: unknown) => `${label}: usage history could not be fully cleared (${errorCode(error) ?? NO_ERROR_CODE}); the cut-off holds and the removal is retried`,
  clearNotRecorded: (provider: string) => `the clear of ${provider} was not recorded`,
} as const

/** Pre-tracking states that cannot change without a clear, so they are cached. */
const FINAL_TOTAL_STATES: ReadonlySet<PreTrackingStatus['state']> = new Set(['stored', 'cleared'])

/** One file's parsed content, valid while its stat key is unchanged. */
interface CachedFile {
  key: string
  entries: WindowUsageEntry[]
  errors: string[]
}

interface ProviderCache {
  files: Map<string, CachedFile>
  total?: PreTrackingStatus
}

interface Loaded {
  entries: WindowUsageEntry[]
  errors: string[]
  total: PreTrackingStatus
  clearedAt?: number
}

function isClosedFile(name: string): boolean {
  return name.startsWith(USAGE_FILES.closedPrefix) && name.endsWith(USAGE_FILES.closedSuffix)
}

function parseOpen(provider: TrackedProvider, path: string, text: string): Omit<CachedFile, 'key'> {
  let parsed: ReturnType<typeof parseOpenFile>
  try {
    parsed = parseOpenFile(provider, parseJsonText(text))
  } catch {
    parsed = undefined
  }
  if (parsed === undefined) return { entries: [], errors: [SERVICE_ERRORS.openInvalid(path)] }
  return { entries: parsed.file.entries, errors: parsed.dropped > 0 ? [SERVICE_ERRORS.openDropped(path, parsed.dropped)] : [] }
}

function parseClosedFile(provider: TrackedProvider, path: string, text: string): Omit<CachedFile, 'key'> {
  const lines = parseClosed(provider, text)
  return {
    entries: lines.flatMap(line => line.entry === undefined ? [] : [line.entry]),
    errors: lines.flatMap(line => line.entry === undefined ? [SERVICE_ERRORS.closedLine(path, line.line ?? 0)] : []),
  }
}

export class UsageService {
  private readonly store: UsageStoreView
  private readonly preTracking: Pick<PreTracking, 'status'> | undefined
  private readonly fs: UsageFileSystem
  private readonly caches = new Map<TrackedProvider, ProviderCache>()
  /** Bumped by every clear, so a read that overlapped one starts again and never caches or shows pre-clear data. */
  private readonly generations = new Map<TrackedProvider, number>()
  private disposed = false

  constructor(options: UsageServiceOptions) {
    this.store = options.store
    this.preTracking = options.preTracking
    this.fs = options.fs ?? nodeUsageFileSystem
  }

  /**
   * One account's view for one query, with the damaged data that was
   * skipped.
   * @throws UsageUnavailable when tracking is off or the service was disposed.
   */
  async read(query: AccountUsageQuery): Promise<AccountUsageResult> {
    const { provider, account, ...viewQuery } = query
    const { entries, errors, total, clearedAt } = await this.load(provider)
    const trackingStartedAt = this.store.trackingStartedAt
    if (trackingStartedAt === undefined) throw new UsageUnavailable(SERVICE_ERRORS.inactive)
    const view = buildUsageView({
      provider,
      account,
      entries,
      observed: this.store.tracker?.observedWindows(provider, account) ?? [],
      trackingStartedAt,
      ...clearedAt === undefined ? {} : { clearedAt },
      preTracking: total,
    }, viewQuery)
    return { view, errors }
  }

  /**
   * Accounts that have stored, visible history (any account, including one
   * removed from settings), in key order.
   * @throws UsageUnavailable when tracking is off or the service was disposed.
   */
  async accounts(provider: TrackedProvider): Promise<string[]> {
    return [...new Set((await this.visible(provider)).map(entry => entry.account))].sort()
  }

  /**
   * What the provider has stored, for the clear confirmation.
   * @throws UsageUnavailable when tracking is off or the service was disposed.
   */
  async summary(provider: TrackedProvider): Promise<StoredSummary> {
    const { entries: all, total, clearedAt } = await this.load(provider)
    const entries = all.filter(entry => entry.countedFrom >= (clearedAt ?? Number.NEGATIVE_INFINITY))
    const ends = entries.map(entry => entry.endedAt ?? entry.resetsAt ?? entry.lastAddedAt ?? entry.countedFrom)
    return {
      accounts: new Set(entries.map(entry => entry.account)).size,
      ...entries.length === 0 ? {} : { from: Math.min(...entries.map(entry => entry.countedFrom)), to: Math.max(...ends) },
      // An empty stored total has nothing to remove.
      earlierHistory: total.state === 'stored' && Object.keys(total.total.models).length > 0,
    }
  }

  /** The provider's entries a reader may show: none counted before its clear. */
  private async visible(provider: TrackedProvider): Promise<WindowUsageEntry[]> {
    const { entries, clearedAt } = await this.load(provider)
    return entries.filter(entry => entry.countedFrom >= (clearedAt ?? Number.NEGATIVE_INFINITY))
  }

  /**
   * Clear one provider's history through the store, and drop its
   * caches. No real window is re-opened.
   * @returns the new cut-off, and the purge error when only the delete failed.
   * @throws when this clear's cut-off was not written (an earlier clear's
   *   cut-off does not count): nothing was cleared.
   */
  async clear(provider: TrackedProvider): Promise<ClearResult> {
    this.ensureOpen()
    const before = this.store.clearedAt(provider) ?? Number.NEGATIVE_INFINITY
    this.invalidate(provider)
    const errors: string[] = []
    try {
      await this.store.clearProvider(provider)
    } catch (error) {
      errors.push(SERVICE_ERRORS.clearIncomplete(this.relativeLabel(provider, error), error))
    } finally {
      this.invalidate(provider)
    }
    const clearedAt = this.store.clearedAt(provider)
    if (clearedAt === undefined || clearedAt <= before) throw new Error(errors[0] ?? SERVICE_ERRORS.clearNotRecorded(provider))
    return { clearedAt, errors }
  }

  /** Later reads and clears are refused; a read in flight is rejected, never left unhandled. */
  dispose(): void {
    this.disposed = true
    this.caches.clear()
  }

  /**
   * The file a file-system error names, relative to the usage directory (for
   * example `claude/open.json`), or `<provider>/` when it names none or one
   * outside it: an absolute path never reaches a result (SVC-ERRORS).
   */
  private relativeLabel(provider: TrackedProvider, error: unknown): string {
    const path = typeof error === 'object' && error !== null && 'path' in error && typeof error.path === 'string' ? error.path : undefined
    const inside = path === undefined ? undefined : relative(this.store.dir, path)
    if (inside === undefined || inside === '' || isAbsolute(inside) || inside.startsWith('..')) return `${provider}/`
    return inside.split(sep).join('/')
  }

  private ensureOpen(): void {
    if (this.disposed) throw new UsageUnavailable(SERVICE_ERRORS.disposed)
  }

  private invalidate(provider: TrackedProvider): void {
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1)
    this.caches.delete(provider)
  }

  /** The provider's entries (memory first, then `open.json`, then closed files), errors and total; restarted if a clear overlapped. */
  private async load(provider: TrackedProvider): Promise<Loaded> {
    this.ensureOpen()
    await this.store.ready
    for (;;) {
      this.ensureOpen()
      const generation = this.generations.get(provider) ?? 0
      const cache: ProviderCache = { files: new Map(this.caches.get(provider)?.files) }
      const previousTotal = this.caches.get(provider)?.total
      const cutoff = await this.readClearCutoff(provider)
      const files = await this.readFiles(provider, cache)
      const total: PreTrackingStatus = cutoff !== undefined
        ? { state: 'cleared' } : previousTotal ?? await this.readTotal(provider, files.errors)
      const after = await this.readClearCutoff(provider)
      this.ensureOpen()
      if (cutoff !== after || generation !== (this.generations.get(provider) ?? 0)) continue
      if (FINAL_TOTAL_STATES.has(total.state)) cache.total = total
      this.caches.set(provider, cache)
      return { entries: this.combine(provider, files.entries), errors: files.errors, total, ...cutoff === undefined ? {} : { clearedAt: cutoff } }
    }
  }

  /** Reads the shared clear marker even when this process has not saved since a peer cleared. */
  private async readClearCutoff(provider: TrackedProvider): Promise<number | undefined> {
    const local = this.store.clearedAt(provider)
    try {
      const raw = await readOptional(this.fs, join(this.store.dir, USAGE_FILES.meta))
      const shared = raw === undefined ? undefined : parseMeta(parseJsonText(raw))?.clearedAt[provider]
      if (shared === undefined) return local
      return local === undefined ? shared : Math.max(local, shared)
    } catch {
      return local
    }
  }

  /**
   * This process's entries joined with the stored ones. An id that is
   * also stored may carry another process's committed counts, which this
   * process's memory never sees: each stored copy gets this process's unsaved
   * delta added, and the in-memory copy (first, with this process's latest
   * boundaries) takes the sums of the closed copy if there is one, else the
   * open one. The view then lets a closed copy win, and nothing is
   * counted twice or hidden.
   */
  private combine(provider: TrackedProvider, stored: readonly WindowUsageEntry[]): WindowUsageEntry[] {
    const deltas = this.store.unsavedDeltas(provider)
    const dayDeltas = this.store.unsavedDayDeltas(provider)
    const withDelta = stored.map(entry => {
      const delta = deltas.get(entry.id)
      const days = dayDeltas.get(entry.id)
      return {
        ...entry,
        ...delta === undefined ? {} : { models: combineModels(entry.models, delta) },
        ...days === undefined ? {} : { days: combineDays(entry.days, days) },
      }
    })
    const preferred = new Map<string, WindowUsageEntry>()
    for (const entry of withDelta) {
      const kept = preferred.get(entry.id)
      if (kept === undefined || (kept.status === 'open' && entry.status !== 'open')) preferred.set(entry.id, entry)
    }
    const memory = this.store.entries(provider).map(entry => {
      const copy = preferred.get(entry.id)
      return copy === undefined ? entry : { ...entry, models: copy.models, ...copy.days === undefined ? {} : { days: copy.days } }
    })
    return [...memory, ...withDelta]
  }

  /** `open.json` and every closed file of the provider, each from cache while its stat key is unchanged. */
  private async readFiles(provider: TrackedProvider, cache: ProviderCache): Promise<{ entries: WindowUsageEntry[], errors: string[] }> {
    const dir = join(this.store.dir, provider)
    let listed: string[]
    try {
      listed = await this.fs.readdir(dir)
    } catch (error) {
      // The directory itself is unreadable: serve memory only and say so, never fail the read (SVC-ERRORS).
      return { entries: [], errors: [SERVICE_ERRORS.unreadable(`${provider}/`, error)] }
    }
    const names = listed.filter(name => name === USAGE_FILES.open || isClosedFile(name)).sort()
    for (const cached of [...cache.files.keys()]) if (!names.includes(cached)) cache.files.delete(cached)
    // `open.json` first, so its entries precede the closed copies (STORE-DEDUP).
    const ordered = [...names.filter(name => name === USAGE_FILES.open), ...names.filter(isClosedFile)]
    const entries: WindowUsageEntry[] = []
    const errors: string[] = []
    for (const name of ordered) {
      const file = await this.readFile(provider, join(dir, name), `${provider}/${name}`, cache.files.get(name))
      if (file === undefined) cache.files.delete(name)
      else {
        cache.files.set(name, file)
        entries.push(...file.entries)
        errors.push(...file.errors)
      }
    }
    return { entries, errors }
  }

  /** One file, re-read only when its size or modification time changed; `undefined` when it vanished meanwhile. */
  private async readFile(provider: TrackedProvider, path: string, label: string, cached: CachedFile | undefined): Promise<CachedFile | undefined> {
    try {
      const stat = await this.fs.stat(path)
      // ctime too: a same-size rewrite within one coarse mtime tick still changes it.
      const key = `${stat.mtimeMs}:${stat.ctimeMs ?? ''}:${stat.size ?? ''}`
      if (cached?.key === key) return cached
      const text = await readOptional(this.fs, path)
      if (text === undefined) return undefined
      const parse = label.endsWith(USAGE_FILES.open) ? parseOpen : parseClosedFile
      return { key, ...parse(provider, label, text) }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      return { key: '', entries: [], errors: [SERVICE_ERRORS.unreadable(label, error)] }
    }
  }

  /** The before-tracking status; a damaged stored total is named in `errors`. */
  private async readTotal(provider: TrackedProvider, errors: string[]): Promise<PreTrackingStatus> {
    const status = await this.preTracking?.status(provider) ?? { state: 'unavailable' as const }
    if (status.state !== 'not-computed') return status
    const label = `${provider}/${USAGE_FILES.preTracking}`
    try {
      const text = await readOptional(this.fs, join(this.store.dir, provider, USAGE_FILES.preTracking))
      if (text !== undefined && parsePreTracking(parseJsonText(text)) === undefined) errors.push(SERVICE_ERRORS.preTrackingInvalid(label))
    } catch (error) {
      errors.push(error instanceof SyntaxError ? SERVICE_ERRORS.preTrackingInvalid(label) : SERVICE_ERRORS.unreadable(label, error))
    }
    return status
  }
}
