/**
 * Black-box tests of the status-bar click refresh gate (`UsageRefreshGate`)
 * and the per-round failure reducer (`usageRefreshFailure`), derived from the
 * feature requirements:
 *   R1 a click asks for a forced (cache-bypassing) refresh; polls never force.
 *   R2 a request while a round is in flight joins it — except that ONE forced
 *      round is queued behind an in-flight plain round for an eligible click.
 *   R3 forced rounds start at most once per 60 000 ms, measured from the START
 *      of the previous forced round; an ineligible click re-reads plainly.
 * The clock is injected and every `run` round is a controllable deferred, so
 * no test waits on real time.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { USAGE_REFRESH, UsageRefreshGate, usageRefreshFailure } from '../src/client/usage-refresh.js'
import type { UsageRefreshRun } from '../src/client/usage-refresh.js'

/** Feature interval under test (R3), named once for the boundary cases below. */
const INTERVAL_MS = 60_000
/** A realistic epoch-like clock origin, so "0" never doubles as "never forced". */
const ORIGIN_MS = 1_800_000_000_000
/** A user click asks to force; a background poll does not (R1). */
const CLICK = true
const POLL = false

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
  settled: boolean
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const entry: Deferred = {
    promise,
    resolve: () => { entry.settled = true; resolve() },
    reject: (reason) => { entry.settled = true; reject(reason) },
    settled: false,
  }
  return entry
}

/** Let the gate's promise chains (and any queued round start) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}

/** Observe a promise's outcome without awaiting it (also prevents unhandled rejections). */
function track(promise: Promise<void>): { state: 'pending' | 'fulfilled' | 'rejected'; reason?: unknown } {
  const observed: { state: 'pending' | 'fulfilled' | 'rejected'; reason?: unknown } = { state: 'pending' }
  promise.then(() => { observed.state = 'fulfilled' }, (reason: unknown) => { observed.state = 'rejected'; observed.reason = reason })
  return observed
}

