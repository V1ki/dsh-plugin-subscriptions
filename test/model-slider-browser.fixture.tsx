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
const publish = (current: Selection) => {
  snapshot = { ...snapshot, current }
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

let tier: SpeedTier = 'standard'
let resolveSolSpeed!: () => void
const solSpeedGate = new Promise<void>(resolve => { resolveSolSpeed = resolve })
const speedWrites: { model: string | undefined; tier: SpeedTier }[] = []
const speed: SpeedSelectInjected = {
  async loadSpeed() {
    const model = snapshot.current?.model
    const fastModels = ['gpt-5-luna', 'gpt-5-sol', 'gpt-6.2-astra', 'gpt-6.2-sol-removed']
    if (model === 'gpt-5-sol') await solSpeedGate
    return model && fastModels.includes(model)
      ? { visible: true, tier, model, fastModels }
      : { visible: false, tier: 'standard', fastModels }
  },
  async setSpeed(next, model) {
    speedWrites.push({ model, tier: next })
    tier = next
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
