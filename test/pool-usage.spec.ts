/**
 * PoolUsageTracker's negative cache: a fetch failure must gate retries the
 * same way a success does, or a progressively rate-limited usage endpoint
 * (Anthropic's `/oauth/usage`: 429 with a `retry-after` that grows on every
 * hit inside the window) never gets a chance to recover — see upstream
 * issue #46. Credential failures are the one exception: they cost no
 * network round trip and must stay live so a fixed login rejoins instantly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { ProviderUsage } from '../src/providers/common.js'
import { normalizedWindowUrgency, PoolUsageTracker } from '../src/providers/pool-usage.js'
import type { ProviderId } from '../src/auth/store.js'

const MEMBER = { provider: 'claude' as const, account: 'a1', model: 'claude-opus-5' }

const OK_USAGE: ProviderUsage = { supported: true, windows: [{ kind: 'session', usedPercent: 10 }] }

/** A tracker whose sole fetcher counts calls and answers from a script. */
function trackerOf(
  fetcher: () => Promise<ProviderUsage>,
  ttlMs?: number,
): { tracker: PoolUsageTracker; calls: { count: number } } {
  const calls = { count: 0 }
  const tracker = new PoolUsageTracker(
    (provider: ProviderId, account: string) =>
      provider === MEMBER.provider && account === MEMBER.account
        ? () => { calls.count += 1; return fetcher() }
        : undefined,
    ttlMs,
  )
  return { tracker, calls }
}

test('quotaFor: a 429 with retry-after is cached — the second call within the window skips the network', async () => {
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const { tracker, calls } = trackerOf(() => Promise.reject(error))
  const first = await tracker.quotaFor(MEMBER)
  assert.deepEqual(first, { available: true, urgency: 0, fetchedAt: 0 })
  const second = await tracker.quotaFor(MEMBER)
  assert.deepEqual(second, { available: true, urgency: 0, fetchedAt: 0 })
  assert.equal(calls.count, 1, 'the cooling-down failure must not be retried')
})

test('quotaFor: a failure with no retry-after falls back to the default TTL', async () => {
  const { tracker, calls } = trackerOf(() => Promise.reject(new Error('network blip')), 50)
  await tracker.quotaFor(MEMBER)
  await tracker.quotaFor(MEMBER)
  assert.equal(calls.count, 1, 'still within the default TTL')
  await new Promise(resolve => setTimeout(resolve, 60))
  await tracker.quotaFor(MEMBER)
  assert.equal(calls.count, 2, 'the TTL expired, so this call retries')
})

test('quotaFor: a missing/invalid credential is never negative-cached, so recovery is immediate', async () => {
  let broken = true
  const { tracker, calls } = trackerOf(() =>
    broken ? Promise.reject(new LlmError('logged out', 'MISSING_CREDENTIAL')) : Promise.resolve(OK_USAGE))
  const first = await tracker.quotaFor(MEMBER)
  assert.deepEqual(first, { available: false, urgency: 0, fetchedAt: 0 })
  broken = false
  const second = await tracker.quotaFor(MEMBER)
  assert.equal(second.available, true)
  assert.equal(calls.count, 2, 'every call re-checks credentials live, no cooldown')
})

test('quotaFor: a stale success still serves cached data while a background refresh runs', async () => {
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE), 10)
  await tracker.quotaFor(MEMBER)
  await new Promise(resolve => setTimeout(resolve, 20))
  const stale = await tracker.quotaFor(MEMBER)
  assert.equal(stale.available, true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.count, 2, 'the stale read triggered exactly one background refresh')
})

test('snapshotFor: a live failure cooldown is never bypassed, even by a forced (manual refresh) call', async () => {
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const { tracker, calls } = trackerOf(() => Promise.reject(error))
  await assert.rejects(tracker.snapshotFor('claude', 'a1'), error)
  await assert.rejects(tracker.snapshotFor('claude', 'a1', true), error)
  assert.equal(calls.count, 1, 'force must not punch through an active cooldown')
})

