/** Durable global Auto-Review default selected from Settings. */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ProviderId } from './auth/store.js'

export type StoredAutoReviewMode = 'none' | ProviderId

interface AutoReviewSettingsFile {
  readonly reviewer: StoredAutoReviewMode
}

/** Absolute path of the Settings-owned Auto-Review preference. */
export function autoReviewSettingsFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'auto-review.json')
}

async function atomicPersist(value: AutoReviewSettingsFile, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * One process-local view of the persisted global default. The YAML value is
 * the bootstrap/fallback; a valid Settings choice wins after the file loads.
 */
export class AutoReviewDefaultStore {
  private current: StoredAutoReviewMode
  private readonly ready: Promise<void>
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly fallback: StoredAutoReviewMode,
    private readonly available: (reviewer: StoredAutoReviewMode) => boolean,
    private readonly onWarn: (message: string) => void,
    private readonly path: string = autoReviewSettingsFilePath(),
  ) {
    this.current = fallback
    this.ready = this.load()
  }

  /** Current value after the one startup read settles. */
  async get(): Promise<StoredAutoReviewMode> {
    await this.ready
    return this.current
  }

  /** Persist a Settings choice, then publish it to live sessions. */
  set(reviewer: StoredAutoReviewMode): Promise<void> {
    const run = this.writeChain.then(async () => {
      await this.ready
      await atomicPersist({ reviewer }, this.path)
      this.current = reviewer
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.onWarn(`cannot read Auto-Review settings; using configured default: ${String(error)}`)
      return
    }
    try {
      const raw = JSON.parse(text) as unknown
      const reviewer = typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>).reviewer
        : undefined
      if (typeof reviewer !== 'string' || !this.available(reviewer as StoredAutoReviewMode)) {
        this.onWarn('stored Auto-Review default is unavailable; using configured default')
        return
      }
      this.current = reviewer as StoredAutoReviewMode
    } catch {
      this.onWarn('stored Auto-Review settings are not valid JSON; using configured default')
      this.current = this.fallback
    }
  }
}