/** A gate over a fake clock and a recording `run` whose rounds finish only on demand. */
function harness(start = ORIGIN_MS, minForcedIntervalMs?: number) {
  const clock = { now: start }
  const rounds: { force: boolean; startedAt: number; done: Deferred }[] = []
  const run: UsageRefreshRun = (force) => {
    const done = deferred()
    rounds.push({ force, startedAt: clock.now, done })
    return done.promise
  }
  const gate = minForcedIntervalMs === undefined
    ? new UsageRefreshGate(run, () => clock.now)
    : new UsageRefreshGate(run, () => clock.now, minForcedIntervalMs)
  /** Request and let the gate react. */
  const request = async (wantForce: boolean) => {
    const observed = track(gate.request(wantForce))
    await settle()
    return observed
  }
  /** Finish the oldest unsettled round successfully. */
  const finish = async () => {
    const round = rounds.find(entry => !entry.done.settled)
    assert.ok(round, 'a round is in flight')
    round.done.resolve()
    await settle()
  }
  /** Finish rounds until none is in flight (queued rounds included). */
  const drain = async () => {
    for (let guard = 0; guard < 10 && rounds.some(entry => !entry.done.settled); guard++) await finish()
  }
  /** One complete round started by a request at the current time. */
  const complete = async (wantForce: boolean) => {
    const observed = await request(wantForce)
    await drain()
    assert.equal(observed.state, 'fulfilled')
  }
  const forces = () => rounds.map(entry => entry.force)
  return { clock, rounds, gate, request, finish, drain, complete, forces }
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

test('UC: the first click starts one forced refresh and resolves when that round completes', async () => {
  const h = harness()
  const click = await h.request(CLICK)
  assert.deepEqual(h.forces(), [true])
  assert.equal(click.state, 'pending', 'the click waits for its round')
  await h.finish()
  assert.equal(click.state, 'fulfilled')
})

test('UC: a background poll on an idle gate starts one plain refresh (no force)', async () => {
  const h = harness()
  const poll = await h.request(POLL)
  assert.deepEqual(h.forces(), [false])
  await h.finish()
  assert.equal(poll.state, 'fulfilled')
})

test('UC: a click soon after a forced refresh still re-reads, but plainly (from the just-refreshed cache)', async () => {
  const h = harness()
  await h.complete(CLICK)
  h.clock.now += 5_000
  await h.complete(CLICK)
  assert.deepEqual(h.forces(), [true, false], 'the second click starts a plain round, not nothing')
})

test('UC: the feature constant is 60 000 ms and is the default minimum forced interval', async () => {
  assert.equal(USAGE_REFRESH.MIN_FORCED_INTERVAL_MS, INTERVAL_MS)
  const h = harness() // no explicit interval → the default
  await h.complete(CLICK)
  h.clock.now += INTERVAL_MS - 1
  await h.complete(CLICK)
  h.clock.now += 1
  await h.complete(CLICK)
  assert.deepEqual(h.forces(), [true, false, true])
})

test('UC: the default clock (Date.now) gates a second immediate click to a plain re-read', async () => {
  const forces: boolean[] = []
  const gate = new UsageRefreshGate(async (force) => { forces.push(force) })
  await gate.request(CLICK)
  await gate.request(CLICK)
  assert.deepEqual(forces, [true, false])
})

// ---------------------------------------------------------------------------
// Equivalence partitions: which round a request joins and when it resolves
// ---------------------------------------------------------------------------

test('EP: concurrent clicks during a forced refresh join it — one run call, all resolve together', async () => {
  const h = harness()
  const first = await h.request(CLICK)
  const second = await h.request(CLICK)
  const third = await h.request(CLICK)
  assert.deepEqual(h.forces(), [true], 'no click storm')
  assert.deepEqual([first.state, second.state, third.state], ['pending', 'pending', 'pending'])
  await h.finish()
  assert.deepEqual([first.state, second.state, third.state], ['fulfilled', 'fulfilled', 'fulfilled'])
  await h.drain()
  assert.deepEqual(h.forces(), [true], 'nothing was queued behind the forced round')
})

test('EP: a poll during a forced refresh joins it', async () => {
  const h = harness()
  const click = await h.request(CLICK)
  const poll = await h.request(POLL)
  assert.deepEqual(h.forces(), [true])
  await h.finish()
  assert.deepEqual([click.state, poll.state], ['fulfilled', 'fulfilled'])
  await h.drain()
  assert.deepEqual(h.forces(), [true])
})

test('EP: a poll during a plain refresh joins it', async () => {
  const h = harness()
  const first = await h.request(POLL)
  const second = await h.request(POLL)
  assert.deepEqual(h.forces(), [false])
  await h.finish()
  assert.deepEqual([first.state, second.state], ['fulfilled', 'fulfilled'])
  await h.drain()
  assert.deepEqual(h.forces(), [false])
})

test('EP: an eligible click during a plain refresh queues one forced round that starts only after the plain one finishes', async () => {
  const h = harness()
  const poll = await h.request(POLL)
  const click = await h.request(CLICK)
  assert.deepEqual(h.forces(), [false], 'the forced round waits; it does not run concurrently')
  await h.finish()
  assert.equal(poll.state, 'fulfilled', 'the poll resolves with its own (plain) round')
  assert.deepEqual(h.forces(), [false, true], 'the queued forced round started right after')
  assert.equal(click.state, 'pending', 'the click resolves with the queued forced round, not the plain one')
  await h.finish()
  assert.equal(click.state, 'fulfilled')
})

test('EP: more clicks during a plain refresh still queue only one forced round, and all resolve with it', async () => {
  const h = harness()
  await h.request(POLL)
  const clicks = [await h.request(CLICK), await h.request(CLICK), await h.request(CLICK)]
  await h.finish()
  assert.deepEqual(h.forces(), [false, true])
  assert.deepEqual(clicks.map(c => c.state), ['pending', 'pending', 'pending'])
  const lateClick = await h.request(CLICK) // joins the now-running queued forced round
  await h.finish()
  assert.deepEqual([...clicks, lateClick].map(c => c.state), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
  await h.drain()
  assert.deepEqual(h.forces(), [false, true])
})

test('EP: an ineligible click during a plain refresh joins it and resolves with it (nothing queued)', async () => {
  const h = harness()
  await h.complete(CLICK)
  h.clock.now += 10_000
  const poll = await h.request(POLL)
  const click = await h.request(CLICK)
  assert.deepEqual(h.forces(), [true, false])
  await h.finish()
  assert.deepEqual([poll.state, click.state], ['fulfilled', 'fulfilled'])
  await h.drain()
  assert.deepEqual(h.forces(), [true, false], 'no forced round queued within the interval')
})

test('EP: usageRefreshFailure — every account fulfilled (or none listed) is a success', () => {
  assert.equal(usageRefreshFailure([]), undefined)
  assert.equal(usageRefreshFailure([
    { status: 'fulfilled', value: { usage: {} } },
    { status: 'fulfilled', value: { usage: {} } },
  ]), undefined)
})

test('EP: usageRefreshFailure — an Error rejection yields its message', () => {
  assert.equal(usageRefreshFailure([
    { status: 'fulfilled', value: { usage: {} } },
    { status: 'rejected', reason: new Error('HTTP 429') },
  ]), 'HTTP 429')
})

test('EP: usageRefreshFailure — a non-Error rejection yields String(reason)', () => {
  assert.equal(usageRefreshFailure([{ status: 'rejected', reason: 'offline' }]), 'offline')
  assert.equal(usageRefreshFailure([{ status: 'rejected', reason: 42 }]), '42')
  assert.equal(usageRefreshFailure([{ status: 'rejected', reason: { toString: () => 'custom reason' } }]), 'custom reason')
})

test('EP: usageRefreshFailure — several rejections report the first one in result order', () => {
  assert.equal(usageRefreshFailure([
    { status: 'fulfilled', value: { usage: {} } },
    { status: 'rejected', reason: new Error('first') },
    { status: 'rejected', reason: new Error('second') },
  ]), 'first')
})

// ---------------------------------------------------------------------------
// Boundary values around the 60 000 ms minimum forced interval
// ---------------------------------------------------------------------------

/** Force sequence of: a first click at ORIGIN, then a second click `gapMs` later. */
async function forcesAfterGap(gapMs: number): Promise<boolean[]> {
  const h = harness()
  await h.complete(CLICK)
  h.clock.now = ORIGIN_MS + gapMs
  await h.complete(CLICK)
  return h.forces()
}

test('BVA: a click 59 999 ms after the last forced start re-reads plainly', async () => {
  assert.deepEqual(await forcesAfterGap(INTERVAL_MS - 1), [true, false])
})

test('BVA: a click exactly 60 000 ms after the last forced start forces again', async () => {
  assert.deepEqual(await forcesAfterGap(INTERVAL_MS), [true, true])
})

test('BVA: a click 60 001 ms after the last forced start forces again', async () => {
  assert.deepEqual(await forcesAfterGap(INTERVAL_MS + 1), [true, true])
})

test('BVA: the very first click forces even when the injected clock reads 0', async () => {
  const h = harness(0)
  await h.complete(CLICK)
  assert.deepEqual(h.forces(), [true])
})

test('BVA: the interval is measured from the forced round\'s START, not its completion', async () => {
  const h = harness()
  const click = await h.request(CLICK) // forced round starts at ORIGIN
  h.clock.now = ORIGIN_MS + 30_000 // the provider answers slowly
  await h.finish()
  assert.equal(click.state, 'fulfilled')
  h.clock.now = ORIGIN_MS + INTERVAL_MS - 1
  await h.complete(CLICK)
  h.clock.now = ORIGIN_MS + INTERVAL_MS // only 30 000 ms after completion, 60 000 after start
  await h.complete(CLICK)
  assert.deepEqual(h.forces(), [true, false, true])
})

test('BVA: plain rounds (ineligible clicks and polls) do not reset the interval', async () => {
  const h = harness()
  await h.complete(CLICK) // forced at ORIGIN
  h.clock.now = ORIGIN_MS + 30_000
  await h.complete(CLICK) // plain
  h.clock.now = ORIGIN_MS + 45_000
  await h.complete(POLL) // plain
  h.clock.now = ORIGIN_MS + INTERVAL_MS
  await h.complete(CLICK)
  assert.deepEqual(h.forces(), [true, false, false, true])
})

test('BVA: a queued forced round counts from when it actually starts', async () => {
  const h = harness()
  await h.request(POLL) // plain round at ORIGIN
  h.clock.now = ORIGIN_MS + 100
  await h.request(CLICK) // eligible → queued
  h.clock.now = ORIGIN_MS + 5_000
  await h.finish() // plain done; the queued forced round starts now
  assert.deepEqual(h.rounds.map(r => [r.force, r.startedAt]), [[false, ORIGIN_MS], [true, ORIGIN_MS + 5_000]])
  await h.finish()
  h.clock.now = ORIGIN_MS + 5_000 + INTERVAL_MS - 1
  await h.complete(CLICK)
  h.clock.now = ORIGIN_MS + 5_000 + INTERVAL_MS
  await h.complete(CLICK)
  assert.deepEqual(h.forces(), [false, true, false, true])
})

test('BVA: an explicit minForcedIntervalMs replaces the default (9 → plain, 10 → forced)', async () => {
  const h = harness(ORIGIN_MS, 10)
  await h.complete(CLICK)
  h.clock.now = ORIGIN_MS + 9
  await h.complete(CLICK)
  h.clock.now = ORIGIN_MS + 10
  await h.complete(CLICK)
  assert.deepEqual(h.forces(), [true, false, true])
})

// ---------------------------------------------------------------------------
// Decision table: (gate state × eligibility × request kind) → rounds started
// ---------------------------------------------------------------------------

type Harness = ReturnType<typeof harness>
/** Bring a fresh gate into one state; the returned rounds are already counted. */
const STATES: Record<string, (h: Harness) => Promise<void>> = {
  'idle, eligible': async () => {},
  'idle, ineligible': async (h) => { await h.complete(CLICK); h.clock.now += 1_000 },
  'running forced': async (h) => { await h.request(CLICK) },
  'running plain, eligible': async (h) => { await h.request(POLL) },
  'running plain, ineligible': async (h) => { await h.complete(CLICK); h.clock.now += 1_000; await h.request(POLL) },
  'running plain + queued forced': async (h) => { await h.request(POLL); await h.request(CLICK) },
}

/** [state, request, force flags of every round started from the request on, drained to idle] */
const DECISIONS: [state: keyof typeof STATES, request: 'click' | 'poll', rounds: boolean[]][] = [
  ['idle, eligible', 'click', [true]],
  ['idle, eligible', 'poll', [false]],
  ['idle, ineligible', 'click', [false]],
  ['idle, ineligible', 'poll', [false]],
  ['running forced', 'click', []],
  ['running forced', 'poll', []],
  ['running plain, eligible', 'click', [true]],
  ['running plain, eligible', 'poll', []],
  ['running plain, ineligible', 'click', []],
  ['running plain, ineligible', 'poll', []],
  // The queued forced round starts during the drain either way: the request adds nothing.
  ['running plain + queued forced', 'click', [true]],
  ['running plain + queued forced', 'poll', [true]],
]

test('DT: each (state, request) combination starts exactly the rounds the rules allow', async () => {
  for (const [state, request, expected] of DECISIONS) {
    const h = harness()
    await STATES[state]!(h)
    const before = h.rounds.length
    const observed = await h.request(request === 'click' ? CLICK : POLL)
    await h.drain()
    assert.deepEqual(h.forces().slice(before), expected, `${state} + ${request}`)
    assert.equal(observed.state, 'fulfilled', `${state} + ${request}: the request resolves once its round completes`)
  }
})

// ---------------------------------------------------------------------------
// State transitions: idle → running(plain|forced) → (queued forced) → idle
// ---------------------------------------------------------------------------

test('ST: idle → running(plain) → +queued forced → running(forced) → idle, then a new round can start', async () => {
  const h = harness()
  await h.request(POLL) // idle → running(plain)
  await h.request(CLICK) // running(plain) → running(plain) + queued(forced)
  await h.finish() // → running(forced)
  assert.deepEqual(h.forces(), [false, true])
  await h.finish() // → idle
  await settle()
  assert.equal(h.rounds.length, 2, 'idle: nothing else runs on its own')
  await h.request(POLL) // idle → running(plain) again
  assert.deepEqual(h.forces(), [false, true, false])
  await h.drain()
})

test('ST: idle → running(forced) → idle → running(plain) on an ineligible click', async () => {
  const h = harness()
  await h.request(CLICK)
  assert.deepEqual(h.forces(), [true])
  await h.finish()
  h.clock.now += 1
  await h.request(CLICK)
  assert.deepEqual(h.forces(), [true, false])
  await h.drain()
})

test('ST: a rejected round rejects its own callers only and returns the gate to idle (not wedged)', async () => {
  const h = harness()
  const failure = new Error('round failed')
  const first = await h.request(CLICK)
  const joined = await h.request(POLL)
  h.rounds[0]!.done.reject(failure)
  await settle()
  assert.equal(first.state, 'rejected')
  assert.equal(first.reason, failure)
  assert.equal(joined.state, 'rejected', 'a joiner of the failed round sees the same failure')
  const next = await h.request(POLL)
  assert.equal(h.rounds.length, 2, 'a new round starts after the failure')
  await h.finish()
  assert.equal(next.state, 'fulfilled')
})

test('ST: a rejected plain round still starts the queued forced round, whose callers resolve', async () => {
  const h = harness()
  const poll = await h.request(POLL)
  const click = await h.request(CLICK)
  h.rounds[0]!.done.reject(new Error('plain round failed'))
  await settle()
  assert.equal(poll.state, 'rejected')
  assert.equal(click.state, 'pending', 'the click belongs to the queued round, not the failed one')
  assert.deepEqual(h.forces(), [false, true])
  await h.finish()
  assert.equal(click.state, 'fulfilled')
})

test('ST: a rejected queued forced round rejects its callers and leaves the gate idle', async () => {
  const h = harness()
  const poll = await h.request(POLL)
  const click = await h.request(CLICK)
  await h.finish()
  assert.equal(poll.state, 'fulfilled')
  h.rounds[1]!.done.reject(new Error('forced round failed'))
  await settle()
  assert.equal(click.state, 'rejected')
  h.clock.now += 1_000
  const after = await h.request(CLICK)
  assert.deepEqual(h.forces(), [false, true, false], 'idle again; the interval still counts from the failed forced start')
  await h.finish()
  assert.equal(after.state, 'fulfilled')
})

test('failed-refresh metadata is an error even with fulfilled last-known quota', () => {
  const fallback = { status: 'fulfilled' as const, value: { usage: { refreshFailed: true } } }
  const healthy = { status: 'fulfilled' as const, value: { usage: { refreshFailed: false } } }
  assert.equal(usageRefreshFailure([healthy, fallback]), 'Latest quota unavailable')
  assert.equal(usageRefreshFailure([fallback, healthy]), 'Latest quota unavailable')
  assert.equal(usageRefreshFailure([healthy]), undefined, 'a later successful round clears the warning')
  assert.equal(usageRefreshFailure([{ status: 'fulfilled', value: { usage: {} } }]), undefined, 'old servers may omit metadata')
  assert.equal(usageRefreshFailure([fallback, { status: 'rejected', reason: new Error('transport offline') }]),
    'transport offline', 'prefer an actionable rejection message when available')
})