test('snapshotFor: force bypasses a fresh SUCCESS cache for an honest re-check', async () => {
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE))
  await tracker.snapshotFor('claude', 'a1')
  await tracker.snapshotFor('claude', 'a1')
  assert.equal(calls.count, 1, 'plain calls reuse the fresh cache')
  await tracker.snapshotFor('claude', 'a1', true)
  assert.equal(calls.count, 2, 'a forced call re-fetches regardless of freshness')
})

test('snapshotFor: a provider without a usage fetcher answers supported:false', async () => {
  const tracker = new PoolUsageTracker(() => undefined)
  const usage = await tracker.snapshotFor('grok', 'a1')
  assert.deepEqual(usage, { supported: false })
})

test('snapshotFor: a rate limit after a prior success serves the stale snapshot instead of throwing', async () => {
  let rateLimited = false
  const { tracker, calls } = trackerOf(() => {
    if (rateLimited) {
      return Promise.reject(new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000))
    }
    return Promise.resolve(OK_USAGE)
  }, 10)

  const first = await tracker.snapshotFor('claude', 'a1')
  assert.deepEqual(first, OK_USAGE)

  // Past the 10ms TTL, so the next call re-fetches instead of serving the
  // fresh-cache fast path.
  await new Promise(resolve => setTimeout(resolve, 20))
  rateLimited = true
  const second = await tracker.snapshotFor('claude', 'a1')
  assert.deepEqual(second, OK_USAGE, 'a rate-limited refresh should serve the last-known snapshot, not throw')
  assert.equal(calls.count, 2)

  // Still cooling down: repeat calls (forced or not) keep serving the
  // stale snapshot rather than re-hitting the endpoint or throwing.
  const third = await tracker.snapshotFor('claude', 'a1')
  const forced = await tracker.snapshotFor('claude', 'a1', true)
  assert.deepEqual(third, OK_USAGE)
  assert.deepEqual(forced, OK_USAGE)
  assert.equal(calls.count, 2, 'the live cooldown must not be bypassed even by a forced call')
})

test('snapshotFor: the stale snapshot is carried across consecutive failure cooldowns', async () => {
  const FRESH_USAGE: ProviderUsage = { supported: true, windows: [{ kind: 'session', usedPercent: 42 }] }
  let answer: ProviderUsage | 'rate-limited' = OK_USAGE
  const { tracker, calls } = trackerOf(() => {
    if (answer === 'rate-limited') {
      // A short retry-after so the cooldown expires within the test.
      return Promise.reject(new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 10))
    }
    return Promise.resolve(answer)
  }, 10)

  assert.deepEqual(await tracker.snapshotFor('claude', 'a1'), OK_USAGE)
  await new Promise(resolve => setTimeout(resolve, 20))
  answer = 'rate-limited'

  // First failure: the snapshot on record is carried onto the failure entry.
  assert.deepEqual(await tracker.snapshotFor('claude', 'a1'), OK_USAGE)
  assert.equal(calls.count, 2)

  // The cooldown expires and the retry fails AGAIN. The entry being replaced
  // is now a failure entry, not a snapshot — its carried snapshot must be
  // carried forward once more rather than dropped.
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(await tracker.snapshotFor('claude', 'a1'), OK_USAGE, 'a second consecutive failure must not lose the stale snapshot')
  assert.equal(calls.count, 3, 'the expired cooldown allowed one retry')
  assert.deepEqual(await tracker.snapshotFor('claude', 'a1'), OK_USAGE, 'and the new cooldown keeps serving it')
  assert.equal(calls.count, 3)

  // A later success replaces the stale snapshot for real.
  await new Promise(resolve => setTimeout(resolve, 20))
  answer = FRESH_USAGE
  assert.deepEqual(await tracker.snapshotFor('claude', 'a1'), FRESH_USAGE)
  assert.equal(calls.count, 4)
})

