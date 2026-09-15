import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PROVIDER_IDS, type ProviderId } from './auth/store.js'

export const PROVIDER_TOOLS = {
  codex: ['image_generate', 'web_search'],
  claude: [],
  grok: ['image_generate', 'video_generate', 'x_search'],
  copilot: [],
  antigravity: [],
} as const
export type SubscriptionTool = 'image_generate' | 'video_generate' | 'x_search' | 'web_search'
export interface ProviderPreferences {
  /** Absent follows discovery; an explicit selection hides newly discovered models. */
  visibleModels?: string[]
  contextWindows?: Record<string, number>
  tools?: Partial<Record<SubscriptionTool, boolean>>
}
interface ToolRevision {
  at: number
  provider: ProviderId
  tools: Partial<Record<SubscriptionTool, boolean>>
}
interface Document {
  providers: Partial<Record<ProviderId, ProviderPreferences>>
  toolHistory: ToolRevision[]
}

export function validatePreferences(provider: ProviderId, input: unknown): ProviderPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be an object')
  const raw = input as Record<string, unknown>
  const result: ProviderPreferences = {}
  if (raw.visibleModels !== undefined) {
    if (!Array.isArray(raw.visibleModels) || raw.visibleModels.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('visibleModels must be an array of model ids')
    }
    result.visibleModels = [...new Set(raw.visibleModels as string[])]
  }
  if (raw.contextWindows !== undefined) {
    if (provider !== 'codex') throw new Error('context window overrides are currently supported only for Codex')
    if (!raw.contextWindows || typeof raw.contextWindows !== 'object' || Array.isArray(raw.contextWindows)) {
      throw new Error('contextWindows must be a model-to-token map')
    }
    result.contextWindows = Object.create(null) as Record<string, number>
    for (const [model, value] of Object.entries(raw.contextWindows)) {
      if (!model.trim() || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error('context windows must be positive safe integers')
      }
      result.contextWindows[model] = value
    }
  }
  if (raw.tools !== undefined) {
    if (!raw.tools || typeof raw.tools !== 'object' || Array.isArray(raw.tools)) throw new Error('tools must be an object')
    result.tools = {}
    for (const [tool, enabled] of Object.entries(raw.tools)) {
      if (!(PROVIDER_TOOLS[provider] as readonly string[]).includes(tool) || typeof enabled !== 'boolean') {
        throw new Error(`unsupported tool setting: ${provider}/${tool}`)
      }
      result.tools[tool as SubscriptionTool] = enabled
    }
  }
  return result
}

/** Durable user preferences, independent of expiring discovery caches. */
export class ProviderSettingsStore {
  private current: Document = { providers: {}, toolHistory: [] }
  private writes: Promise<void> = Promise.resolve()
  readonly path: string

  constructor(path = dshHomePath('plugins', 'subscriptions', 'provider-settings.json')) {
    this.path = path
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Document
      if (!raw.providers || !Array.isArray(raw.toolHistory)) throw new Error('invalid settings document')
      for (const provider of PROVIDER_IDS) {
        if (Object.hasOwn(raw.providers, provider)) this.current.providers[provider] = validatePreferences(provider, raw.providers[provider])
      }
      this.current.toolHistory = raw.toolHistory.map(revision => {
        if (!PROVIDER_IDS.includes(revision.provider) || !Number.isSafeInteger(revision.at) || revision.at < 0) throw new Error('invalid tool history')
        const tools = validatePreferences(revision.provider, { tools: revision.tools }).tools ?? {}
        return { at: revision.at, provider: revision.provider, tools }
      }).sort((a, b) => a.at - b.at)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read provider settings at ${path}`, { cause: error })
    }
  }

  get(provider: ProviderId): ProviderPreferences {
    return structuredClone(this.current.providers[provider] ?? {})
  }

  visible(provider: ProviderId, model: string): boolean {
    return this.current.providers[provider]?.visibleModels?.includes(model) ?? true
  }

  contextWindow(model: string): number | undefined {
    const windows = this.current.providers.codex?.contextWindows
    return windows && Object.hasOwn(windows, model) ? windows[model] : undefined
  }

  /** Creation-time policy survives restarts and never changes an existing session. */
  toolEnabled(provider: ProviderId, tool: SubscriptionTool, createdAt = Date.now()): boolean {
    let enabled = true
    for (const revision of this.current.toolHistory) {
      if (revision.at > createdAt) break
      if (revision.provider === provider) enabled = revision.tools[tool] !== false
    }
    return enabled
  }

  set(provider: ProviderId, input: unknown): Promise<void> {
    const preferences = validatePreferences(provider, input)
    const run = this.writes.then(async () => {
      const next = structuredClone(this.current)
      const before = next.providers[provider]?.tools ?? {}
      next.providers[provider] = preferences
      if (PROVIDER_TOOLS[provider].some(tool => (before[tool] !== false) !== (preferences.tools?.[tool] !== false))) {
        next.toolHistory.push({ at: Date.now(), provider, tools: preferences.tools ?? {} })
      }
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
      this.current = next
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
