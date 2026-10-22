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
import type { ProviderUsage, UsageWindow } from '../src/providers/common.js'
import { PoolUsageTracker, QUOTA_EXHAUSTED_PERCENT } from '../src/providers/pool-usage.js'
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

test('snapshotFor: a rate limit with no prior success still throws (nothing to fall back to)', async () => {
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const { tracker } = trackerOf(() => Promise.reject(error))
  await assert.rejects(tracker.snapshotFor('claude', 'a1'), error)
})

test('quotaFor: a caller-set full mark gates at that level and reports the earliest reset ahead', async () => {
  const now = Date.now()
  const snapshot: ProviderUsage = {
    supported: true,
    windows: [
      { kind: 'session', usedPercent: 98, resetsAt: now + 3 * 3_600_000 },
      { kind: 'weekly', usedPercent: 40, resetsAt: now + 3_600_000 },
      { kind: 'other', usedPercent: 10, resetsAt: now - 60_000 },
    ],
  }
  const { tracker } = trackerOf(() => Promise.resolve(snapshot))
  const quota = await tracker.quotaFor(MEMBER, QUOTA_EXHAUSTED_PERCENT)
  assert.equal(quota.available, true)
  assert.equal(quota.resetsAt, now + 3_600_000, 'the earliest reset still ahead, whatever the window kind')
  assert.equal(quota.reopensAt, undefined)
  assert.equal((await tracker.quotaFor(MEMBER)).available, false, 'the default 95% mark still gates')
})

test('quotaFor: full windows reopen at the latest disclosed reset, or at the next refresh when none is disclosed', async () => {
  const now = Date.now()
  let windows: UsageWindow[] = [
    { kind: 'session', usedPercent: 100, resetsAt: now + 3_600_000 },
    { kind: 'weekly', usedPercent: 100, resetsAt: now + 3 * 24 * 3_600_000 },
  ]
  const { tracker } = trackerOf(() => Promise.resolve({ supported: true, windows }), 1_000)
  const full = await tracker.quotaFor(MEMBER, QUOTA_EXHAUSTED_PERCENT)
  assert.equal(full.available, false)
  assert.equal(full.reopensAt, now + 3 * 24 * 3_600_000)
  const passed = Date.now() - 1
  windows = [{ kind: 'session', usedPercent: 100, resetsAt: passed }]
  tracker.invalidate('claude')
  assert.equal((await tracker.quotaFor(MEMBER, QUOTA_EXHAUSTED_PERCENT)).reopensAt, passed)
  windows = [{ kind: 'session', usedPercent: 100 }]
  tracker.invalidate('claude')
  const undisclosed = await tracker.quotaFor(MEMBER, QUOTA_EXHAUSTED_PERCENT)
  assert.equal(undisclosed.reopensAt, undisclosed.fetchedAt + 1_000)
})
