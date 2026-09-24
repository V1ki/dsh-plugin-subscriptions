import { proxiedFetch } from '../http.js'
import { CODEX_CLIENT_VERSION } from './codex.js'
import type { FetchFn } from './common.js'

/** Public metadata only: never send subscription credentials to this endpoint. */
export const CODEX_VERSION_URL = 'https://registry.npmjs.org/@openai%2fcodex/latest'

/** Lazy, shared-per-plugin lookup of the official CLI's stable version. */
export class CodexClientVersionCache {
  private version = CODEX_CLIENT_VERSION
  private expiresAt = 0
  private pending: Promise<string> | undefined

  constructor(
    private readonly fetchFn: FetchFn = proxiedFetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 5000,
  ) {}

  /** A manual catalog refresh also checks for a newly released CLI. */
  invalidate(): void { this.expiresAt = 0 }

  resolve(): Promise<string> {
    if (this.pending !== undefined) return this.pending
    if (this.now() < this.expiresAt) return Promise.resolve(this.version)
    this.pending = this.refresh().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async refresh(): Promise<string> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const lookup = async (): Promise<string> => {
        const response = await this.fetchFn(CODEX_VERSION_URL, {
          headers: { accept: 'application/json', 'accept-encoding': 'identity' },
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Codex version lookup failed')
        const payload: unknown = await response.json()
        const version = (payload as { version?: unknown } | null)?.version
        // Ignore prerelease/platform tags and malformed or regressed metadata.
        if (typeof version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) {
          throw new Error('Invalid stable Codex version')
        }
        const next = version.split('.').map(Number)
        const previous = this.version.split('.').map(Number)
        const different = next.findIndex((part, index) => part !== previous[index])
        if (different !== -1 && next[different]! < previous[different]!) throw new Error('Older Codex version')
        return version
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Codex version lookup timed out'))
        }, this.timeoutMs)
      })
      // Also bounded when an injected transport ignores cancellation.
      this.version = await Promise.race([lookup(), timeout])
      this.expiresAt = this.now() + 6 * 60 * 60_000
    } catch {
      // Retain last-known good; on first use this is the verified fallback.
      this.expiresAt = this.now() + 5 * 60_000
    } finally {
      clearTimeout(timer)
    }
    return this.version
  }
}
