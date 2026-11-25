import { createRoot } from 'react-dom/client'
import { ModelSliderView, type SliderDirectory } from '../src/client/ModelSlider.js'
import type { SpeedSelectInjected, SpeedTier } from '../src/client/speed.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { installComposerPickerVisibility } from '../src/client/composer-picker-visibility.js'
import { en } from '../src/client/locales.js'

type Selection = Parameters<SliderDirectory['select']>[0]
type Snapshot = ReturnType<SliderDirectory['store']['getSnapshot']>
const codex = (model: string): Selection => ({ provider: 'codex', model })
const listeners = new Set<() => void>()
const selections: Selection[] = []
let snapshot: Snapshot = {
  status: 'ready',
  routable: true,
  current: codex('gpt-5-luna'),
  groups: [{ id: 'codex', models: [
    { id: 'gpt-5-luna', name: 'Luna' },
    { id: 'gpt-5-terra', name: 'Terra' },
    { id: 'gpt-5-sol', name: 'Sol' },
    { id: 'gpt-6.2-astra', name: 'Astra' },
  ] }, { id: 'claude', models: [
    { id: 'claude-sonnet-5-5', name: 'Sonnet' },
    { id: 'claude-opus-5-5', name: 'Opus' },
  ] }],
}
const publish = (current: Selection, loading = false) => {
  snapshot = { ...snapshot, current, status: loading ? 'loading' : 'ready',
    routable: loading ? null : snapshot.groups.some(group => group.id === current.provider && group.models.some(model => model.id === current.model)) }
  for (const listener of listeners) listener()
}

const directory: SliderDirectory = {
  load: async () => snapshot,
  store: {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  },
  async select(selection) {
    selections.push(selection)
    publish(selection)
    return { ok: true }
  },
}

let sessionTier: SpeedTier | undefined
let resolveSolSpeed!: () => void
const solSpeedGate = new Promise<void>(resolve => { resolveSolSpeed = resolve })
const speedWrites: { model: string | undefined; tier: SpeedTier }[] = []
const speed: SpeedSelectInjected = {
  async loadSpeed() {
    const model = snapshot.current?.model
    const fastModels = ['gpt-5-luna', 'gpt-5-sol', 'gpt-6.2-astra', 'gpt-6.2-sol-removed']
    if (model === 'gpt-5-sol') await solSpeedGate
    const override = sessionTier === undefined ? {} : { sessionTier }
    return model && fastModels.includes(model)
      ? { visible: true, tier: sessionTier ?? 'standard', model, fastModels, ...override }
      : { visible: false, tier: 'standard', fastModels, ...override }
  },
  async setSpeed(next, model) {
    speedWrites.push({ model, tier: next })
    sessionTier = next
    return true
  },
}

// Publish like the host's native picker, without going through the slider's select method.
Object.assign(window, { modelSliderFixture: {
  read: () => ({ current: snapshot.current, selections }),
  selectExternally: (model: string) => publish(model.startsWith('claude-') ? { provider: 'claude', model }
    : model === 'external-model' ? { provider: 'external', model } : codex(model)),
  speedWrites: () => speedWrites,
  resolveSolSpeed,
  refreshCatalog: (loading: boolean) => { if (snapshot.current) publish(snapshot.current, loading) },
} })

const loadProviders = async () => ['codex', 'claude'] as const
installComposerPickerVisibility()
createRoot(document.getElementById('root')!).render(<>
  <div data-composer-card>
    <ModelSliderView directory={directory} speed={speed} loadProviders={loadProviders} />
    <div data-slot="conversation.input.model" style={{ display: 'contents' }}><button>Composer model</button></div>
  </div>
  <button data-slot="conversation.input.model">Other model surface</button>
  <div style={{ width: 'min(100%, 320px)' }}><UsageBadgeDisplaySetting t={key => en[key]} /></div>
</>)
