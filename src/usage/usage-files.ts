/**
 * File access of the usage store: an injectable file
 * system, atomic whole-file writes and exclusive-create lock files. Nothing
 * here knows about entries; `window-store.ts` owns what is written.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { renameWithRetry } from '../providers/catalog-store.js'
import { parseJsonText } from '../json-text.js'
import { USAGE_FILES, USAGE_LOCK_POLL_MS } from './constants.js'
import { parseMeta, type UsageMeta } from './usage-schema.js'

/** The file operations the store needs; injectable so tests can fail, hang or record them. Paths are absolute. */
export interface UsageFileSystem {
  /** Rejects with `ENOENT` when the file is missing. */
  readFile(path: string): Promise<string>
  /** `exclusive` creates the file only if it does not exist (rejects with `EEXIST`). */
  writeFile(path: string, data: string, options?: { exclusive?: boolean }): Promise<void>
  appendFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** A missing path is not an error. */
  rm(path: string, options?: { recursive?: boolean }): Promise<void>
  /** Recursive: creates missing parents, and an existing directory is not an error. */
  mkdir(path: string): Promise<void>
  /** A missing directory gives `[]`. */
  readdir(path: string): Promise<string[]>
  /** `size` and `ctimeMs` are optional so a fake may omit them; the reader's cache then keys on what is given. */
  stat(path: string): Promise<{ mtimeMs: number, ctimeMs?: number, size?: number }>
}

