import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import { callSubscriptionsAuth } from '../src/client/subscriptions-rpc.js'
import { readUsageCache, subscribeUsage } from '../src/client/usage-cache.js'
import type { ProviderUsage } from '../src/client/SubscriptionsSection.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { QuotaExhaustionNotice, quotaExhaustionText } from '../src/client/QuotaExhaustionNotice.js'
import { en, zh } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import type { ProviderUsageDisplay } from '../src/client/SubscriptionUsageBadge.js'
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {}', shortCircuit: true } : nextLoad(url, context)
} })
const { compactSegment } = await import('../src/client/SubscriptionUsageBadge.js')
css.deregister()
const t = (key: SubscriptionsKey, params?: Record<string, unknown>) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
const reset = Date.UTC(2030, 0, 2, 12, 34, 56)
const display = (resetsAt?: number): ProviderUsageDisplay => ({ provider: 'qwen-subscription', name: 'Qwen', accounts: [{ key: 'a', isDefault: true, windows: [], usage: { supported: false, quotaExhaustion: { observedAt: reset - 1000, ...(resetsAt === undefined ? {} : { resetsAt }) } } }] })

test('unsupported usage still renders explicit exhausted quota without percentage or progress UI', () => {
  const usage = display().accounts[0]!.usage!
  const html = renderToStaticMarkup(createElement(QuotaExhaustionNotice, { exhaustion: usage.quotaExhaustion, t }))
  assert.match(html, /role="status"/)
  assert.match(html, /Quota exhausted/)
  assert.match(html, /Reset time unknown/)
  assert.doesNotMatch(html, /%|progress|width:/)
  assert.match(compactSegment(display()), /Quota exhausted.*Reset time unknown/)
})

test('reset is local date/time with explicit timezone, and elapsed reset never means recovery', () => {
  const exhaustion = { observedAt: reset - 1000, resetsAt: reset }
  const expected = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(reset))
  const future = quotaExhaustionText(exhaustion, t, reset - 1)!
  assert.ok(future.includes(expected))
  assert.doesNotMatch(future, /awaiting confirmation/)
  const elapsed = quotaExhaustionText(exhaustion, t, reset)!
  assert.match(elapsed, /awaiting confirmation from the provider/)
  assert.match(elapsed, /Restored quota is not confirmed/)
  assert.match(compactSegment(display(1)), /awaiting confirmation/)
})

test('missing/invalid reset remains unknown and absent exhaustion renders nothing', () => {
  for (const resetsAt of [undefined, NaN, Infinity, -1, 9e99]) {
    assert.match(quotaExhaustionText({ observedAt: reset, ...(resetsAt === undefined ? {} : { resetsAt }) }, t)!, /Reset time unknown/)
  }
  assert.equal(renderToStaticMarkup(createElement(QuotaExhaustionNotice, { exhaustion: undefined, t })), '')
  assert.equal(quotaExhaustionText(undefined, t), undefined)
})

test('multiple accounts warn without implying pooled depletion; other providers retain usage', () => {
  const d = display()
  d.accounts.push({ key: 'b', isDefault: false, windows: [] })
  assert.match(compactSegment(d), /2 signed-in accounts.*1 account\(s\): quota exhausted/)
  const normal: ProviderUsageDisplay = { provider: 'grok', name: 'Grok', accounts: [{ key: 'g', isDefault: true, windows: [{ kind: 'weekly', usedPercent: 25 }], usage: { supported: true } }] }
  assert.match(compactSegment(normal), /25% used/)
  assert.doesNotMatch(compactSegment(normal), /exhausted/)
})

test('next memory usage read replaces unsupported cache and publishes observation without inventing recovery', async () => {
  let value: ProviderUsage = { supported: false }
  let calls = 0
  const rpc = { call: async () => { calls++; return { ok: true, value } } } as unknown as ConnectionHandle['rpc']
  const changes: ProviderUsage[] = []
  const unsubscribe = subscribeUsage(rpc, (_key, usage) => changes.push(usage))
  try {
    await callSubscriptionsAuth(rpc, 'usage', { provider: 'qwen-subscription', account: 'a' })
    assert.equal(readUsageCache(rpc, 'qwen-subscription:a')?.quotaExhaustion, undefined)
    value = { supported: false, quotaExhaustion: { observedAt: Date.now(), resetsAt: 1 } }
    await callSubscriptionsAuth(rpc, 'usage', { provider: 'qwen-subscription', account: 'a', force: true })
    assert.equal(calls, 2, 'unsupported cache never suppresses the next RPC read')
    assert.equal(changes.length, 2)
    assert.equal(changes[1]?.quotaExhaustion?.resetsAt, 1)
    assert.match(quotaExhaustionText(changes[1]?.quotaExhaustion, t)!, /awaiting confirmation/)
  } finally { unsubscribe() }
})

test('Settings and expanded badge wire shared warning independently of query support; live memory reads stay bounded', async () => {
  // Integration wiring guard; effect/DOM interaction requires the optional browser harness.
  const settings = await readFile(new URL('../../src/client/SubscriptionsSection.tsx', import.meta.url), 'utf8')
  const badge = await readFile(new URL('../../src/client/SubscriptionUsageBadge.tsx', import.meta.url), 'utf8')
  assert.ok(settings.includes('<QuotaExhaustionNotice exhaustion={usage?.quotaExhaustion}'))
  assert.ok(badge.includes('<QuotaExhaustionNotice exhaustion={account.usage?.quotaExhaustion}'))
  assert.ok(settings.includes("id === 'qwen-subscription' || usage.quotaExhaustion !== undefined"))
  assert.ok(settings.includes("void loadUsage('qwen-subscription', account.key)"))
  assert.ok(settings.includes('setInterval(readObservations, 30_000)'))
  assert.ok(settings.includes("window.addEventListener('focus', readObservations)"))
  assert.ok(settings.includes("window.removeEventListener('focus', readObservations)"))
  assert.ok(badge.includes("window.addEventListener('focus', onFocus)"))
  assert.ok(badge.includes("setInterval(onFocus, 30_000)"))
  assert.ok(badge.includes("clearInterval(observationsTimer)"))
  assert.ok(badge.includes("disposed || observationsInflight || inflightRef.current"))
  assert.ok(badge.includes("if (displayMode === 'hidden') return"))
})

test('exhaustion strings exist in both shipped locales', () => {
  for (const key of ['quotaExhausted', 'quotaExhaustedAccounts', 'quotaExhaustionResetAt', 'quotaExhaustionResetUnknown', 'quotaExhaustionAwaiting'] as const) {
    assert.ok(en[key]); assert.ok(zh[key])
  }
})
