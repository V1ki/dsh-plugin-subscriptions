/** Presentation groups over the original, account-scoped Antigravity catalog. */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DiscoveredModel } from './common.js'
import { antigravityModelId } from '../antigravity-model-id.js'

const EFFORTS = ['low', 'medium', 'high'] as const
type Effort = typeof EFFORTS[number]

export interface AntigravityModelGroup extends DiscoveredModel {
  variants?: Partial<Record<Effort, DiscoveredModel>>
}

/** Internal completion routes and retired/non-chat ids observed in upstream PR #165. */
export function isAntigravityChatModel(id: string): boolean {
  return !/^(?:tab_|chat_\d+$)/.test(id)
    && !/-(?:image|tts)(?:-|$)/.test(id)
    && !/-disabled$/.test(id)
    && !/^gemini-2\.5-/.test(id)
    && !/^gemini-3-flash-agent$/.test(id)
    && !/^gemini-3\.5-flash-(?:extra-low|low|medium|high|preview)$/.test(id)
}

/** Keep unknown ids distinct; tieredModelIds keys are categories, not model identities. */
export function groupAntigravityModels(models: readonly DiscoveredModel[]): AntigravityModelGroup[] {
  const visible = models.filter(model => model.antigravity?.visible ?? isAntigravityChatModel(model.id))
  const groups = new Map<string, AntigravityModelGroup>()
  for (const model of visible) {
    const match = /^((?:gemini|claude|gpt-oss)-.+)-(low|medium|high)$/.exec(model.id)
    const id = match === null ? undefined : antigravityModelId(model.id)
    const effort = model.antigravity?.thinkingLevel?.toLowerCase() ?? match?.[2]
    if (id === undefined || effort === undefined || !EFFORTS.includes(effort as Effort)) {
      if (!groups.has(model.id)) groups.set(model.id, { ...model, name: model.name.replace(/\s*\(?Tiered\)?$/i, '').trim() })
      continue
    }
    let group = groups.get(id)
    if (group?.variants === undefined) {
      const base = visible.find(entry => entry.id === id) ?? model
      group = { ...base, id, name: base.name.replace(/\s*\(?\b(?:low|medium|high|tiered)\)?$/i, '').trim(), variants: {} }
      groups.set(id, group)
    }
    group.variants![effort as Effort] = model
  }
  for (const group of groups.values()) {
    if (group.variants === undefined) continue
    const efforts = EFFORTS.filter(effort => group.variants![effort] !== undefined)
    // Prefer High, matching the previous Claude/Pro behavior; never invent a missing tier.
    group.reasoning = {
      efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id[0].toUpperCase() + id.slice(1) })),
      defaultEffort: ReasoningEffortId(efforts.at(-1)!),
    }
    for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
      const limits = Object.values(group.variants).map(model => model[field]).filter((value): value is number => value !== undefined)
      if (limits.length) group[field] = Math.min(...limits)
    }
  }
  return [...groups.values()]
}

/** Resolve only variants advertised by this account. Old concrete ids remain callable. */
export function selectAntigravityVariant(group: AntigravityModelGroup, effort?: string): DiscoveredModel {
  if (group.variants === undefined) return group
  const selected = effort ?? group.reasoning!.defaultEffort!
  const variant = Object.hasOwn(group.variants, selected) ? group.variants[selected as Effort] : undefined
  if (variant === undefined) {
    throw new LlmError(`Antigravity model ${group.id} does not support reasoning effort ${selected}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  return variant
}
