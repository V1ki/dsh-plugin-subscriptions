import { proxiedFetch } from '../http.js'
import type { FetchFn } from './common.js'

/** Stable `major.minor.patch` only: prerelease and platform tags are not client versions. */
const STABLE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/

/**
 * Compare two stable `major.minor.patch` versions numerically.
 * @returns negative when `a` is older, positive when newer, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  const different = left.findIndex((part, index) => part !== right[index])
  return different === -1 ? 0 : left[different]! - right[different]!
}

export interface NpmCliVersionOptions {
  /** Registry metadata of the package's `latest` dist-tag; public, so never send credentials. */
  url: string
  /** Names the CLI in lookup errors. */
  label: string
  /**
   * The version served until a lookup succeeds, and the floor a looked-up
   * version may never go below. Read once, on first use, so a costly probe
   * (a local CLI's `--version`) never runs for an unused provider.
   */
  floor: () => string
  fetchFn?: FetchFn
  now?: () => number
  timeoutMs?: number
}

/**
 * Lazy, shared-per-plugin lookup of an official CLI's newest stable version
 * on npm. Subscription endpoints gate new models on the client version they
 * see, so presenting the released CLI's version keeps new models usable
 * without a plugin release for every CLI bump.
 */
export class NpmCliVersionCache {
  private version: string | undefined
  private expiresAt = 0
  private pending: Promise<string> | undefined
  private readonly fetchFn: FetchFn
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor(private readonly options: NpmCliVersionOptions) {
    this.fetchFn = options.fetchFn ?? proxiedFetch
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  /** A manual catalog refresh also checks for a newly released CLI. */
  invalidate(): void { this.expiresAt = 0 }

  resolve(): Promise<string> {
    if (this.pending !== undefined) return this.pending
    if (this.version !== undefined && this.now() < this.expiresAt) return Promise.resolve(this.version)
    this.pending = this.refresh().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async refresh(): Promise<string> {
    const current = this.version ??= this.options.floor()
    const { url, label } = this.options
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const lookup = async (): Promise<string> => {
        const response = await this.fetchFn(url, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`${label} version lookup failed`)
        const payload: unknown = await response.json()
        const version = (payload as { version?: unknown } | null)?.version
        // Ignore prerelease/platform tags and malformed or regressed metadata.
        if (typeof version !== 'string' || !STABLE_VERSION.test(version)) {
          throw new Error(`Invalid stable ${label} version`)
        }
        if (compareVersions(version, current) < 0) throw new Error(`Older ${label} version`)
        return version
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`${label} version lookup timed out`))
        }, this.timeoutMs)
      })
      // Also bounded when an injected transport ignores cancellation.
      this.version = await Promise.race([lookup(), timeout])
      this.expiresAt = this.now() + 6 * 60 * 60_000
    } catch {
      // Retain last-known good; on first use this is the floor.
      this.expiresAt = this.now() + 5 * 60_000
    } finally {
      clearTimeout(timer)
    }
    return this.version
  }
}
