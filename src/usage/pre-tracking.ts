/**
 * DSH's session history up to `trackingStartedAt`, folded once and
 * stored per provider as UTC daily totals in `<provider>/pre-tracking.json`.
 *
 * Two parts:
 * - {@link PreTrackingFolder}, pure: session logs in, per-provider daily and
 *   model sums out.
 * - {@link PreTracking}, the side-effect boundary: the one-time background
 *   scan through `ctx.sessionQuery`, the atomic write, and the status a
 *   reader shows. Nothing here runs on the request path, and reading the
 *   status never touches the session history (PRE-ONCE).
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { parseJsonText } from '../json-text.js'
import {
  USAGE_DIR_SEGMENTS, USAGE_FILES, USAGE_LOCK_STALE_MS, USAGE_SHUTDOWN_LOCK_WAITS, USAGE_TRACKED_PROVIDERS, type TrackedProvider,
} from './constants.js'
import { HOST_EVENT, HOST_STREAM, type HostSessionEvent, type HostSessionLog, type HostSessionQuery, type HostTokenUsage } from './host-events.js'
import { servedModel, usageCounts } from './request-counts.js'
import { parsePreTracking, pruneModels, modelsOfDays, type DaySums, type ModelSums, type PreTrackingTotal, type UsageMeta } from './usage-schema.js'
import {
  errorCode, nodeUsageFileSystem, readOptional, readUsageMeta, sleep, usageLock, usageLockWaitMs, writeAtomic, type UsageFileSystem,
} from './usage-files.js'
import { addModel, emptyCounts, isTrackedProvider, overflows, validCounts, type TokenCounts } from './window-tracker.js'

export type { PreTrackingTotal } from './usage-schema.js'

/** What the fold of a whole history gives. */
export interface PreTrackingFold {
  /** Totals per provider and model, the sum of `days`. */
  totals: Record<TrackedProvider, ModelSums>
  /** Totals per provider, UTC day and model. */
  days: Record<TrackedProvider, DaySums>
  /** Usage samples with no provider at all: in no total, reported as a diagnostic. */
  unattributed: number
  /** Usage samples rejected whole: a bucket not a non-negative safe integer, or a sum past `MAX_SAFE_INTEGER`. */
  invalid: number
}

/** A route: the provider and the served model of one usage sample. */
interface Route {
  provider: string
  model: string
}

/**
 * The (turn, step) slot of the latest usage sample, and where it was
 * counted. A later sample in the same slot replaces it.
 */
interface Slot {
  turn: number
  step: number
  /** The provider, model and UTC day the sample was added to; absent when it was not counted. */
  counted?: { provider: TrackedProvider, model: string, day: string, counts: TokenCounts }
}

/** What {@link PreTrackingFolder.count} returns for a sample rejected whole, as opposed to one merely not counted. */
const REJECTED = Symbol('rejected')

/** How a scan failure or a skipped session's reason is told in a warning. */
const FAILURE_REASON = {
  /**
   * An error code shown as is: an identifier such as DSH's
   * `SESSION_QUERY_CORRUPT_SESSION` or Node's `ENOENT`. Anything else, and
   * every error message, could carry text from the session log or its path,
   * so it is replaced by {@link unknownReason}.
   */
  codePattern: /^[A-Z][A-Z0-9_]*$/,
  /** Also the reason of a scan failure, so it names no cause it cannot know. */
  unknownReason: 'no error code',
  /** The code of the scan's own failure to take a provider's lock, so its warning still says why. */
  lockHeld: 'USAGE_LOCK_HELD',
} as const

