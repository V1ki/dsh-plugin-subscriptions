import React from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import type { ProviderPreferences } from '../src/provider-settings.js'

let settings: ProviderPreferences = { visibleModels: ['gemini-3-flash'] }
const models = [
  { id: 'gemini-3-flash', name: 'Gemini Flash' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet' },
]
const rpc = { call: async (_channel: string, endpoint: string, payload: any) => {
  let value: unknown
  switch (endpoint.split('.').at(-1)) {
    case 'status':
      value = { providers: Object.fromEntries(['codex', 'claude', 'grok', 'copilot', 'antigravity'].map(id => [id, {
        busy: false,
        ...(id === 'antigravity' ? { visibleModels: settings.visibleModels } : {}),
        accounts: id === 'antigravity' ? [{ key: 'test', account: 'test@example.invalid', isDefault: true }] : [],
      }])) }
      break
    case 'usage':
      document.documentElement.dataset.usageCalls = String(Number(document.documentElement.dataset.usageCalls ?? 0) + 1)
      value = { supported: true, plan: 'Google AI Pro', windows: [
        { kind: 'other', scope: 'gemini-3-flash', usedPercent: 20 },
        { kind: 'weekly', scope: 'gemini-3-flash', usedPercent: 40 },
        { kind: 'other', scope: 'claude-sonnet-4-6', usedPercent: 70 },
        { kind: 'other', scope: 'tab_jump_flash_lite_preview', usedPercent: 0 },
      ] }
      break
    case 'providerSettings': value = { settings: structuredClone(settings), models, accounts: [], tools: [] }; break
    case 'setProviderSettings': settings = payload.settings; value = {}; break
    case 'proxyGet': value = { enabled: false, url: '', bypass: [], passwordSet: false }; break
    default: throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
  return { ok: true, value }
} } as any
createRoot(document.getElementById('root')!).render(<SubscriptionsSection rpc={rpc} />)
