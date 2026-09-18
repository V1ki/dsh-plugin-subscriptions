import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProviderAccountManager } from '../src/client/ProviderAccountManager.js'
import { en, zh } from '../src/client/locales.js'

const state = window as any
state.settings = { visibleModels: ['alpha'], accounts: {} }
state.failSave = false
state.saved = []
const rpc = { call: async (_channel: string, endpoint: string, payload: any) => {
  if (endpoint.endsWith('.setProviderSettings')) {
    if (state.failSave) return { ok: false, error: { message: 'Simulated save failure' } }
    state.settings = payload.settings
    state.saved.push(payload.settings)
    return { ok: true, value: {} }
  }
  return { ok: true, value: { settings: structuredClone(state.settings), accounts: [
    { key: 'personal', label: 'personal@example.com', models: state.preview ? [{ id: 'gpt-5.4', name: 'GPT-5.4' }, { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }] : [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }] },
    { key: 'work', label: 'work@example.com', models: state.preview ? [{ id: 'gpt-5.4', name: 'GPT-5.4' }, { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }] : [], unavailable: !state.preview },
  ] } }
} } as any
function App() {
  const [open, setOpen] = useState(false)
  const dictionary = state.locale === 'zh' ? zh : en
  return <><button onClick={() => setOpen(true)}>Manage</button>{open && <ProviderAccountManager
    provider="codex" name="Codex (ChatGPT)" rpc={rpc} onClose={() => setOpen(false)}
    t={(key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])} />}</>
}
createRoot(document.getElementById('root')!).render(<App />)
