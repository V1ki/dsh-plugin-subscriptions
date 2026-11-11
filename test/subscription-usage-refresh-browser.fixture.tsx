/**
 * Offline fixture for the status-bar click refresh (see
 * subscription-usage-refresh-browser.mjs). A fake `subscriptions-auth` RPC
 * with synthetic accounts records every payload and can be made slow or
 * failing on demand through `window.usageFixture`; no server, credentials or
 * network are involved.
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionUsageBadge } from '../src/client/SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from '../src/client/SubscriptionUsageBadge.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { en, zh } from '../src/client/locales.js'

/**
 * Synthetic logged-in accounts the `status` RPC lists (every one must be
 * refreshed). The selected provider (Claude) has ONE account so its pill shows
 * percentages; a multi-account provider's pill shows only an account count.
 */
const ACCOUNTS = { claude: ['claude-a'], codex: ['codex-a', 'codex-b'] } as const

interface Fixture {
  /** Every RPC call in order: endpoint name plus its payload. */
  calls: { endpoint: string; payload: Record<string, unknown> }[]
  /** Session-window percent the provider reports next. */
  percent: number
  refreshFailed?: boolean
  /** When true, `usage` answers only after `release()`. */
  hold: boolean
  /** Answer every held `usage` call. */
  release: () => void
  /** When set, `usage` answers an error result with this message. */
  failUsage: string | undefined
  /** When set, `status` answers an error result with this message. */
  failStatus: string | undefined
}

let releaseHeld: (() => void)[] = []
const fixture: Fixture = {
  calls: [], percent: 19, hold: false, failUsage: undefined, failStatus: undefined,
  release: () => { const held = releaseHeld; releaseHeld = []; for (const resume of held) resume() },
}
;(window as unknown as { usageFixture: Fixture }).usageFixture = fixture

const rpc = { call: async (_channel: string, method: string, payload: Record<string, unknown>) => {
  const endpoint = method.slice(method.lastIndexOf('.') + 1)
  fixture.calls.push({ endpoint, payload: { ...payload } })
  if (endpoint === 'status') {
    if (fixture.failStatus !== undefined) return { ok: false, error: { code: 'internal', message: fixture.failStatus } }
    return { ok: true, value: { providers: Object.fromEntries(Object.entries(ACCOUNTS).map(([provider, keys]) =>
      [provider, { busy: false, accounts: keys.map((key, index) => ({ key, isDefault: index === 0 })) }])) } }
  }
  if (endpoint === 'usage') {
    if (fixture.hold) await new Promise<void>(resume => { releaseHeld.push(resume) })
    if (fixture.failUsage !== undefined) return { ok: false, error: { code: 'internal', message: fixture.failUsage } }
    return { ok: true, value: { supported: true, refreshFailed: fixture.refreshFailed, stale: fixture.refreshFailed, windows: [
      { kind: 'session', usedPercent: fixture.percent },
      { kind: 'weekly', usedPercent: 5 },
    ] } }
  }
  throw new Error(`Unexpected RPC: ${method}`)
} } as unknown as SubscriptionUsageBadgeInjected['rpc']

/** `?provider=codex` selects the multi-account provider; Claude otherwise. */
const selectedProvider = new URLSearchParams(location.search).get('provider') ?? 'claude'
const currentModel = async () => ({ provider: selectedProvider, model: `${selectedProvider}-test` })

function App() {
  const [locale, setLocale] = useState<'en' | 'zh'>('en')
  const dictionary = locale === 'en' ? en : zh
  const t = (key: keyof typeof en, params?: Record<string, unknown>) => dictionary[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  return <>
    <button onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}>Locale</button>
    <UsageBadgeDisplaySetting t={t} />
    <p>Outside area</p>
    {/* Pinned to the bottom like the host composer, so the popover opens above the pill instead of covering it. */}
    <div style={{ position: 'fixed', left: 8, bottom: 8 }}>
      <div data-composer-stats />
      <SubscriptionUsageBadge rpc={rpc} currentModel={currentModel} t={t} />
    </div>
  </>
}
createRoot(document.getElementById('root')!).render(<App />)