for (const used of [94.99, 95, 99.99, 100, 105]) {
  test(`quotaFor: raw ${used}% distinguishes near-full from exhausted`, async () => {
    const { tracker } = trackerOf(async () => ({ supported: true, windows: [{ kind: 'weekly', usedPercent: used }] }))
    const quota = await tracker.quotaFor(MEMBER)
    assert.equal(quota.available, used < 95)
    assert.equal(quota.exhausted === true, used >= 100)
  })
}

test('quotaFor: exhaustion applies only to the requested model, even after a fetch failure', async () => {
  let fail = false
  const { tracker } = trackerOf(async () => {
    if (fail) throw new Error('offline')
    return { supported: true, windows: [
      { kind: 'weekly', scope: 'opus', usedPercent: 100, resetsAt: Date.now() - 1000 },
      { kind: 'weekly', scope: 'sonnet', usedPercent: 20 },
    ] }
  })
  assert.equal((await tracker.quotaFor(MEMBER)).exhausted, true, 'reset timestamp alone does not confirm a reset')
  assert.equal((await tracker.quotaFor({ ...MEMBER, model: 'claude-sonnet-5' })).exhausted, undefined)
  fail = true
  await tracker.snapshotFor(MEMBER.provider, MEMBER.account, true)
  assert.equal((await tracker.quotaFor(MEMBER)).exhausted, true)
  assert.equal((await tracker.quotaFor({ ...MEMBER, model: 'claude-sonnet-5' })).exhausted, undefined)
})

test('quotaFor: exhausted snapshot awaits expired refresh and restores routing on the same call', async () => {
  let finish: ((usage: ProviderUsage) => void) | undefined
  let reads = 0
  const { tracker, calls } = trackerOf(async () => {
    if (++reads === 1) return { supported: true, windows: [{ kind: 'weekly', usedPercent: 100 }] }
    return new Promise<ProviderUsage>(resolve => { finish = resolve })
  }, 0)
  assert.equal((await tracker.quotaFor(MEMBER)).exhausted, true)
  const pending = tracker.quotaFor(MEMBER)
  const duplicate = tracker.quotaFor(MEMBER)
  assert.equal(calls.count, 2, 'concurrent reads share the recovery fetch')
  assert.ok(finish)
  finish(OK_USAGE)
  assert.equal((await pending).available, true)
  assert.equal((await duplicate).exhausted, undefined)
})

test('quotaFor: exhausted status survives consecutive usage failures and their cooldowns', async () => {
  let fail = false
  const { tracker, calls } = trackerOf(async () => {
    if (fail) throw new OAuthEndpointError('limited', 429, undefined, 60_000)
    return { supported: true, windows: [{ kind: 'weekly', usedPercent: 100 }] }
  }, 0)
  await tracker.quotaFor(MEMBER)
  fail = true
  const failed = await tracker.quotaFor(MEMBER)
  assert.equal(failed.exhausted, true)
  assert.equal(failed.urgency, 0)
  assert.equal((await tracker.quotaFor(MEMBER)).exhausted, true)
  assert.equal(calls.count, 2, 'live cooldown is respected')
})

test('quotaFor: inference invalidation preserves exhausted model lanes through failed refresh', async () => {
  let fail = false
  const { tracker, calls } = trackerOf(async () => {
    if (fail) throw new Error('offline')
    return { supported: true, windows: [{ kind: 'weekly', scope: 'opus', usedPercent: 100 }] }
  })
  await tracker.quotaFor(MEMBER)
  tracker.expire(MEMBER.provider, MEMBER.account)
  fail = true
  assert.equal((await tracker.quotaFor({ ...MEMBER, model: 'claude-sonnet-5' })).exhausted, undefined)
  assert.equal((await tracker.quotaFor(MEMBER)).exhausted, true)
  tracker.expire(MEMBER.provider, MEMBER.account)
  assert.equal((await tracker.quotaFor(MEMBER)).exhausted, true)
  assert.equal(calls.count, 2, 'inference expiration does not bypass the usage-endpoint cooldown')
})

