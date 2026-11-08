import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quotaPercent, quotaText, quotaIsStale } from '../src/client/quota-display.js'
import { en, zh } from '../src/client/locales.js'
import { callSubscriptionsAuth } from '../src/client/subscriptions-rpc.js'
import { readUsageCache, subscribeUsage } from '../src/client/usage-cache.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

test('used/remaining handles bounds and unknown telemetry without inventing allowance', () => {
  for (const [used, remaining] of [[0, 100], [100, 0], [120, 0], [-20, 100], [28, 72], [99.9, 0]]) {
    assert.equal(quotaPercent(used, 'remaining'), remaining)
    assert.equal(quotaPercent(used, 'used'), Math.round(Math.min(100, Math.max(0, used!))))
  }
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '0', false]) {
    assert.equal(quotaPercent(value, 'used'), undefined)
    assert.equal(quotaPercent(value, 'remaining'), undefined)
    for (const dictionary of [en, zh]) assert.equal(quotaText(value, 'remaining', key => dictionary[key]), dictionary.quotaUnknown)
  }
})

test('freshness expires independently of rerendering or display mode', () => {
  assert.equal(quotaIsStale({ supported: true, staleAt: 20 }, 19), false)
  assert.equal(quotaIsStale({ supported: true, staleAt: 20 }, 20), true)
  assert.equal(quotaIsStale({ supported: true, refreshFailed: true }, 0), true)
})

test('shared usage reads and notifications do not issue RPCs; failures retain metadata, recovery replaces it, logout prunes', async () => {
  let calls = 0
  let failed = false
  const rpc = { call: async (_channel: string, endpoint: string) => {
    calls++
    if (failed) throw new Error('offline')
    return { ok: true, value: endpoint.endsWith('.status') ? { providers: { codex: { accounts: [] } } }
      : { supported: true, windows: [{ kind: 'weekly', usedPercent: 28 }], fetchedAt: 10, staleAt: 20 } }
  } } as unknown as ConnectionHandle['rpc']
  let updates = 0
  const unsubscribe = subscribeUsage(rpc, () => { updates++ })
  const request = { provider: 'codex', account: 'synthetic' }
  await callSubscriptionsAuth(rpc, 'usage', request)
  assert.equal(updates, 1)
  const cached = readUsageCache(rpc, 'codex:synthetic')!
  assert.equal(cached.windows?.[0]?.usedPercent, 28)
  assert.equal(calls, 1)
  failed = true
  await assert.rejects(callSubscriptionsAuth(rpc, 'usage', request), /offline/)
  const stale = readUsageCache(rpc, 'codex:synthetic')!
  assert.equal(stale.fetchedAt, 10)
  assert.equal(stale.refreshFailed, true)
  assert.equal(stale.windows, cached.windows)
  failed = false
  await callSubscriptionsAuth(rpc, 'usage', request)
  assert.equal(readUsageCache(rpc, 'codex:synthetic')?.refreshFailed, undefined)
  await callSubscriptionsAuth(rpc, 'status', {})
  assert.equal(readUsageCache(rpc, 'codex:synthetic'), undefined)
  assert.equal(calls, 4)
  unsubscribe()
})
