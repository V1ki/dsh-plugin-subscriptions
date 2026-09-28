import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionUsageBadge } from '../src/client/SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from '../src/client/SubscriptionUsageBadge.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { en, zh } from '../src/client/locales.js'

const selections = {
  api: { provider: 'deepseek', model: 'deepseek-chat' },
  codex: { provider: 'codex', model: 'gpt-test' },
  grok: { provider: 'grok', model: 'grok-test' },
  antigravity: { provider: 'antigravity', model: 'gemini-model-29' },
}
let selection = selections.api
let reads = 0
let statusCalls = 0
const currentModel = async () => {
  document.documentElement.dataset.modelReads = String(++reads)
  document.documentElement.dataset.lastRead = selection.provider
  return selection
}
const rpc = { call: async (_channel: string, method: string, payload: { provider?: string }) => {
  if (method.endsWith('.status')) document.documentElement.dataset.statusCalls = String(++statusCalls)
  if (method.endsWith('.status')) return { ok: true, value: { providers: {
    codex: { accounts: [{ key: 'codex-test', isDefault: true }] },
    grok: { accounts: [{ key: 'grok-test', isDefault: true }] },
    antigravity: { accounts: [{ key: 'anti-test', isDefault: true }] },
  } } }
  if (method.endsWith('.usage')) return { ok: true, value: {
    supported: true, windows: payload.provider === 'antigravity'
      ? Array.from({ length: 30 }, (_, i) => ({ kind: 'other', scope: `gemini-model-${i}`, usedPercent: i }))
      : [{ kind: 'weekly', usedPercent: payload.provider === 'codex' ? 13 : 25 }],
  } }
  throw new Error(`Unexpected RPC: ${method}`)
} } as unknown as SubscriptionUsageBadgeInjected['rpc']

function App() {
  const [locale, setLocale] = useState<'en' | 'zh'>('en')
  const dictionary = locale === 'en' ? en : zh
  const t = (key: keyof typeof en, params?: Record<string, unknown>) => dictionary[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  return <>
    <button onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}>Locale</button>
    {Object.entries(selections).map(([name, next]) => <button key={name} onClick={() => { selection = next }}>{name}</button>)}
    <UsageBadgeDisplaySetting t={t} />
    <div>
      <div data-composer-stats />
      <SubscriptionUsageBadge rpc={rpc} currentModel={currentModel} t={t} />
    </div>
  </>
}
createRoot(document.getElementById('root')!).render(<App />)