/** The real file system (node:fs/promises). */
export const nodeUsageFileSystem: UsageFileSystem = {
  readFile: path => readFile(path, 'utf8'),
  writeFile: (path, data, options) => writeFile(path, data, { mode: 0o600, ...options?.exclusive === true ? { flag: 'wx' } : {} }),
  appendFile: (path, data) => appendFile(path, data, { mode: 0o600 }),
  rename: (from, to) => rename(from, to),
  rm: (path, options) => rm(path, { force: true, recursive: options?.recursive === true }),
  mkdir: async path => { await mkdir(path, { recursive: true }) },
  readdir: async path => {
    try {
      return await readdir(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
  },
  stat: path => stat(path),
}

/** The string `code` of an error (a Node file-system error, a DSH `HarnessError`), if any. */
export function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** A file's text, or `undefined` when it does not exist. */
export async function readOptional(fs: UsageFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Replace `path` with `data` atomically: a temp file in the same directory,
 * then a rename, so a reader or a crash never sees a partial file. The temp
 * file is removed when the write fails.
 */
export async function writeAtomic(fs: UsageFileSystem, path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path))
  const tmp = `${path}${USAGE_FILES.tempMark}${process.pid}-${randomUUID()}`
  try {
    await fs.writeFile(tmp, data)
    await renameWithRetry(tmp, path, (from, to) => fs.rename(from, to))
  } catch (error) {
    await fs.rm(tmp).catch(() => undefined)
    throw error
  }
}

/** What a lock file holds: who took it and when. */
interface LockRecord {
  pid: number
  at: number
  token: string
}

/** Lock timing, in ms. */
export interface LockTiming {
  /** A lock older than this (strictly) is stale and taken over. */
  staleMs: number
  /** How often a waiting caller re-tries a held lock. */
  pollMs: number
}

/**
 * An exclusive-create lock file with a staleness limit. It serialises the read-merge-write of
 * one file between DSH processes sharing one home; within one process the
 * store already runs its saves one at a time.
 */
export class UsageLock {
  constructor(
    private readonly fs: UsageFileSystem,
    private readonly path: string,
    private readonly now: () => number,
    private readonly timing: LockTiming,
  ) {}

  /**
   * Take the lock, waiting up to `waitMs` for a held one (polling), and
   * taking over one that is stale. A taken-over live lock is the accepted
   * worst case (see `USAGE_LOCK_STALE_MS`).
   * @returns the release function, or `undefined` when the lock stayed held.
   */
  async acquire(waitMs = 0): Promise<(() => Promise<void>) | undefined> {
    // The wait is counted in polls, not on `now`: the injected clock is the
    // lock-age clock and need not move while this waits (a test's fixed clock).
    for (let waited = 0; ; waited += this.timing.pollMs) {
      const token = randomUUID()
      if (await this.tryCreate(token)) return () => this.release(token)
      const held = await this.read()
      // Either way past the limit: a lock dated ahead of this clock (the
      // clock was set back after a crash left it) would otherwise block
      // every save until that instant.
      if (Math.abs(await this.age(held)) > this.timing.staleMs && await this.unchanged(held)) {
        await this.fs.rm(this.path)
        if (await this.tryCreate(token)) return () => this.release(token)
      }
      if (waited >= waitMs) return undefined
      await sleep(this.timing.pollMs)
    }
  }

  private async tryCreate(token: string): Promise<boolean> {
    const record: LockRecord = { pid: process.pid, at: this.now(), token }
    await this.fs.mkdir(dirname(this.path))
    try {
      await this.fs.writeFile(this.path, JSON.stringify(record), { exclusive: true })
      return true
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false
      throw error
    }
  }

  /**
   * Whether the lock file still holds `judged`, the record found stale.
   * Two waiters can judge one dead lock stale together; this check stops
   * the second from removing the fresh lock the first has just created. It
   * narrows that race to the instant between this read and the `rm`, and
   * does not close it: a file system with no compare-and-delete can't.
   * The rest is the takeover worst case of `USAGE_LOCK_STALE_MS`.
   */
  private async unchanged(judged: LockRecord | undefined): Promise<boolean> {
    return (await this.read())?.token === judged?.token
  }

  /** The held lock's age; a lock written only partly (a crash) is dated by its file time. A vanished lock is age 0: re-try. */
  private async age(record: LockRecord | undefined): Promise<number> {
    if (record !== undefined) return this.now() - record.at
    try {
      return this.now() - (await this.fs.stat(this.path)).mtimeMs
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 0
      throw error
    }
  }

  private async read(): Promise<LockRecord | undefined> {
    try {
      const text = await readOptional(this.fs, this.path)
      const value = text === undefined ? undefined : parseJsonText(text)
      return isLockRecord(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  /** Remove the lock only if it is still ours: a process that took it over as stale keeps its own. */
  private async release(token: string): Promise<void> {
    if ((await this.read())?.token === token) await this.fs.rm(this.path)
  }
}

/**
 * The lock `<dir>/<name>.lock`. Every writer of one provider's files (the
 * window store, the pre-tracking writer, a clear's purge) takes the same
 * lock, so a clear and a write never interleave.
 */
export function usageLock(fs: UsageFileSystem, dir: string, name: string, now: () => number, staleMs: number): UsageLock {
  return new UsageLock(fs, join(dir, `${name}${USAGE_FILES.lockSuffix}`), now, { staleMs, pollMs: USAGE_LOCK_POLL_MS })
}

/** How long a waiting caller waits for a held lock: long enough for a lock held from the start to turn stale. */
export function usageLockWaitMs(staleMs: number): number {
  return staleMs + USAGE_LOCK_POLL_MS
}

/**
 * `<dir>/meta.json`, or `undefined` when it does not exist.
 * @throws when it exists but is not a valid meta file.
 */
export async function readUsageMeta(fs: UsageFileSystem, dir: string): Promise<UsageMeta | undefined> {
  const text = await readOptional(fs, join(dir, USAGE_FILES.meta))
  if (text === undefined) return undefined
  const meta = parseMeta(parseJsonText(text))
  if (meta === undefined) throw new Error(`${USAGE_FILES.meta} is not a valid usage meta file`)
  return meta
}

function isLockRecord(value: unknown): value is LockRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.pid === 'number' && typeof record.at === 'number' && Number.isFinite(record.at) && typeof record.token === 'string'
}

/**
 * Resolve after `ms`. The timer keeps the process alive: the lock waits
 * are bounded, and at shutdown an unref'd wait would let Node exit
 * mid-wait with the pending sums neither written nor reported.
 * @returns the wait, and `cancel`, which resolves it at once and clears the timer.
 */
export function sleep(ms: number): Promise<void> & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let done: () => void = () => undefined
  const wait = new Promise<void>(resolve => {
    done = resolve
    timer = setTimeout(resolve, ms)
  })
  return Object.assign(wait, { cancel: () => { clearTimeout(timer); done() } })
}
