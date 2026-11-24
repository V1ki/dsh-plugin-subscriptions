/**
 * Fixed domain constants of the usage-details feature.
 *
 * The window tracker's values come first; the window store's
 * save delay, lock limits and file names follow.
 */
import { PROVIDER_IDS, type ProviderId } from '../auth/store.js'
import type { UsageWindow } from '../providers/common.js'

/** Subscription routes with usage statistics: every provider except Copilot. */
export type TrackedProvider = Exclude<ProviderId, 'copilot'>

/** Providers whose usage is tracked; the one list every provider check uses. */
export const USAGE_TRACKED_PROVIDERS: readonly TrackedProvider[] = PROVIDER_IDS.filter(
  (provider): provider is TrackedProvider => provider !== 'copilot',
)

/** Window kinds the view can show; `unclassified` stays hidden until its observed length classifies it. */
export type WindowKind = '5h' | 'weekly' | 'monthly' | 'unclassified'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** Window lengths used for classification and the nominal start rule, in milliseconds. */
export const WINDOW_LENGTH_MS = {
  fiveHour: 5 * HOUR_MS,
  weekly: 7 * DAY_MS,
  /** The monthly range is closed on both ends. */
  monthlyMin: 28 * DAY_MS,
  monthlyMax: 31 * DAY_MS,
} as const

/** Start rule 3: the nominal length of each kind that has one. Monthly has none. */
export const NOMINAL_LENGTH_MS: Readonly<Partial<Record<WindowKind, number>>> = {
  '5h': WINDOW_LENGTH_MS.fiveHour,
  weekly: WINDOW_LENGTH_MS.weekly,
}

/** How a provider-reported window kind maps onto a tracker kind; `other` is classified by length. */
export const REPORTED_KIND: Readonly<Record<Exclude<UsageWindow['kind'], 'other'>, WindowKind>> = {
  session: '5h',
  weekly: 'weekly',
}

/**
 * Which providers DISCLOSE their window's length in `UsageWindow.durationMs`,
 * and which start rule that disclosure is. Grok derives
 * `durationMs` from `currentPeriod.start`, so `resetsAt − durationMs` is the
 * disclosed start (rule 1). Codex reports `limit_window_seconds` (rule 2).
 * Claude sets `durationMs` itself from fixed values, so it is nominal (rule
 * 3) and absent here, as is Antigravity, which sets none.
 */
export const DISCLOSED_START_SOURCE: Readonly<Partial<Record<TrackedProvider, 'disclosed' | 'length'>>> = {
  grok: 'disclosed',
  codex: 'length',
}

/** Kinds a Codex credit redeemed through the plugin resets at the redemption instant. */
export const REDEMPTION_RESET_KINDS: readonly WindowKind[] = ['5h', 'weekly']

/**
 * The strict reset-matching tolerance: an observed reset within
 * this distance of the open entry's reset is the same window (jitter); a
 * larger difference is an early reset.
 *
 * How it was chosen (offline; no provider request was made): the only
 * provider value that moves between fetches by construction is Codex's
 * `reset_after_seconds` fallback, where `resetsAt = response time + seconds`.
 * It shifts by the response latency (bounded by the 10 s pool usage
 * timeout and the 20 s redemption read; the Settings RPC has none) plus up
 * to 1 s of second rounding. Absolute resets (`reset_at`, Claude's and
 * Grok's RFC 3339 times) are fixed between fetches. 60 s is three times the
 * longest bounded latency and stays far below any real early reset, which
 * moves the reset by minutes to days. It is strict on purpose: splitting one
 * window in two is corrected by the merge on read; merging two real
 * windows cannot be undone. Revisit with measured live jitter.
 */
export const RESET_MATCH_TOLERANCE_MS = 60_000

/** The only provider whose entries keep cache writes split by duration; others store no split. */
export const CACHE_WRITE_SPLIT_PROVIDER: TrackedProvider = 'claude'

/**
 * The C5 save delay, counted from the first unsaved change: a crash
 * loses at most this much counting. Measured offline:
 * one save (lock, read, merge, atomic rename, unlock) of a provider with
 * three accounts' open entries took 1.1 ms median, 1.8 ms p95 over 200
 * saves, so the delay is not bounded by write
 * cost; it bounds how often two processes contend for the lock. Five
 * seconds keeps a busy agent (a request every few seconds) to at most one
 * save per delay, while a crash loses only the last few seconds.
 */
export const USAGE_SAVE_DELAY_MS = 5_000

/**
 * A usage lock older than this (strictly) belongs to a process that died
 * mid-save and is taken over (SAVE-LOCK). A save holds the lock for
 * milliseconds; 10 s leaves three orders of magnitude for a slow disk, and
 * also bounds how long shutdown waits on another process's lock.
 * Taking over a live lock only happens past that, and then the two saves
 * still each write whole files by atomic rename: the worst case is one save's
 * delta lost, never a corrupt file.
 */
export const USAGE_LOCK_STALE_MS = 10_000

/** How often shutdown and a clear re-try a held lock while they wait for it. */
export const USAGE_LOCK_POLL_MS = 100

/**
 * The shutdown save's bound, in lock waits: one wait for a
 * held lock to turn stale, and as long again for the save's own work, so a
 * save that hangs (a stuck disk) cannot hold up shutdown indefinitely.
 */
export const USAGE_SHUTDOWN_LOCK_WAITS = 2

/**
 * How often the store advances the tracker clock with no traffic. A window
 * still closes at its exact reset instant (the tracker applies transitions
 * at their own instants); this only bounds how late that close is saved.
 */
export const USAGE_ADVANCE_INTERVAL_MS = 60_000

/** File names under the usage directory. */
export const USAGE_FILES = {
  meta: 'meta.json',
  open: 'open.json',
  preTracking: 'pre-tracking.json',
  closedPrefix: 'closed-',
  closedSuffix: '.jsonl',
  lockSuffix: '.lock',
  metaLock: 'meta',
  tempMark: '.tmp-',
  corruptMark: '.corrupt-',
} as const

/** The usage directory under the DSH home: `plugins/subscriptions/usage`. */
export const USAGE_DIR_SEGMENTS = ['plugins', 'subscriptions', 'usage'] as const