/** The reason a warning gives for `error`: its code when that is a plain identifier, else a fixed word. */
function failureReason(error: unknown): string {
  const code = errorCode(error)
  return code !== undefined && FAILURE_REASON.codePattern.test(code) ? code : FAILURE_REASON.unknownReason
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function routeOf(value: unknown): Route | undefined {
  if (!isObject(value) || typeof value.provider !== 'string' || value.provider === '' || typeof value.model !== 'string') return undefined
  return { provider: value.provider, model: value.model }
}

/**
 * A DSH token-usage value, or `undefined` when there is none. Its buckets
 * are checked by the caller, so a usage object with a missing required
 * bucket is counted as invalid rather than passed over.
 */
function usageOf(value: unknown): HostTokenUsage | undefined {
  return isObject(value) ? value as unknown as HostTokenUsage : undefined
}

/** The last raw usage chunk of a compact stream (dsh-llm `lastAssistantStreamChunk(stream, 'usage')`). */
function lastStreamUsage(stream: unknown): HostTokenUsage | undefined {
  if (!Array.isArray(stream)) return undefined
  for (let at = stream.length - 1; at >= 0; at--) {
    const record: unknown = stream[at]
    if (!isObject(record) || record.type !== HOST_STREAM.rawRecord || !isObject(record.chunk)) continue
    if (record.chunk.type === HOST_STREAM.usageChunk) return usageOf(record.chunk.usage)
  }
  return undefined
}

function isTurnStep(data: Json): data is Json & { turn: number, step: number } {
  return typeof data.turn === 'number' && typeof data.step === 'number'
}

/**
 * The UTC date of an event time, 'YYYY-MM-DD', or `undefined` when the time
 * is no date a day bucket can name. The fold rejects such a sample whole, so
 * the daily sums always add up to the model totals.
 */
function utcDay(time: number): string | undefined {
  const date = new Date(time)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) return undefined
  return date.toISOString().slice(0, 10)
}

/**
 * Folds DSH session logs into per-provider, per-model totals of the usage
 * before `trackingStartedAt` (PRE-FOLD). Pure: no clock, no I/O. Logs are
 * added one at a time, so a scan never holds more than one in memory.
 *
 * Counted events:
 * - `assistant/message`: its `usage`, else the last usage chunk of its
 *   stream; route from `message.source`, else the latest `request/context`.
 * - `assistant/attempt`: the last usage chunk of its stream; route from the
 *   latest `request/context`.
 * - `compaction/summary`: its `usage` and its own route.
 * Every other event type is ignored, so an unknown type never fails a scan.
 *
 * Only events strictly before `trackingStartedAt` count: one at the instant
 * belongs to the window entries (PRE-STRADDLE). The first
 * `inheritedEventCount` events of a fork are its parent's and are counted
 * there; a `request/context` among them still sets the route of the child's
 * own events, because DSH logs it only when the route changes.
 */
export class PreTrackingFolder {
  private readonly totals = Object.fromEntries(USAGE_TRACKED_PROVIDERS.map(provider => [provider, {}])) as Record<TrackedProvider, ModelSums>
  private readonly days = Object.fromEntries(USAGE_TRACKED_PROVIDERS.map(provider => [provider, {}])) as Record<TrackedProvider, DaySums>
  private unattributed = 0
  private invalid = 0

  constructor(private readonly trackingStartedAt: number) {}

  /** Fold one session's complete log. */
  add(log: HostSessionLog): void {
    const inherited = Math.max(0, log.inheritedEventCount)
    let context: Route | undefined
    let slot: Slot | undefined
    for (const [index, event] of log.events.entries()) {
      const own = index >= inherited && event.time < this.trackingStartedAt
      if (event.type === HOST_EVENT.requestContext) {
        context = routeOf(event.data) ?? context
      } else if (event.type === HOST_EVENT.retryStarted) {
        // dsh-token-meter: a retry closes the slot, so the retried attempt adds.
        if (slot !== undefined && isObject(event.data) && slot.turn === event.data.turn && slot.step === event.data.step) slot = undefined
      } else if (event.type === HOST_EVENT.compactionSummary) {
        if (own && isObject(event.data)) this.count(routeOf(event.data), usageOf(event.data.usage), event.time)
      } else {
        const sample = this.sampleOf(event, context)
        if (sample !== undefined) slot = this.place(slot, sample, own)
      }
    }
  }

