import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionUsageBadge } from '../src/client/SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from '../src/client/SubscriptionUsageBadge.js'
import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import { callSubscriptionsAuth } from '../src/client/subscriptions-rpc.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { notifyDisplayNameChange } from '../src/client/display-name-events.js'
import { en, zh } from '../src/client/locales.js'

const selections = {
  api: { provider: 'deepseek', model: 'deepseek-chat' },
  codex: { provider: 'codex', model: 'gpt-test' },
  grok: { provider: 'grok', model: 'grok-test' },
  antigravity: { provider: 'antigravity', model: 'gemini-model-29' },
}
let selection = selections.api
let visibleModels: string[] | undefined
let failGoogleUsage = false
let secondGoogleAccount = false
let grokDisplayName: string | undefined
let codexValues: unknown[] = [13]
let codexStale = false
let failCodex = false
let usageCalls = 0
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
    claude: { busy: false, accounts: [] },
    copilot: { busy: false, accounts: [] },
    codex: { busy: false, accounts: [{ key: 'codex-test', isDefault: true }] },
    grok: { busy: false, displayName: grokDisplayName, accounts: [{ key: 'grok-test', isDefault: true }] },
    antigravity: { busy: false, visibleModels, accounts: [{ key: 'anti-test', isDefault: true }, ...(secondGoogleAccount ? [{ key: 'anti-secondary', isDefault: false }] : [])] },
  } } }
  if (method.endsWith('.proxyGet')) return { ok: true, value: { enabled: false, url: '', bypass: [], passwordSet: false } }
  if (method.endsWith('.usage')) document.documentElement.dataset.usageCalls = String(++usageCalls)
  if (method.endsWith('.usage') && payload.provider === 'codex' && failCodex) throw new Error('Synthetic failure')
  if (method.endsWith('.usage') && payload.provider === 'antigravity' && failGoogleUsage) throw new Error('Simulated quota failure')
  if (method.endsWith('.usage')) return { ok: true, value: {
    supported: true, fetchedAt: Date.now() - (codexStale ? 600_000 : 1000), staleAt: Date.now() + (codexStale ? -300_000 : 299_000), windows: payload.provider === 'antigravity'
      ? Array.from({ length: 30 }, (_, i) => ({ kind: 'other', scope: `gemini-model-${i}`, usedPercent: i }))
      : payload.provider === 'codex' ? codexValues.map((usedPercent, i) => ({ kind: i === 0 ? 'session' : 'weekly', usedPercent, ...(codexStale ? { resetsAt: Date.now() - 1000 } : {}) })) : [{ kind: 'weekly', usedPercent: 25 }],
  } }
  throw new Error(`Unexpected RPC: ${method}`)
} } as unknown as SubscriptionUsageBadgeInjected['rpc']

function App() {
  const [showSettings, setShowSettings] = useState(false)
  const updateCodex = (values: unknown[], stale = false, fail = false) => {
    codexValues = values; codexStale = stale; failCodex = fail
    void callSubscriptionsAuth(rpc, 'usage', { provider: 'codex', account: 'codex-test' }).catch(() => {})
  }
  const [locale, setLocale] = useState<'en' | 'zh'>('en')
  const dictionary = locale === 'en' ? en : zh
  const t = (key: keyof typeof en, params?: Record<string, unknown>) => dictionary[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  return <>
    <style>{`:root { font-family: system-ui; --dsw-alias-bg-layer-1: #f3f4f6; --dsw-alias-bg-layer-2: white; --dsw-specific-menu: white; --dsw-elevation-prominent: 0 4px 20px #0003;
      --dsw-alias-label-primary: #171717; --dsw-alias-label-secondary: #444; --dsw-alias-label-tertiary: #666;
      --dsw-alias-label-dimmed: #888; --dsw-alias-border-l2: #ddd; --dsw-alias-border-l4: #eee;
      --dsw-alias-state-success-primary: #198754; --dsw-alias-state-error-primary: #cf222e; --dsw-alias-state-warn-label: #9a6700; }
      button, select { font: inherit; }`}</style>
    <button onClick={() => setShowSettings(!showSettings)}>Toggle settings</button>
    <button onClick={() => updateCodex([0, 100, 95, 80])}>Boundary usage</button>
    <button onClick={() => updateCodex([null])}>Unknown usage</button>
    <button onClick={() => updateCodex([28], true)}>Stale usage</button>
    <button onClick={() => updateCodex([28], false, true)}>Fail Codex usage</button>
    <button onClick={() => updateCodex([36])}>Recover usage</button>
    {showSettings && <div data-settings><SubscriptionsSection rpc={rpc} t={t} /></div>}
    <button onClick={() => { visibleModels = ['gemini-model-29', 'gemini-model-2']; secondGoogleAccount = true }}>Select Google models</button>
    <button onClick={() => { visibleModels = ['gemini-model-2'] }}>Hide current Google model</button>
    <button onClick={() => { visibleModels = [] }}>Clear Google models</button>
    <button onClick={() => { visibleModels = undefined }}>Show all Google models</button>
    <button onClick={() => { failGoogleUsage = true }}>Fail Google usage</button>
    <button onClick={() => { grokDisplayName = '我的 Grok'; notifyDisplayNameChange('grok', grokDisplayName) }}>Rename Grok</button>
    <button onClick={() => { grokDisplayName = undefined; notifyDisplayNameChange('grok', '') }}>Reset Grok</button>
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
