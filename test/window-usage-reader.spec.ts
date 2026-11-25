import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UsageService, type UsageStoreView } from '../src/usage/service.js'
import type { PreTrackingStatus } from '../src/usage/pre-tracking.js'
import { createUsageHistoryController, UsageQueryRejected } from '../src/usage/usage-rpc.js'
import { buildUsageView } from '../src/usage/window-view.js'
import type { WindowUsageEntry } from '../src/usage/window-tracker.js'

const started = Date.UTC(2026, 10, 20, 19)
const reset = Date.UTC(2026, 10, 21, 0)
const tokens = (inputTokens: number) => ({
  inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
})
const row = (id: string, change: Partial<WindowUsageEntry> = {}): WindowUsageEntry => ({
  v: 1, id, provider: 'codex', account: 'fixture', kind: '5h',
  status: 'open', startSource: 'nominal', startsAt: started,
  countedFrom: started, resetsAt: reset, models: { 'fixture-model': tokens(5) },
  ...change,
})
const makeView = (entries: WindowUsageEntry[]) => ({
  provider: 'codex' as const, account: 'fixture', observed: [], entries,
  trackingStartedAt: started, preTracking: { state: 'not-computed' as const },
})

test('retry transparently leaves pending after first quota snapshot, without accepting arbitrary kinds or scopes', async () => {
  let entries = [row('pending', { kind: 'pending', window0: 'tracking-start' })]
  const controller = createUsageHistoryController({
    accounts: async () => ['fixture'],
    summary: async () => ({ accounts: 1, earlierHistory: false }),
    read: async query => ({ view: buildUsageView(makeView(entries), query), errors: [] }),
    clear: async () => { throw new Error('not called') },
  }, async () => [{ key: 'fixture' }])
  const payload = { provider: 'codex' as const, account: 'fixture', kind: 'pending' as const }
  assert.equal((await controller.accountUsage(payload)).view.selected?.kind, 'pending')
  entries = [row('classified')]
  const view = (await controller.accountUsage({ ...payload, at: started - 1 })).view
  assert.deepEqual(view.selected, { kind: '5h' })
  assert.deepEqual(view.window?.entryIds, ['classified'])
  await assert.rejects(controller.accountUsage({ ...payload, kind: 'monthly' }), UsageQueryRejected)
  await assert.rejects(controller.accountUsage({ ...payload, kind: '5h', scope: 'not-reported' }), UsageQueryRejected)
  await assert.rejects(controller.accountUsage({ ...payload, scope: 'invalid' }), UsageQueryRejected)
})

test('another process clear marker invalidates previously shown provider totals and local memory rows before purge', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-reader-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store: UsageStoreView = {
    dir, ready: Promise.resolve(), trackingStartedAt: started, tracker: undefined,
    entries: () => [row('old')], unsavedDeltas: () => new Map(), unsavedDayDeltas: () => new Map(),
    clearedAt: () => undefined,
    clearProvider: async () => { throw new Error('used only by the peer') },
  }
  let reads = 0
  const service = new UsageService({
    store,
    preTracking: { status: async () => {
      reads++
      return {
        state: 'stored',
        total: {
          v: 2,
          trackingStartedAt: started,
          days: { '2026-11-20': { history: tokens(13) } },
          models: { history: tokens(13) },
        },
      }
    } },
  })
  t.after(() => service.dispose())
  const query = { provider: 'codex' as const, account: 'fixture' }
  const prior = (await service.read(query)).view
  assert.equal(prior.providerTotal.state, 'stored')
  assert.equal(prior.window?.models['fixture-model']?.inputTokens, 5)
  assert.equal((await service.summary('codex')).earlierHistory, true)
  assert.equal(reads, 1, 'pre-clear provider total was reused')
  const cutoff = started + 200
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    v: 1, trackingStartedAt: started, clearedAt: { codex: cutoff },
  }))
  const view = (await service.read(query)).view
  assert.deepEqual(view.providerTotal, { state: 'cleared' })
  assert.equal(view.clearedAt, cutoff)
  assert.equal(view.window, undefined)
  assert.equal(view.empty, 'cleared')
  assert.deepEqual(await service.accounts('codex'), [])
  assert.deepEqual(await service.summary('codex'), { accounts: 0, earlierHistory: false })
})