  /** The totals so far: the daily sums, and their sum per model. */
  result(): PreTrackingFold {
    // A replaced sample can leave a model at zero: no empty rows.
    const days = Object.fromEntries(USAGE_TRACKED_PROVIDERS.map(provider => [
      provider, structuredClone(pruneDays(this.days[provider])),
    ])) as Record<TrackedProvider, DaySums>
    const totals = Object.fromEntries(USAGE_TRACKED_PROVIDERS.map(provider => [
      provider, modelsOfDays(days[provider]),
    ])) as Record<TrackedProvider, ModelSums>
    return { totals, days, unattributed: this.unattributed, invalid: this.invalid }
  }

  /** The usage sample of an assistant settlement, with its slot, route and event time; `undefined` for any other event or none. */
  private sampleOf(event: HostSessionEvent, context: Route | undefined): (Slot & { route?: Route, usage: HostTokenUsage, at: number }) | undefined {
    if (event.type !== HOST_EVENT.assistantMessage && event.type !== HOST_EVENT.assistantAttempt) return undefined
    const data = event.data
    if (!isObject(data) || !isTurnStep(data)) return undefined
    const isMessage = event.type === HOST_EVENT.assistantMessage
    // dsh-token-meter: a message's `usage` wins whenever present; only the route needs `message`.
    const usage = (isMessage ? usageOf(data.usage) : undefined) ?? lastStreamUsage(data.stream)
    if (usage === undefined) return undefined
    const route = routeOf(isMessage && isObject(data.message) ? data.message.source : undefined) ?? context
    return { turn: data.turn, step: data.step, usage, at: event.time, ...route === undefined ? {} : { route } }
  }

  /**
   * dsh-token-meter's `tokenUsage` rule: a sample in the same (turn,
   * step) slot as the previous one replaces it, so its counts are taken
   * out again before the new ones are added. A replaced sample that was not
   * counted here (inherited, at or after the start, unattributed or
   * rejected) has nothing to take out. A sample that is not counted itself
   * replaces nothing: at or after the tracking start it belongs to the
   * window entries, which count every request on its own, so the earlier
   * sample stays in this total. A rejected sample is skipped whole,
   * as if it were not logged: the slot and the sample it would replace stay
   *.
   * @returns the slot held after the sample.
   */
  private place(previous: Slot | undefined, sample: Slot & { route?: Route, usage: HostTokenUsage, at: number }, own: boolean): Slot | undefined {
    if (!own) return { turn: sample.turn, step: sample.step }
    const replaced = previous?.turn === sample.turn && previous.step === sample.step ? previous.counted : undefined
    // Taken out first, so the overflow check sees the sums the sample would join.
    if (replaced !== undefined) this.removeCounted(replaced)
    const counted = this.count(sample.route, sample.usage, sample.at)
    if (counted === REJECTED) {
      if (replaced !== undefined) this.addCounted(replaced)
      return previous
    }
    return { turn: sample.turn, step: sample.step, ...counted === undefined ? {} : { counted } }
  }

  /** Add one sample to its provider's daily and model totals; `undefined` when it was not added, {@link REJECTED} when it was rejected whole. */
  private count(route: Route | undefined, usage: HostTokenUsage | undefined, at: number): Slot['counted'] | typeof REJECTED {
    if (usage === undefined) return undefined
    const counts = usageCounts(usage)
    if (!validCounts(counts)) {
      this.invalid++
      return REJECTED
    }
    if (emptyCounts(counts)) return undefined
    if (route === undefined) {
      this.unattributed++
      return undefined
    }
    // Copilot and non-subscription routes are out of scope.
    if (!isTrackedProvider(route.provider)) return undefined
    const day = utcDay(at)
    if (day === undefined) {
      // The sample cannot be put in any daily bucket, so it is left out of
      // the totals too rather than making them disagree with the days.
      this.invalid++
      return REJECTED
    }
    const model = servedModel(route.model)
    const models = this.totals[route.provider]
    const dayModels = this.days[route.provider][day] ?? {}
    if (overflows(models, model, counts) || overflows(dayModels, model, counts)) {
      this.invalid++
      return REJECTED
    }
    addModel(models, model, counts)
    addModel((this.days[route.provider][day] ??= {}), model, counts)
    return { provider: route.provider, model, day, counts }
  }