test('quotaFor: repeated failed recovery attempts retain exhaustion until a successful lookup', async () => {
  let used = 100
  let fail = false
  const { tracker } = trackerOf(async () => {
    if (fail) throw new Error('offline')
    return { supported: true, windows: [{ kind: 'weekly', usedPercent: used }] }
  }, 0)
  await tracker.quotaFor(MEMBER)
  fail = true
  for (let i = 0; i < 3; i++) assert.equal((await tracker.quotaFor(MEMBER)).exhausted, true)
  fail = false
  used = 0
  assert.equal((await tracker.quotaFor(MEMBER)).exhausted, undefined)
})

test('snapshotFor: a rate limit with no prior success still throws (nothing to fall back to)', async () => {
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const { tracker } = trackerOf(() => Promise.reject(error))
  await assert.rejects(tracker.snapshotFor('claude', 'a1'), error)
})

test('normalized urgency uses total duration, never guesses from time to reset', () => {
  const hour = 3600000
  const now = 1_800_000_000_000
  const score = (duration: number | undefined, left: number, used = 0) => normalizedWindowUrgency({
    kind: 'other', usedPercent: used, resetsAt: now + left,
    ...(duration === undefined ? {} : { durationMs: duration }),
  }, now)
  for (const length of [3, 5, 7 * 24]) {
    assert.equal(score(length * hour, length * hour), 1)
    assert.equal(score(length * hour, length * hour / 2), 2)
  }
  const scores = [-1, 0, 1].map(ms => score(24 * hour, 6 * hour + ms))
  assert.equal(scores[1], 4)
  assert.ok(scores[0] > scores[1] && scores[1] > scores[2] && scores[0] - scores[2] < 0.000001)
  for (const duration of [undefined, 0, NaN, Infinity]) {
    for (const left of [-1, 6 * hour - 1, 6 * hour + 1]) assert.equal(score(duration, left, 25), 0.75)
  }
  assert.equal(normalizedWindowUrgency({kind: 'other', usedPercent: 25, durationMs: hour}, now), 0.75)
  assert.equal(score(hour, -1), 1000)
  assert.equal(score(hour, -1, 100), 0)
})

test('Antigravity grouped pools respect exhausted concrete variant quotas', async () => {
  const usage: ProviderUsage = { supported: true, windows: [
    { kind: 'other', scope: 'gemini-4-argon-high', usedPercent: 100 },
    { kind: 'other', scope: 'claude-opus-5-5-medium', usedPercent: 20 },
  ] }
  const tracker = new PoolUsageTracker(() => async () => usage)
  const member = { provider: 'antigravity' as const, account: 'test', model: 'gemini-4-argon' }
  assert.equal((await tracker.quotaFor(member)).available, false)
  assert.equal((await tracker.quotaFor({ ...member, model: 'claude-opus-5-5' })).available, true)
})

test('shared Antigravity Gemini quotas also constrain Argon and retain explicit extra limits', async () => {
  const tracker = new PoolUsageTracker(() => async () => ({ supported: true, windows: [
    { kind: 'weekly', scope: 'Gemini Models', usedPercent: 100 },
    { kind: 'session', scope: 'Claude and GPT models', usedPercent: 100 },
    { kind: 'weekly', scope: 'Gemini 4 Argon', usedPercent: 33 },
  ] }))
  const member = { provider: 'antigravity' as const, account: 'test', model: 'gemini-3.8-flash' }
  assert.equal((await tracker.quotaFor(member)).available, false)
  assert.equal((await tracker.quotaFor({ ...member, model: 'claude-opus-5-5' })).available, false)
  assert.equal((await tracker.quotaFor({ ...member, model: 'gpt-oss-120b' })).available, false)
  assert.equal((await tracker.quotaFor({ ...member, model: 'gemini-4-argon' })).available, false)
})
