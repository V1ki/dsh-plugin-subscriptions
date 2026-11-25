export type SliderGroup = { provider: string; models: readonly { id: string; name?: string }[] }
export type SliderStop = { id: string; name: string; premium: boolean }

const codexTiers = ['Luna', 'Terra', 'Sol', 'Astra']
const claudeTiers = ['Haiku', 'Sonnet', 'Opus', 'Fable']

// A snapshot date is separate from the model generation: Claude 3 Opus
// (20240229) must not outrank a newer generation just because it is dated.
function modelTier(provider: string, id: string): { family: string; version: number[] } | undefined {
  if (provider === 'codex') {
    const match = /^gpt-(\d+)(?:\.(\d+))?(?:\.(\d+))?-(luna|terra|sol|astra)(?:-(\d{4})-(\d{2})-(\d{2}))?$/.exec(id)
    if (!match) return undefined
    const [, major, minor, patch, family, year, month, day] = match
    const snapshot = year ? Number(`${year}${month}${day}`) : 0
    return { family, version: [Number(major), Number(minor ?? 0), Number(patch ?? 0), snapshot] }
  }

  // Claude shipped both `claude-3-5-sonnet-20241022` and the newer
  // family-first form `claude-sonnet-4-5-20250929`.
  const familyFirst = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:[-.](\d{1,2}))?(?:-(\d{8}|latest))?$/.exec(id)
  const versionFirst = /^claude-(\d+)(?:[-.](\d{1,2}))?-(haiku|sonnet|opus|fable)(?:-(\d{8}|latest))?$/.exec(id)
  const parts = familyFirst ? [familyFirst[1], familyFirst[2], familyFirst[3], familyFirst[4]]
    : versionFirst ? [versionFirst[3], versionFirst[1], versionFirst[2], versionFirst[4]] : undefined
  if (!parts) return undefined
  const [family, major, minor, snapshot] = parts
  return { family, version: [Number(major), Number(minor ?? 0), Number(snapshot === 'latest' ? 0 : snapshot ?? 0)] }
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function providerLadder(
  groups: readonly SliderGroup[],
  provider: 'codex' | 'claude',
  preferredModel?: string,
): { family: string; stop: SliderStop }[] {
  const tiers = provider === 'codex' ? codexTiers : claudeTiers
  const byFamily = new Map<string, { model: SliderGroup['models'][number]; version: number[] }>()
  for (const group of groups) {
    if (group.provider !== provider) continue
    for (const model of group.models) {
      const tier = modelTier(provider, model.id)
      if (!tier) continue
      const previous = byFamily.get(tier.family)
      if (!previous || (previous.model.id !== preferredModel
        && (model.id === preferredModel || compareVersions(tier.version, previous.version) > 0))) {
        byFamily.set(tier.family, { model, version: tier.version })
      }
    }
  }

  return tiers.flatMap(family => {
    const entry = byFamily.get(family.toLowerCase())
    if (!entry) return []
    return [{
      family,
      stop: { id: entry.model.id, name: entry.model.name || family, premium: family === 'Astra' || family === 'Fable' },
    }]
  })
}

/** Build the current provider’s slider from selectable catalog rows only. */
export function modelSliderStops(
  groups: readonly SliderGroup[],
  current: { provider: string; model: string } | null,
): SliderStop[] {
  if (!current || (current.provider !== 'codex' && current.provider !== 'claude')) return []

  const ladder = providerLadder(groups, current.provider, current.model)
  // If the exact selection is not routable, moving its marker to a sibling
  // would imply the session had selected a different model.
  if (ladder.length < 2 || !ladder.some(({ stop }) => stop.id === current.model)) return []
  return ladder.map(({ stop }) => stop)
}

/** Restore a remembered model or choose a balanced entry into the provider’s ladder. */
export function sliderProviderTarget(
  groups: readonly SliderGroup[],
  provider: 'codex' | 'claude',
  model?: string,
): SliderStop | undefined {
  const ladder = providerLadder(groups, provider, model)
  const balanced = provider === 'codex' ? 'Sol' : 'Sonnet'
  return (ladder.find(({ stop }) => stop.id === model)
    ?? ladder.find(({ family }) => family === balanced)
    ?? ladder[0])?.stop
}