  /** Put one counted sample back, into its day and into its provider's total. */
  private addCounted(counted: NonNullable<Slot['counted']>): void {
    addModel(this.totals[counted.provider], counted.model, counted.counts)
    addModel((this.days[counted.provider][counted.day] ??= {}), counted.model, counted.counts)
  }

  /** Take one counted sample out again, dropping the day when its last model leaves. */
  private removeCounted(counted: NonNullable<Slot['counted']>): void {
    addModel(this.totals[counted.provider], counted.model, negate(counted.counts))
    const day = this.days[counted.provider][counted.day]
    if (day === undefined) return
    addModel(day, counted.model, negate(counted.counts))
    const kept = pruneModels(day)
    if (Object.keys(kept).length === 0) delete this.days[counted.provider][counted.day]
    else this.days[counted.provider][counted.day] = kept
  }
}

/** The days with their empty models and their empty days dropped. */
function pruneDays(days: DaySums): DaySums {
  const kept: DaySums = {}
  for (const [day, models] of Object.entries(days)) {
    const sums = pruneModels(models)
    if (Object.keys(sums).length > 0) kept[day] = sums
  }
  return kept
}

/**
 * `work`, or a rejection with the abort reason as soon as `signal` aborts.
 * `readSession` takes no signal on either host, so without this an aborted
 * scan would keep waiting for a read it no longer uses; the read itself is
 * left to finish and its result is dropped.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason) }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}

function negate(counts: TokenCounts): TokenCounts {
  return Object.fromEntries(Object.entries(counts).map(([bucket, value]) => [bucket, -value])) as unknown as TokenCounts
}

/** Fold a whole history at once (see {@link PreTrackingFolder}). */
export function foldSessions(logs: Iterable<HostSessionLog>, trackingStartedAt: number): PreTrackingFold {
  const fold = new PreTrackingFolder(trackingStartedAt)
  for (const log of logs) fold.add(log)
  return fold.result()
}

/** What the before-tracking block of one provider shows. */
export type PreTrackingStatus =
  /** The stored total. */
  | { state: 'stored', total: PreTrackingTotal }
  /** The provider was cleared: the total is gone for good and never recomputed. */
  | { state: 'cleared' }
  /** "Earlier history not computed yet": the scan has not stored a total yet (PRE-ONCE). */
  | { state: 'not-computed' }
  /** "Earlier history unavailable in this profile": no `sessionQuery` (PRE-HEADLESS). */
  | { state: 'unavailable' }

export interface PreTrackingOptions {
  /** Resolves the tracking start once the window store has loaded; `undefined` when tracking is disabled (no scan). */
  trackingStartedAt: () => Promise<number | undefined>
  /** The usage directory; defaults to `dshHomePath('plugins', 'subscriptions', 'usage')`, resolved at construction. */
  dir?: string
  fs?: UsageFileSystem
  /** The lock clock. */
  now?: () => number
  onWarn?: (message: string) => void
  lockStaleMs?: number
}

/**
 * The one-time scan and its stored totals.
 *
 * - A scan starts when `sessionQuery` is attached and some tracked provider
 *   that was never cleared has no total for this tracking start. It reads
 *   every session, folds them, and only then writes, one atomic file per
 *   provider. A session that cannot be read is skipped with a warning
 *  . A scan that fails or is cut short writes nothing, so the next
 *   startup scans again up to the same `trackingStartedAt` (PRE-ONCE).
 * - Each file is written under the provider's lock after re-reading
 *   `meta.json`: a clear writes `clearedAt` before it purges under that
 *   lock, so a total is never written after its clear, and one written just
 *   before is removed by the purge (PRE-CLEAR).
 * - Once every total is stored, no session is read again.
 */
