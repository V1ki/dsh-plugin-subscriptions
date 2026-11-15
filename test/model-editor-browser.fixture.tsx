import React, { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { ProviderModelEditor, type ProviderModelEditorHandle } from '../src/client/ProviderModelEditor.js'
import { en } from '../src/client/locales.js'
import { providerSettingsCss } from '../src/client/provider-settings-styles.js'

const style = document.createElement('style')
style.textContent = providerSettingsCss
document.head.append(style)

const ref = createRef<ProviderModelEditorHandle>()
const state = window as any
state.collect = () => ref.current?.collect()
const rpc = { call: async () => ({ ok: true, value: {
  settings: { visibleModels: ['alpha', 'gone'], modelDisplayNames: { beta: 'Aardvark' } },
  models: [
    { id: 'beta', name: 'Beta' },
    { id: 'alpha', name: 'Alpha', fastTier: true, efforts: [{ id: 'high', name: 'High' }], defaultContextWindow: 100, maxContextWindow: 200 },
  ], accounts: [], tools: ['image_generate', 'video_generate', 'web_search', 'x_search'],
} }) } as any
createRoot(document.getElementById('root')!).render(<dialog className="dsh-subscription-manager" ref={dialog => { if (dialog && !dialog.open) dialog.showModal() }} style={{ width: 900, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto' }}><ProviderModelEditor ref={ref} provider="codex" rpc={rpc}
  t={(key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key])} /></dialog>)
