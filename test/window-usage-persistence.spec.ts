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