export class PreTracking {
  readonly dir: string
  private readonly fs: UsageFileSystem
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private readonly lockStaleMs: number
  private readonly startedAt: () => Promise<number | undefined>
  /** The scan of the attachment that is current, if one is; a newer attachment aborts the older one's. */
  private attached: AbortController | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: PreTrackingOptions) {
    this.dir = options.dir ?? dshHomePath(...USAGE_DIR_SEGMENTS)
    this.fs = options.fs ?? nodeUsageFileSystem
    this.now = options.now ?? Date.now
    this.warn = options.onWarn ?? (() => undefined)
    this.lockStaleMs = options.lockStaleMs ?? USAGE_LOCK_STALE_MS
    this.startedAt = options.trackingStartedAt
  }

  /**
   * The session history became available: run the one-time scan in the
   * background if a total is missing. Never throws; failures are warnings.
   * @returns detach: aborts a running scan (one still reading writes
   *   nothing) and makes the history unavailable again. Its promise resolves
   *   once the scan has stopped, or after the shutdown bound with a warning
   *  : a session read cannot be cancelled on the host and the final
   *   writes wait for locks, so an unbounded wait could hang shutdown.
   */
  attach(query: HostSessionQuery): () => Promise<void> {
    this.attached?.abort()
    const controller = new AbortController()
    this.attached = controller
    this.queue = this.queue.then(() => this.scan(query, controller.signal)).catch(error => {
      if (!controller.signal.aborted) this.warn(`earlier usage history could not be computed; retried at the next startup (${failureReason(error)})`)
    })
    return async () => {
      controller.abort()
      if (this.attached === controller) this.attached = undefined
      const bound = sleep(USAGE_SHUTDOWN_LOCK_WAITS * usageLockWaitMs(this.lockStaleMs))
      try {
        const stopped = await Promise.race([this.settled().then(() => true), bound.then(() => false)])
        if (!stopped) this.warn('earlier usage history scan did not stop in time; it is retried at the next startup if it wrote nothing')
      } finally {
        bound.cancel()
      }
    }
  }

  /** Resolves when no scan is running or queued. */
  async settled(): Promise<void> {
    for (let queue = this.queue; ; queue = this.queue) {
      await queue
      if (queue === this.queue) return
    }
  }

  /**
   * The before-tracking block of `provider`. Reads only `meta.json` and the
   * provider's `pre-tracking.json`; never the session history (PRE-ONCE).
   */
  async status(provider: TrackedProvider): Promise<PreTrackingStatus> {
    const meta = await readUsageMeta(this.fs, this.dir).catch(() => undefined)
    if (meta?.clearedAt[provider] !== undefined) return { state: 'cleared' }
    const total = await this.readTotal(provider).catch(() => undefined)
    if (total !== undefined && (meta === undefined || total.trackingStartedAt === meta.trackingStartedAt)) return { state: 'stored', total }
    return this.attached === undefined ? { state: 'unavailable' } : { state: 'not-computed' }
  }

  private path(provider: TrackedProvider): string {
    return join(this.dir, provider, USAGE_FILES.preTracking)
  }

  /** The stored total, or `undefined` when there is none or it is invalid. */
  private async readTotal(provider: TrackedProvider): Promise<PreTrackingTotal | undefined> {
    const text = await readOptional(this.fs, this.path(provider))
    if (text === undefined) return undefined
    try {
      return parsePreTracking(parseJsonText(text))
    } catch {
      return undefined
    }
  }

  /**
   * The providers still needing a total: tracked, never cleared, and with
   * no valid total folded up to this tracking start. A total for another
   * start (meta.json was recreated) does not count, so it is replaced.
   */
  private async missing(meta: UsageMeta): Promise<TrackedProvider[]> {
    const missing: TrackedProvider[] = []
    for (const provider of USAGE_TRACKED_PROVIDERS) {
      if (meta.clearedAt[provider] !== undefined) continue
      const total = await this.readTotal(provider)
      // A version 1 total has no days: it is shown meanwhile, and scanned again
      // so the dashboard gets the daily sums.
      if (total?.v !== 2 || total.trackingStartedAt !== meta.trackingStartedAt) missing.push(provider)
    }
    return missing
  }

  private async scan(query: HostSessionQuery, signal: AbortSignal): Promise<void> {
    const trackingStartedAt = await this.startedAt()
    if (trackingStartedAt === undefined || signal.aborted) return
    const meta = await readUsageMeta(this.fs, this.dir)
    if (meta === undefined || meta.trackingStartedAt !== trackingStartedAt) return
    if ((await this.missing(meta)).length === 0) return
    const fold = new PreTrackingFolder(trackingStartedAt)
    for (const record of await untilAborted(query.listSessions(signal), signal)) {
      signal.throwIfAborted()
      const log = await this.readOrSkip(query, record.header.id, signal)
      if (log !== undefined) fold.add(log)
    }
    // A read that fails because the history is going away (sessionQuery's
    // persistence binding unloading) is skipped like any other before the
    // abort for that reaches this scan, so a total stored then can miss
    // those sessions for good. Not guarded: no host signal tells such a
    // failure apart, and the window is the few microtasks of an unload.
    signal.throwIfAborted()
    const result = fold.result()
    if (result.unattributed > 0) this.warn(`earlier usage history: ${result.unattributed} usage record(s) name no provider and are in no total`)
    if (result.invalid > 0) this.warn(`earlier usage history: ${result.invalid} invalid usage record(s) were skipped`)
    // Past this point the fold is complete, so the writes go on even if the
    // plugin is disposed meanwhile (detach waits for them, within its bound).
    for (const provider of USAGE_TRACKED_PROVIDERS) {
      await this.store(provider, { v: 2, trackingStartedAt, days: result.days[provider], models: result.totals[provider] })
    }
  }

  /**
   * One session's log, or `undefined` when it cannot be read: an
   * unreadable or corrupt session is skipped with one warning, and the scan
   * goes on. Failing the scan instead would fail every startup again on the
   * same file, so no total would ever be stored. The warning names the
   * session and the error's code only: DSH's message can quote the log or
   * its path. The id is JSON-quoted, as it comes from the stored header and
   * could hold a line break. An abort is not a read failure and still
   * stops the scan.
   */
  private async readOrSkip(query: HostSessionQuery, sessionId: string, signal: AbortSignal): Promise<HostSessionLog | undefined> {
    try {
      return await untilAborted(query.readSession(sessionId), signal)
    } catch (error) {
      signal.throwIfAborted()
      this.warn(`earlier usage history: session ${JSON.stringify(sessionId)} could not be read (${failureReason(error)}) and was skipped; its usage is in no total`)
      return undefined
    }
  }

  /** Write one provider's total under its lock, unless it was cleared or stored meanwhile (another process). */
  private async store(provider: TrackedProvider, total: PreTrackingTotal): Promise<void> {
    const release = await usageLock(this.fs, this.dir, provider, this.now, this.lockStaleMs).acquire(usageLockWaitMs(this.lockStaleMs))
    if (release === undefined) throw Object.assign(new Error(`the ${provider} usage lock is held`), { code: FAILURE_REASON.lockHeld })
    try {
      const meta = await readUsageMeta(this.fs, this.dir)
      if (meta === undefined || meta.trackingStartedAt !== total.trackingStartedAt || meta.clearedAt[provider] !== undefined) return
      const stored = await this.readTotal(provider)
      if (stored?.v === 2 && stored.trackingStartedAt === total.trackingStartedAt) return
      // Only the days are stored: the model totals are their sum, derived on read.
      const file = { v: total.v, trackingStartedAt: total.trackingStartedAt, days: total.days }
      await writeAtomic(this.fs, this.path(provider), `${JSON.stringify(file, null, 2)}\n`)
    } finally {
      await release()
    }
  }
}
