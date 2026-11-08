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

test('freshness messages distinguish unsupported, empty, failed and legacy data in both locales', async () => {
  const { usageFreshnessText } = await import('../src/client/quota-display.js')
  const windows = [{ kind: 'weekly' as const, usedPercent: 28 }]
  for (const dictionary of [en, zh]) {
    const t = (key: keyof typeof en, params?: Record<string, unknown>) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
    assert.equal(usageFreshnessText({ supported: false }, false, t), t('quotaUnsupported'))
    assert.equal(usageFreshnessText({ supported: true, windows: [] }, false, t), t('usageEmpty'))
    assert.equal(usageFreshnessText(undefined, true, t), t('quotaFailedNoData'))
    const legacy = { supported: true, windows, receivedAt: 1000 }
    assert.equal(usageFreshnessText(legacy, false, t), t('quotaReceivedAt', { date: new Date(1000).toLocaleString() }))
    assert.equal(usageFreshnessText({ ...legacy, fetchedAt: 200 }, false, t), t('quotaFetchedAt', { date: new Date(200).toLocaleString() }))
    for (const invalid of [null, NaN, Infinity, -1]) {
      assert.equal(usageFreshnessText({ ...legacy, fetchedAt: invalid as number }, false, t), usageFreshnessText(legacy, false, t))
    }
    assert.ok(usageFreshnessText({ ...legacy, staleAt: 1 }, false, t, 2000).includes(t('quotaStale')), 'known expiry is used even without fetchedAt')
    assert.ok(usageFreshnessText(legacy, true, t).includes(t('quotaRefreshFailed')))
    assert.equal(usageFreshnessText({ supported: true, windows }, false, t), t('quotaUpdateTimeMissing'))
  }
})

test('receipt times cannot masquerade as quota fetch times; cache remains account and connection scoped', async () => {
  const raw = { supported: true, windows: [{ kind: 'weekly', usedPercent: 28 }] }
  let reject = false
  const rpc = { call: async () => {
    if (reject) throw new Error('offline')
    return { ok: true, value: raw }
  } } as unknown as ConnectionHandle['rpc']
  const request = { provider: 'codex', account: 'a' }
  const response = await callSubscriptionsAuth<import('../src/client/SubscriptionsSection.js').ProviderUsage>(rpc, 'usage', { ...request, force: true })
  assert.ok(response.receivedAt! > 0)
  assert.equal(response.fetchedAt, undefined)
  assert.equal(response.staleAt, undefined)
  assert.equal('receivedAt' in raw, false)
  assert.equal(readUsageCache(rpc, 'codex:a'), response)
  assert.equal(readUsageCache(rpc, 'codex:b'), undefined)
  const otherConnection = { ...rpc }
  assert.equal(readUsageCache(otherConnection, 'codex:a'), undefined)
  reject = true
  await assert.rejects(callSubscriptionsAuth(rpc, 'usage', request), /offline/)
  assert.equal(readUsageCache(rpc, 'codex:a')?.receivedAt, response.receivedAt)
  assert.equal(readUsageCache(rpc, 'codex:a')?.refreshFailed, true)
})
