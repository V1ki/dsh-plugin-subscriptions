/**
 * On-disk discovered-model-catalog cache at
 * `~/.dsh/plugins/subscriptions/models.json` — the durable half of each
 * provider's {@link ModelCatalogCache}. One entry per provider: the last
 * successfully discovered catalog with its fetch time, so capability metadata
 * (reasoning efforts) survives restarts and network failures.
 *
 * Unlike the auth store, this file is a cache: a missing, corrupt, or
 * malformed file silently reads as absent, because the next successful
 * discovery rewrites it. Loads are strictly validated — a malformed entry
 * passed through `resolveModel` would make the harness's metadata validation
 * throw on every call, which is worse than having no fallback at all.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import type { CatalogPersistence, CatalogSnapshot, DiscoveredModel } from './common.js'

/**
 * Absolute path of the catalog store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'models.json')`.
 */
export function modelsFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'models.json')
}

/** The raw file shape: one unvalidated snapshot per provider. */
type CatalogFile = Partial<Record<ProviderId, unknown>>

/** Validate one persisted reasoning block, or undefined when malformed. */
function sanitizeReasoning(value: unknown): NonNullable<DiscoveredModel['reasoning']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { efforts?: unknown; defaultEffort?: unknown }
  if (!Array.isArray(raw.efforts) || raw.efforts.length === 0) return undefined
  const seen = new Set<string>()
  const efforts: NonNullable<DiscoveredModel['reasoning']>['efforts'] = []
  for (const entry of raw.efforts) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const effort = entry as Record<string, unknown>
    if (typeof effort.id !== 'string' || effort.id.length === 0
      || typeof effort.name !== 'string' || effort.name.length === 0
      || (effort.description !== undefined && typeof effort.description !== 'string')
      || seen.has(effort.id)) return undefined
    seen.add(effort.id)
    efforts.push({
      id: ReasoningEffortId(effort.id),
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })
  }
  if (raw.defaultEffort !== undefined
    && (typeof raw.defaultEffort !== 'string' || !seen.has(raw.defaultEffort))) return undefined
  return {
    efforts,
    ...raw.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(raw.defaultEffort as string) },
  }
}

/** Validate one persisted model, or undefined when malformed. */
function sanitizeModel(value: unknown): DiscoveredModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0
    || typeof raw.name !== 'string' || raw.name.length === 0
    || (raw.description !== undefined && typeof raw.description !== 'string')
    || (raw.contextWindow !== undefined
      && (typeof raw.contextWindow !== 'number' || !Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0))
    || (raw.priority !== undefined
      && (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority)))) return undefined
  const reasoning = raw.reasoning === undefined ? undefined : sanitizeReasoning(raw.reasoning)
  if (raw.reasoning !== undefined && reasoning === undefined) return undefined
  const thinkingType = raw.thinkingType
  if (thinkingType !== undefined && thinkingType !== 'enabled' && thinkingType !== 'adaptive') return undefined
  const fastTier = raw.fastTier
  if (fastTier !== undefined && typeof fastTier !== 'boolean') return undefined
  const copilotWire = raw.copilotWire
  if (copilotWire !== undefined && copilotWire !== 'chat-completions' && copilotWire !== 'responses') {
    return undefined
  }
  const copilotResponses = raw.copilotResponses
  if (copilotResponses !== undefined && typeof copilotResponses !== 'boolean') return undefined
  const inputModalities = raw.inputModalities
  if (inputModalities !== undefined
    && (!Array.isArray(inputModalities) || inputModalities.length === 0
      || inputModalities.some(modality => modality !== 'text' && modality !== 'image'))) return undefined
  return {
    id: raw.id,
    name: raw.name,
    ...raw.description === undefined ? {} : { description: raw.description as string },
    ...raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow as number },
    ...raw.priority === undefined ? {} : { priority: raw.priority as number },
    ...reasoning === undefined ? {} : { reasoning },
    ...thinkingType === undefined ? {} : { thinkingType: thinkingType as 'enabled' | 'adaptive' },
    ...fastTier === undefined ? {} : { fastTier },
    ...copilotWire === undefined ? {} : { copilotWire: copilotWire as 'chat-completions' | 'responses' },
    ...copilotResponses === undefined ? {} : { copilotResponses },
    ...inputModalities === undefined ? {} : { inputModalities: [...inputModalities] as ('text' | 'image')[] },
  }
}

/**
 * Validate one persisted snapshot. Strict: any malformed field drops the
 * whole snapshot rather than repairing it — the next successful discovery
 * rewrites the entry anyway.
 * @param value - the raw per-provider file entry.
 * @returns the validated snapshot, or undefined when unusable.
 */
export function sanitizeSnapshot(value: unknown): CatalogSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { at?: unknown; models?: unknown }
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
  if (!Array.isArray(raw.models) || raw.models.length === 0) return undefined
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const entry of raw.models) {
    const model = sanitizeModel(entry)
    if (model === undefined || seen.has(model.id)) return undefined
    seen.add(model.id)
    models.push(model)
  }
  return { at: raw.at, models }
}

/** Read the whole file; missing or unparsable reads as an empty cache. */
async function readCatalogFile(path: string): Promise<CatalogFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as CatalogFile
  } catch {
    return {}
  }
}

/** Persist the whole file atomically (tmp file + rename). */
async function writeCatalogFile(store: CatalogFile, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2))
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * Build the durable half of one provider's catalog cache over the shared
 * models.json file (concurrent writers are last-writer-wins, acceptable for
 * a cache).
 * @param provider - the provider route keying the file entry.
 * @param path - store file path; defaults to {@link modelsFilePath}.
 * @returns the persistence hooks for {@link ModelCatalogCache}.
 */
export function catalogStore(provider: ProviderId, path = modelsFilePath()): CatalogPersistence {
  return {
    async load() {
      return sanitizeSnapshot((await readCatalogFile(path))[provider])
    },
    async save(snapshot) {
      const store = await readCatalogFile(path)
      store[provider] = snapshot
      await writeCatalogFile(store, path)
    },
    async clear() {
      const store = await readCatalogFile(path)
      if (store[provider] === undefined) return
      delete store[provider]
      await writeCatalogFile(store, path)
    },
  }
}
