import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { nodeUsageFileSystem, parseClosed, WindowStore, type UsageFileSystem } from '../src/usage/window-store.js'
import { parseOpenFile } from '../src/usage/usage-schema.js'
import type { WindowUsageEntry } from '../src/usage/window-tracker.js'

const t0 = Date.UTC(2026, 0, 1, 22)
const hour = 3_600_000
const model = 'gpt-test'
const account = 'fixture-account'
const provider = 'codex'

function observe(store: WindowStore, at: number, resetsAt: number): void {
  store.observe(provider, account, { supported: true, windows: [{ kind: 'session', durationMs: 5 * hour, usedPercent: 10, resetsAt }] }, at)
}

function record(store: WindowStore, at: number, inputTokens: number): void {
  store.recordRequest({ provider, account, model, finishedAt: at, chunk: { type: 'usage', usage: { inputTokens, outputTokens: 0 } } })
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-persistence-'))
  const stores: WindowStore[] = []
  const openPath = join(dir, provider, 'open.json')
  const closedPath = join(dir, provider, 'closed-2026.jsonl')
  let now = t0
  t.after(async () => {
    try {
      for (const store of stores.reverse()) await store.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  async function open(fs?: UsageFileSystem): Promise<WindowStore> {
    const store = new WindowStore({ dir, now: () => now, saveDelayMs: 2 ** 30, advanceIntervalMs: 2 ** 30, ...fs === undefined ? {} : { fs } })
    stores.push(store)
    await store.ready
    assert.ok(store.tracker, 'tracking is ready')
    return store
  }
  async function openFile() {
    const parsed = parseOpenFile(provider, JSON.parse(await readFile(openPath, 'utf8')))
    assert.ok(parsed)
    assert.equal(parsed.dropped, 0, 'usage file validates without dropping entries')
    return parsed.file
  }
  async function closed(): Promise<WindowUsageEntry[]> {
    const lines = parseClosed(provider, await readFile(closedPath, 'utf8'))
    return lines.map(line => {
      assert.ok(line.entry)
      return line.entry
    })
  }
  return { open, openFile, closed, openPath, setNow: (at: number) => { now = at } }
}

for (const bCloses of [false, true]) {
  test(`closed window wins over a stale open copy when second process ${bCloses ? 'closes it' : 'still considers it open'}`, async t => {
    const f = await fixture(t)
    const reset = t0 + 5 * hour
    const seed = await f.open()
    observe(seed, t0, reset)
    record(seed, t0 + 1, 100)
    await seed.dispose()
    const id = (await f.openFile()).entries[0]?.id
    assert.ok(id)
    let fail = false
    const fs: UsageFileSystem = {
      ...nodeUsageFileSystem,
      rename: async (from, to) => {
        if (fail && to === f.openPath) throw Object.assign(new Error('injected open rewrite failure'), { code: 'ENOSPC' })
        await nodeUsageFileSystem.rename(from, to)
      },
    }
    const a = await f.open(fs)
    const b = await f.open()
    record(a, t0 + 2, 10)
    observe(a, reset, reset + 5 * hour)
    fail = true
    await a.flush()
    assert.equal((await f.openFile()).entries.find(entry => entry.id === id)?.models[model]?.inputTokens, 100)
    assert.equal((await f.closed()).find(entry => entry.id === id)?.models[model]?.inputTokens, 110)

    record(b, t0 + 3 * hour, 20)
    if (bCloses) observe(b, reset, reset + 5 * hour)
    await b.flush()
    fail = false
    await a.flush()
    await b.flush()
    f.setNow(reset)
    const restarted = await f.open()
    await restarted.settled()
    const persisted = (await f.closed()).filter(entry => entry.id === id)
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0]?.models[model]?.inputTokens, 130)
    assert.equal(persisted[0]?.days?.['2026-01-01']?.[model]?.inputTokens, 110)
    assert.equal(persisted[0]?.days?.['2026-01-02']?.[model]?.inputTokens, 20)
    assert.ok(!(await f.openFile()).entries.some(entry => entry.id === id))
    assert.ok(!restarted.entries(provider).some(entry => entry.id === id))
  })
}

for (const bSavesBeforePromotion of [true, false]) {
  test(`concurrent held deltas survive staggered promotion (B ${bSavesBeforePromotion ? 'already saved' : 'still dirty'})`, async t => {
    const f = await fixture(t)
    const reset = t0 + 5 * hour
    const gap = reset + 5 * hour
    const seed = await f.open()
    observe(seed, t0, reset)
    record(seed, gap + 1, 50)
    await seed.dispose()
    assert.equal((await f.openFile()).accounts[0]?.series[0]?.held?.models[model]?.inputTokens, 50)

    f.setNow(gap + 1)
    const a = await f.open()
    const b = await f.open()
    record(a, gap + 2, 100)
    record(b, gap + 3, 200)
    await a.flush()
    if (bSavesBeforePromotion) await b.flush()
    const held = (await f.openFile()).accounts[0]?.series[0]?.held
    assert.equal(held?.models[model]?.inputTokens, bSavesBeforePromotion ? 350 : 150)
    assert.equal(held?.days?.['2026-01-02']?.[model]?.inputTokens, bSavesBeforePromotion ? 350 : 150)

    observe(a, gap + hour, gap + 5 * hour)
    await a.flush()
    // B has not observed the new window yet. Flushing again must not put the
    // held allocation back in accounts, nor lose counts written after A moved it.
    record(b, gap + 5, 10)
    await b.flush()
    assert.equal((await f.openFile()).accounts[0]?.series[0]?.held, undefined)
    assert.equal((await f.openFile()).entries.reduce((sum, entry) => sum + (entry.models[model]?.inputTokens ?? 0), 0), 360)
    observe(b, gap + hour + 1, gap + 5 * hour)
    await b.flush()
    await a.flush()

    f.setNow(gap + hour + 1)
    const restarted = await f.open()
    const file = await f.openFile()
    const total = file.entries.reduce((sum, entry) => sum + (entry.models[model]?.inputTokens ?? 0), 0)
    assert.equal(total, 360)
    assert.equal(file.entries.reduce((sum, entry) => sum + (entry.days?.['2026-01-02']?.[model]?.inputTokens ?? 0), 0), 360)
    assert.equal(file.accounts[0]?.series[0]?.held, undefined)
    assert.ok(restarted.tracker)
  })
}

test('pending counts are allocated by actual UTC request day when sorted into a reported window', async t => {
  const f = await fixture(t)
  const store = await f.open()
  // Deliberately arrive out of order; the monotonic tracker clock advances
  // windows, but daily attribution comes from each request timestamp.
  record(store, t0 + 3 * hour, 20)
  record(store, t0 + 1, 10)
  observe(store, t0 + 3 * hour + 1, t0 + 5 * hour)
  await store.flush()
  const entries = [...(await f.openFile()).entries, ...await f.closed()]
  const allocated = entries.find(entry => entry.window0 && entry.kind === '5h')
  assert.equal(allocated?.models[model]?.inputTokens, 30)
  assert.equal(allocated?.days?.['2026-01-01']?.[model]?.inputTokens, 10)
  assert.equal(allocated?.days?.['2026-01-02']?.[model]?.inputTokens, 20)
  if (process.platform !== 'win32') assert.equal((await stat(f.openPath)).mode & 0o777, 0o600)
})

test('unflushed peer merges late delta into closed file for independently derived deterministic window id (Major #1)', async t => {
  const f = await fixture(t)
  const reset = t0 + 5 * hour
  // Both processes start cold before any open.json exists, so neither has a
  // baseline for the entry, and both derive the exact same deterministic id
  // (startSource: 'length', startsAt === t0, countedFrom === t0).
  const a = await f.open()
  const b = await f.open()
  observe(a, t0, reset)
  record(a, t0 + 10, 100)
  observe(b, t0, reset)
  record(b, t0 + 20, 40)

  // Process A closes the window into closed-2026.jsonl and removes it from open.json
  // BEFORE process B has ever flushed that entry.
  f.setNow(reset)
  observe(a, reset, reset + 5 * hour)
  await a.flush()
  const closedBefore = await f.closed()
  assert.equal(closedBefore.length, 1)
  const id = closedBefore[0]!.id
  assert.equal(closedBefore[0]!.startSource, 'length')
  assert.equal(closedBefore[0]!.models[model]?.inputTokens, 100)
  assert.ok(!(await f.openFile()).entries.some(entry => entry.id === id))

  // Process B's clock has not advanced yet, so B still considers `id` open and
  // has never saved it (baseline.has(id) === false). Flushing B must merge its
  // 40 tokens into the closed line rather than writing a stale open copy back.
  f.setNow(t0 + 30)
  await b.flush()

  const closedAfter = (await f.closed()).filter(entry => entry.id === id)
  assert.equal(closedAfter.length, 1)
  assert.equal(closedAfter[0]!.models[model]?.inputTokens, 140)
  assert.ok(!(await f.openFile()).entries.some(entry => entry.id === id), 'must not re-write closed id into open.json')
})

test('held promotion closing before flush does not corrupt successor window with negative counts (Major #2)', async t => {
  const f = await fixture(t)
  const reset = t0 + 5 * hour
  const gap = reset + 5 * hour
  const seed = await f.open()
  observe(seed, t0, reset)
  record(seed, gap + 1, 50)
  await seed.dispose()
  assert.equal((await f.openFile()).accounts[0]?.series[0]?.held?.models[model]?.inputTokens, 50)

  // Both A and B load the same held sum (50).
  f.setNow(gap + 1)
  const a = await f.open()
  const b = await f.open()

  // Process A promotes held into e1 and flushes (clearing disk.held).
  const e1Reset = gap + 5 * hour
  observe(a, gap + hour, e1Reset)
  await a.flush()
  assert.equal((await f.openFile()).accounts[0]?.series[0]?.held, undefined)

  // Process B also promotes held into e1, records +15 on e1, and BEFORE B flushes
  // the clock advances past e1Reset so e1 closes into `closing` and e2 opens empty.
  observe(b, gap + hour, e1Reset)
  record(b, gap + 2 * hour, 15)
  f.setNow(e1Reset + 10)
  observe(b, e1Reset + 10, e1Reset + 5 * hour)
  record(b, e1Reset + 20, 7)
  await b.flush()

  // e2 in open.json must remain valid with its +7 tokens (never negative or dropped),
  // and e1 in closed-2026.jsonl must contain 50 + 15 = 65 (not 115, not lost).
  const openAfter = await f.openFile()
  assert.equal(openAfter.accounts[0]?.series[0]?.held, undefined)
  const e2 = openAfter.entries.find(entry => entry.resetsAt === e1Reset + 5 * hour)
  assert.ok(e2, 'successor window e2 survived flush without negative counts')
  assert.equal(e2.models[model]?.inputTokens, 7)

  const closedAfter = await f.closed()
  const e1Total = closedAfter
    .filter(entry => entry.resetsAt === e1Reset)
    .reduce((sum, entry) => sum + (entry.models[model]?.inputTokens ?? 0), 0)
  assert.equal(e1Total, 65)
})

test('consecutive clearProvider calls within the same millisecond remain monotonic (Minor #3)', async t => {
  const f = await fixture(t)
  const store = await f.open()
  observe(store, t0, t0 + 5 * hour)
  record(store, t0 + 1, 25)
  await store.flush()

  await store.clearProvider(provider)
  const firstClear = store.clearedAt(provider)
  assert.equal(firstClear, t0)

  // Clock has not advanced (same millisecond). Second clear must still advance clearedAt.
  await store.clearProvider(provider)
  const secondClear = store.clearedAt(provider)
  assert.ok(secondClear !== undefined && secondClear > firstClear!)
})

test('quotaUsedPercent and quotaPeakPercent persist across open/closed files and reconcile across peers', async t => {
  const f = await fixture(t)
  const reset = t0 + 5 * hour
  const a = await f.open()
  const b = await f.open()

  // Process A observes 42% at t0, then 68% at t0 + 1h, then 55% at t0 + 2h (peak stays 68%, latest 55%).
  a.observe(provider, account, { supported: true, windows: [{ kind: 'session', durationMs: 5 * hour, usedPercent: 42, resetsAt: reset }] }, t0)
  a.observe(provider, account, { supported: true, windows: [{ kind: 'session', durationMs: 5 * hour, usedPercent: 68, resetsAt: reset }] }, t0 + hour)
  a.observe(provider, account, { supported: true, windows: [{ kind: 'session', durationMs: 5 * hour, usedPercent: 55, resetsAt: reset }] }, t0 + 2 * hour)
  record(a, t0 + 10, 100)
  await a.flush()

  // Process B observes an even fresher 74% at t0 + 3h (higher peak AND fresher latest).
  b.observe(provider, account, { supported: true, windows: [{ kind: 'session', durationMs: 5 * hour, usedPercent: 74, resetsAt: reset }] }, t0 + 3 * hour)
  record(b, t0 + 20, 50)
  await b.flush()

  const openAfter = await f.openFile()
  assert.equal(openAfter.entries[0]?.quotaUsedPercent, 74)
  assert.equal(openAfter.entries[0]?.quotaPeakPercent, 74)

  // Process A later observes 60% at t0 + 4h (fresher than B's 3h, lower than B's 74% peak).
  // Reconciling must keep latest = 60% (from t0 + 4h) and peak = 74% (Math.max).
  a.observe(provider, account, { supported: true, windows: [{ kind: 'session', durationMs: 5 * hour, usedPercent: 60, resetsAt: reset }] }, t0 + 4 * hour)
  await a.flush()
  const openReconciled = await f.openFile()
  assert.equal(openReconciled.entries[0]?.quotaUsedPercent, 60)
  assert.equal(openReconciled.entries[0]?.quotaPeakPercent, 74)

  // Advance past reset so the window closes into closed-2026.jsonl preserving both percentages.
  f.setNow(reset)
  a.observe(provider, account, { supported: true, windows: [{ kind: 'session', durationMs: 5 * hour, usedPercent: 5, resetsAt: reset + 5 * hour }] }, reset)
  await a.flush()

  const closedAfter = await f.closed()
  assert.equal(closedAfter.length, 1)
  assert.equal(closedAfter[0]?.quotaUsedPercent, 60)
  assert.equal(closedAfter[0]?.quotaPeakPercent, 74)

  // New open cycle starts fresh with 5%, not inheriting the previous cycle's 74% peak.
  const nextOpen = await f.openFile()
  assert.equal(nextOpen.entries[0]?.quotaUsedPercent, 5)
  assert.equal(nextOpen.entries[0]?.quotaPeakPercent, 5)
})

test('sanitizeEntry remains backwards-compatible without quota % and rejects out-of-range percentages', async () => {
  const { sanitizeEntry } = await import('../src/usage/usage-schema.js')
  const base = {
    v: 1,
    id: 'legacy-1',
    provider: 'codex',
    account: 'acct',
    kind: '5h',
    startSource: 'nominal',
    status: 'closed',
    countedFrom: t0,
    models: { 'gpt-5.4': { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
  }
  const legacy = sanitizeEntry('codex', base)
  assert.ok(legacy)
  assert.equal(legacy.quotaUsedPercent, undefined)
  assert.equal(legacy.quotaPeakPercent, undefined)

  const valid = sanitizeEntry('codex', { ...base, quotaUsedPercent: 48.5, quotaPeakPercent: 91, quotaObservedAt: t0 + 1000 })
  assert.ok(valid)
  assert.equal(valid.quotaUsedPercent, 48.5)
  assert.equal(valid.quotaPeakPercent, 91)

  assert.equal(sanitizeEntry('codex', { ...base, quotaUsedPercent: -1 }), undefined)
  assert.equal(sanitizeEntry('codex', { ...base, quotaPeakPercent: 101 }), undefined)
  assert.equal(sanitizeEntry('codex', { ...base, quotaUsedPercent: Number.NaN }), undefined)
})