test('selected window merges day buckets by model, excluding repeated IDs and overlapping kinds', () => {
  const a = row('first', { days: { '2026-11-20': { 'fixture-model': tokens(5) } } })
  const stale = row('second', { models: { 'fixture-model': tokens(999) }, days: { '2026-11-20': { 'fixture-model': tokens(999) } } })
  const b = row('second', { status: 'closed', models: { 'fixture-model': tokens(3) }, days: { '2026-11-21': { 'fixture-model': tokens(3) } } })
  const weekly = row('parallel', { kind: 'weekly', days: { '2026-11-20': { 'fixture-model': tokens(5) } } })
  const legacy = row('legacy', { models: { 'fixture-model': tokens(2) } })
  const { window } = buildUsageView(makeView([a, stale, b, weekly, legacy]), { kind: '5h' })
  assert.equal(window?.models['fixture-model']?.inputTokens, 10)
  assert.deepEqual(Object.fromEntries(Object.entries(window?.days ?? {})
    .map(([day, models]) => [day, models['fixture-model']?.inputTokens])), {
    '2026-11-20': 5, '2026-11-21': 3,
  })
})

test('accountUsage uses single snapshot load and falls back to default account when a removed account disappears', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-reader-snap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let readdirCalls = 0
  const store: UsageStoreView = {
    dir, ready: Promise.resolve(), trackingStartedAt: started, tracker: undefined,
    entries: () => [row('active', { account: 'logged-in' })],
    unsavedDeltas: () => new Map(), unsavedDayDeltas: () => new Map(),
    clearedAt: () => undefined,
    clearProvider: async () => { throw new Error('unused') },
  }
  const { nodeUsageFileSystem } = await import('../src/usage/usage-files.js')
  const service = new UsageService({
    store,
    fs: {
      ...nodeUsageFileSystem,
      readdir: async path => {
        readdirCalls++
        return nodeUsageFileSystem.readdir(path)
      },
    },
  })
  t.after(() => service.dispose())
  const controller = createUsageHistoryController(service, async () => [{ key: 'logged-in', label: 'in@example.com' }])
  const res = await controller.accountUsage({ provider: 'codex', account: 'removed-after-clear' })
  assert.equal(readdirCalls, 1, 'accountUsage must load provider files only once per request')
  assert.equal(res.account, 'logged-in', 'removed account falls back to default logged-in account')
  assert.equal(res.view.account, 'logged-in')
})

test('a version 1 before-tracking total is re-read, so an upgraded total shows without a restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-reader-legacy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store: UsageStoreView = {
    dir, ready: Promise.resolve(), trackingStartedAt: started, tracker: undefined,
    entries: () => [], unsavedDeltas: () => new Map(), unsavedDayDeltas: () => new Map(),
    clearedAt: () => undefined,
    clearProvider: async () => { throw new Error('not called') },
  }
  let total: PreTrackingStatus = {
    state: 'stored',
    total: { v: 1, trackingStartedAt: started, days: {}, models: { history: tokens(13) } },
  }
  const service = new UsageService({ store, preTracking: { status: async () => total } })
  t.after(() => service.dispose())

  assert.equal((await service.snapshot('codex')).total.state, 'stored')
  total = {
    state: 'stored',
    total: {
      v: 2,
      trackingStartedAt: started,
      days: { '2026-11-20': { history: tokens(13) } },
      models: { history: tokens(13) },
    },
  }
  const upgraded = await service.snapshot('codex')
  assert.equal(upgraded.total.state, 'stored')
  if (upgraded.total.state !== 'stored') return
  assert.equal(upgraded.total.total.v, 2)
  assert.deepEqual(upgraded.total.total.days, { '2026-11-20': { history: tokens(13) } })
})
