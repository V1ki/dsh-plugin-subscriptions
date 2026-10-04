import test from 'node:test'
import assert from 'node:assert/strict'
import { ResetRedemption } from '../src/providers/reset-redemption.js'
import { consumeCodexResetCredit } from '../src/providers/codex.js'
import type { ProviderUsage } from '../src/providers/common.js'

function usage(percent = 90): ProviderUsage {
  return { supported: true, windows: [{ kind: 'weekly', usedPercent: percent, resetsAt: Date.now() + 60000 }], resetCredits: [{ id: 'later', expiresAt: Date.now() + 60000 }, { id: 'first', expiresAt: Date.now() + 30000 }] }
}
const signal = new AbortController().signal

test('manual reset blocks low/missing usage and selects earliest expiry', async () => {
  let snapshot = usage(79)
  const calls: string[] = []
  const service = new ResetRedemption(async () => snapshot, async (_, id) => { calls.push(id) }, () => {})
  await assert.rejects(service.prepare('a', signal), /80%/)
  snapshot = usage()
  const confirmation = await service.prepare('a', signal)
  await service.redeem('a', confirmation.ticket, signal)
  assert.deepEqual(calls, ['first'])
  await assert.rejects(service.redeem('a', confirmation.ticket, signal), /expired/)
  snapshot = { supported: true }
  await assert.rejects(service.prepare('a', signal), /80%/)
})

test('manual reset rechecks usage, binds account and parks uncertain submissions', async () => {
  let snapshot = usage()
  let calls = 0
  const service = new ResetRedemption(async () => snapshot, async () => { calls++; throw new Error('timeout') }, () => {})
  let confirmation = await service.prepare('a', signal)
  await assert.rejects(service.redeem('b', confirmation.ticket, signal), /expired/)
  confirmation = await service.prepare('a', signal)
  snapshot = usage(10)
  await assert.rejects(service.redeem('a', confirmation.ticket, signal), /80%/)
  assert.equal(calls, 0)
  snapshot = usage()
  confirmation = await service.prepare('a', signal)
  await assert.rejects(service.redeem('a', confirmation.ticket, signal), /could not be confirmed/)
  await assert.rejects(service.prepare('a', signal), /uncertain/)
  assert.equal(calls, 1)
})

test('expired confirmation and removed credit never submit a reset', async t => {
  let snapshot = usage()
  let calls = 0
  const service = new ResetRedemption(async () => snapshot, async () => { calls++ }, () => {})
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  snapshot = usage()
  const expired = await service.prepare('a', signal)
  t.mock.timers.tick(60_001)
  await assert.rejects(service.redeem('a', expired.ticket, signal), /expired/)
  snapshot = usage()
  const removed = await service.prepare('a', signal)
  snapshot.resetCredits = []
  await assert.rejects(service.redeem('a', removed.ticket, signal), /no longer available/)
  assert.equal(calls, 0)
})

test('in-flight redemption blocks another confirmation and invalidates usage once', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let invalidations = 0
  let calls = 0
  const service = new ResetRedemption(async () => usage(), async () => { calls++; await pending }, () => { invalidations++ })
  const confirmation = await service.prepare('a', signal)
  const redemption = service.redeem('a', confirmation.ticket, signal)
  await assert.rejects(service.prepare('a', signal), /pending/)
  await assert.rejects(service.redeem('a', confirmation.ticket, signal), /expired/)
  release()
  await redemption
  assert.equal(calls, 1)
  assert.equal(invalidations, 1)
})

test('unexpected consume responses are not silently accepted or retried', async () => {
  let calls = 0
  await assert.rejects(consumeCodexResetCredit({ accessToken: 'fake', refreshToken: 'fake', accountId: 'a', expiresAt: 0 }, 'credit', 'request', async () => {
    calls++
    return new Response(JSON.stringify({ code: 'unknown' }), { status: 200 })
  }, signal), /not confirmed/)
  assert.equal(calls, 1)
})

test('consume request is single POST with explicit credit and request IDs', async () => {
  let calls = 0
  await consumeCodexResetCredit({ accessToken: 'fake', refreshToken: 'fake', accountId: 'a', expiresAt: 0 }, 'credit', 'request', async (url, init) => {
    calls++
    assert.ok(String(url).endsWith('/rate-limit-reset-credits/consume'))
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { credit_id: 'credit', redeem_request_id: 'request' })
    return new Response(JSON.stringify({ code: 'reset' }), { status: 200 })
  }, signal)
  assert.equal(calls, 1)
})
