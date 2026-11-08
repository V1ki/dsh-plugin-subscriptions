import { createRoot } from 'react-dom/client'
import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import { SubscriptionUsageBadge } from '../src/client/SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from '../src/client/SubscriptionUsageBadge.js'

const rpc = { call: async (_channel: string, method: string, payload: unknown) => {
  const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'browser-test', method, payload }) })
  return (await response.json()).result
} } as SubscriptionUsageBadgeInjected['rpc']
const currentModel = async () => ({ provider: 'codex', model: 'synthetic-model' })
createRoot(document.getElementById('root')!).render(<>
  <div data-composer-stats />
  <SubscriptionUsageBadge rpc={rpc} currentModel={currentModel} />
  <SubscriptionsSection rpc={rpc} />
</>)
