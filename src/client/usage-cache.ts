import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderUsage } from './SubscriptionsSection.js'

type Rpc = ConnectionHandle['rpc']
type Listener = (key: string, usage: ProviderUsage) => void
// Connection-local, memory-only cache: no credentials or account history on disk.
const caches = new WeakMap<Rpc, { values: Map<string, ProviderUsage>; listeners: Set<Listener> }>()
function cache(rpc: Rpc) {
  let value = caches.get(rpc)
  if (!value) { value = { values: new Map(), listeners: new Set() }; caches.set(rpc, value) }
  return value
}
export function readUsageCache(rpc: Rpc, key: string): ProviderUsage | undefined { return cache(rpc).values.get(key) }
export function publishUsage(rpc: Rpc, key: string, usage: ProviderUsage): void {
  const state = cache(rpc)
  state.values.set(key, usage)
  for (const listener of state.listeners) listener(key, usage)
}
export function failUsage(rpc: Rpc, key: string): void {
  const previous = readUsageCache(rpc, key)
  if (previous) publishUsage(rpc, key, { ...previous, stale: true, refreshFailed: true })
}
export function subscribeUsage(rpc: Rpc, listener: Listener): () => void {
  cache(rpc).listeners.add(listener)
  return () => { cache(rpc).listeners.delete(listener) }
}
/** Called after a status read so logout cannot leave recoverable account history. */
export function retainUsageAccounts(rpc: Rpc, live: Set<string>): void {
  for (const key of cache(rpc).values.keys()) if (!live.has(key)) cache(rpc).values.delete(key)
}
