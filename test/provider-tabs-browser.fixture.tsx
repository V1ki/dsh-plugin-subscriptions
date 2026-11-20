import { createRoot } from 'react-dom/client'
import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import { SubscriptionUsageBadge } from '../src/client/SubscriptionUsageBadge.js'

// Synthetic RPC only: hold the first status so tests can choose a tab before it arrives.
const state = window as any
const account = (provider: string) => ({ key: provider, account: `${provider}@example.test`, isDefault: true })

state.providers = {
  codex: { busy: false, accounts: [account('codex')], displayName: 'Zulu' },
  claude: { busy: false, accounts: [account('claude')], displayName: 'Alpha' },
  grok: { busy: false, accounts: [] },
  copilot: { busy: false, accounts: [] },
  antigravity: { busy: false, accounts: [] },
  'qwen-subscription': { busy: false, accounts: [] },
}
state.calls = []
state.selection = { provider: state.enableBadge ? 'qwen' : 'deepseek', model: 'qwen-test' }
if (state.enableBadge) state.providers['qwen-subscription'].accounts = [account('qwen-subscription')]
let releaseStatus!: () => void
const firstStatus = new Promise<void>(resolve => { releaseStatus = resolve })
state.releaseStatus = releaseStatus
let statusCalls = 0
const rpc = { call: async (_channel: string, method: string, payload: any) => {
  const endpoint = method.split('.').at(-1)
  state.calls.push({ endpoint, payload: structuredClone(payload) })
  if (endpoint === 'status') {
    state.statusCalls = ++statusCalls
    if (statusCalls === 1) await firstStatus
    const providers = structuredClone(state.providers)
    if (statusCalls === 1 && state.firstStatusOverride) Object.assign(providers, state.firstStatusOverride)
    if (state.statusMode === 'missing') delete providers.copilot
    if (state.statusMode === 'error') providers.copilot = { busy: false, accounts: [], detail: 'status temporarily unavailable', statusUnavailable: true }
    return { ok: true, value: { providers } }
  }
  if (endpoint === 'login') {
    state.loginCalls = (state.loginCalls ?? 0) + 1
    if (state.holdLogin) await new Promise<void>(resolve => { state.releaseLogin = resolve })
    if (payload.provider === 'copilot' || payload.provider === 'qwen-subscription') {
      state.providers[payload.provider].busy = true
      return { ok: true, value: { authorizeUrl: 'https://example.test/device', userCode: 'ABCD-1234' } }
    }
    state.providers[payload.provider].accounts = [account(payload.provider)]
    return { ok: true, value: { authorizeUrl: '' } }
  }
  if (endpoint === 'cancel' && state.failCancel) return { ok: false, error: { code: 'internal', message: 'cancel failed', details: {} } }
  if (endpoint === 'cancel') {
    state.providers[payload.provider].busy = false
    return { ok: true, value: {} }
  }
  if (endpoint === 'providerSettings') return { ok: true, value: { provider: payload.provider, settings: {}, accounts: [], models: [], tools: [] } }
  if (endpoint === 'logout') {
    state.providers[payload.provider].accounts = []
    return { ok: true, value: {} }
  }
  if (endpoint === 'proxyGet') return { ok: true, value: { enabled: false, url: '', bypass: [], passwordSet: false } }
  if (endpoint === 'usage') return { ok: true, value: { supported: false, windows: [] } }
  return { ok: true, value: {} }
} } as any
const currentModel = async () => {
  state.modelReads = (state.modelReads ?? 0) + 1
  return state.selection
}
createRoot(document.getElementById('root')!).render(<><SubscriptionsSection rpc={rpc} />{state.enableBadge && <><div data-composer-stats /><SubscriptionUsageBadge rpc={rpc} currentModel={currentModel} /></>}</>)
