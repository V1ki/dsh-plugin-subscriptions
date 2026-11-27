import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { registerAuthRpc } from '../src/auth/rpc.js'
import { UsageService, summarizeStored } from '../src/usage/service.js'
import { buildUsageDashboard } from '../src/usage/usage-dashboard.js'
import { createUsageHistoryController } from '../src/usage/usage-rpc.js'
import { WindowStore } from '../src/usage/window-store.js'
import type { TokenCounts, WindowUsageEntry } from '../src/usage/window-tracker.js'
import { createFakeConnection } from './fake-connection.js'

const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0) // 2026-11-23T12:00:00Z
const START = Date.UTC(2026, 4, 1, 0, 0, 0) // 2026-05-01T00:00:00Z

function counts(
  inputTokens: number,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  reasoningTokens = 0,
): TokenCounts {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }
}

function makeEntry(overrides: Partial<WindowUsageEntry> & Pick<WindowUsageEntry, 'id' | 'provider' | 'account' | 'kind'>): WindowUsageEntry {
  return {
    v: 1,
    startSource: 'nominal',
    status: 'open',
    countedFrom: NOW - 2 * HOUR_MS,
    models: {},
    ...overrides,
  }
}

test('buildUsageDashboard deduplicates overlapping 5h, weekly, and scoped windows without double-counting', () => {
  // Codex acct-1 made 2 requests on 2026-11-22 across two consecutive 5h windows
  // AND inside one overlapping weekly window.
  const day = '2026-11-22'
  const codexEntries: WindowUsageEntry[] = [
    makeEntry({
      id: 'codex-5h-1',
      provider: 'codex',
      account: 'acct-1',
      kind: '5h',
      status: 'closed',
      countedFrom: Date.UTC(2026, 10, 22, 1),
      endedAt: Date.UTC(2026, 10, 22, 6),
      models: { 'gpt-5.4': counts(600, 200, 100, 0, 50) },
      days: { [day]: { 'gpt-5.4': counts(600, 200, 100, 0, 50) } },
    }),
    makeEntry({
      id: 'codex-5h-2',
      provider: 'codex',
      account: 'acct-1',
      kind: '5h',
      status: 'open',
      countedFrom: Date.UTC(2026, 10, 22, 6),
      resetsAt: NOW + 2 * HOUR_MS,
      models: { 'gpt-5.4': counts(400, 100, 50, 0, 25) },
      days: { [day]: { 'gpt-5.4': counts(400, 100, 50, 0, 25) } },
    }),
    // Overlapping weekly window saw the exact same 1000 input + 300 output + 150 cacheRead (75 reasoning).
    makeEntry({
      id: 'codex-weekly-1',
      provider: 'codex',
      account: 'acct-1',
      kind: 'weekly',
      status: 'open',
      countedFrom: Date.UTC(2026, 10, 18, 0),
      resetsAt: Date.UTC(2026, 10, 25, 0),
      models: { 'gpt-5.4': counts(1000, 300, 150, 0, 75) },
      days: { [day]: { 'gpt-5.4': counts(1000, 300, 150, 0, 75) } },
    }),
    // Second Codex account on the same day must be ADDED (never merged with acct-1).
    makeEntry({
      id: 'codex-acct2-5h',
      provider: 'codex',
      account: 'acct-2',
      kind: '5h',
      status: 'open',
      countedFrom: Date.UTC(2026, 10, 22, 8),
      resetsAt: NOW + 3 * HOUR_MS,
      models: { 'gpt-5.4': counts(500, 100, 0, 0, 0) },
      days: { [day]: { 'gpt-5.4': counts(500, 100, 0, 0, 0) } },
    }),
  ]

  // Claude acct-c1 has 5h + weekly + weekly (scope: opus) overlapping for Opus,
  // plus 5h + weekly overlapping for Sonnet.
  const claudeEntries: WindowUsageEntry[] = [
    makeEntry({
      id: 'claude-5h',
      provider: 'claude',
      account: 'acct-c1',
      kind: '5h',
      status: 'open',
      resetsAt: NOW + HOUR_MS,
      models: {
        'claude-opus-4-6': counts(200, 100, 50, 25, 40),
        'claude-sonnet-4-6': counts(300, 100, 0, 0, 0),
      },
      days: {
        [day]: {
          'claude-opus-4-6': counts(200, 100, 50, 25, 40),
          'claude-sonnet-4-6': counts(300, 100, 0, 0, 0),
        },
      },
    }),
    makeEntry({
      id: 'claude-weekly',
      provider: 'claude',
      account: 'acct-c1',
      kind: 'weekly',
      status: 'open',
      resetsAt: NOW + 3 * DAY_MS,
      models: {
        'claude-opus-4-6': counts(200, 100, 50, 25, 40),
        'claude-sonnet-4-6': counts(300, 100, 0, 0, 0),
      },
      days: {
        [day]: {
          'claude-opus-4-6': counts(200, 100, 50, 25, 40),
          'claude-sonnet-4-6': counts(300, 100, 0, 0, 0),
        },
      },
    }),
    makeEntry({
      id: 'claude-weekly-opus',
      provider: 'claude',
      account: 'acct-c1',
      kind: 'weekly',
      scope: 'opus',
      status: 'open',
      resetsAt: NOW + 3 * DAY_MS,
      models: { 'claude-opus-4-6': counts(200, 100, 50, 25, 40) },
      days: { [day]: { 'claude-opus-4-6': counts(200, 100, 50, 25, 40) } },
    }),
  ]

  // Antigravity uses disjoint model-family scopes — both must contribute without loss.
  const agEntries: WindowUsageEntry[] = [
    makeEntry({
      id: 'ag-gemini',
      provider: 'antigravity',
      account: 'acct-ag',
      kind: 'weekly',
      scope: 'gemini-pro',
      status: 'open',
      resetsAt: NOW + 2 * DAY_MS,
      models: { 'gemini-2.5-pro': counts(700, 300, 0, 0, 100) },
      days: { [day]: { 'gemini-2.5-pro': counts(700, 300, 0, 0, 100) } },
    }),
    makeEntry({
      id: 'ag-claude',
      provider: 'antigravity',
      account: 'acct-ag',
      kind: 'weekly',
      scope: 'claude',
      status: 'open',
      resetsAt: NOW + 2 * DAY_MS,
      models: { 'claude-sonnet-4-6': counts(250, 50, 0, 0, 0) },
      days: { [day]: { 'claude-sonnet-4-6': counts(250, 50, 0, 0, 0) } },
    }),
  ]

  const res = buildUsageDashboard({
    now: NOW,
    trackingStartedAt: START,
    providers: [
      { provider: 'codex', entries: codexEntries, loggedIn: [{ key: 'acct-1', label: 'a1@test.dev' }], observed: () => [], preTracking: { state: 'unavailable' }, errors: [] },
      { provider: 'claude', entries: claudeEntries, loggedIn: [{ key: 'acct-c1', label: 'c1@test.dev' }], observed: () => [], preTracking: { state: 'unavailable' }, errors: [] },
      { provider: 'grok', entries: [], loggedIn: [], observed: () => [], preTracking: { state: 'unavailable' }, errors: [] },
      { provider: 'antigravity', entries: agEntries, loggedIn: [{ key: 'acct-ag', label: 'ag@test.dev' }], observed: () => [], preTracking: { state: 'unavailable' }, errors: [] },
    ],
  }, { range: '7d' })

  // Expected deduplicated totals:
  // Codex: acct-1 (1000+300+150=1450, reasoning 75) + acct-2 (500+100=600) = 2050
  // Claude: opus (200+100+50+25=375, reasoning 40) + sonnet (300+100=400) = 775
  // Antigravity: gemini (700+300=1000, reasoning 100) + sonnet (250+50=300) = 1300
  // Grand total = 2050 + 775 + 1300 = 4125 (reasoning = 215, NOT added to totalTokens!)
  assert.equal(res.summary.totalTokens, 4125)
  assert.equal(res.summary.inputTokens, 1000 + 500 + 200 + 300 + 700 + 250)
  assert.equal(res.summary.outputTokens, 300 + 100 + 100 + 100 + 300 + 50)
  assert.equal(res.summary.cacheReadTokens, 150 + 50)
  assert.equal(res.summary.cacheWriteTokens, 25)
  assert.equal(res.summary.reasoningTokens, 75 + 40 + 100)
  assert.equal(res.summary.activeModels, 5)
  assert.equal(res.summary.activeDays, 1)
  assert.equal(res.summary.activeAccounts, 4)

  // Daily bucket for 2026-11-22 matches summary exactly.
  assert.equal(res.daily.length, 7)
  const bucket = res.daily.find(d => d.date === day)
  assert.ok(bucket)
  assert.equal(bucket.totalTokens, 4125)
  assert.deepEqual(bucket.byProvider, { codex: 2050, claude: 775, antigravity: 1300 })

  // Models sorted descending by totalTokens; shares sum to 1.
  assert.equal(res.models[0]?.model, 'gpt-5.4')
  assert.equal(res.models[0]?.totalTokens, 2050)
  assert.ok(Math.abs(res.models.reduce((s, m) => s + m.share, 0) - 1) < 1e-9)

  // Provider breakdown sorted descending.
  assert.deepEqual(res.providerBreakdown.map(p => [p.provider, p.totalTokens]), [
    ['codex', 2050],
    ['antigravity', 1300],
    ['claude', 775],
  ])

  // Logged-out historical account (acct-2) appears in providers list with loggedIn: false.
  const codexInfo = res.providers.find(p => p.provider === 'codex')
  assert.deepEqual(codexInfo?.accounts.map(a => ({ key: a.key, loggedIn: a.loggedIn, totalTokens: a.totalTokens })), [
    { key: 'acct-1', loggedIn: true, totalTokens: 1450 },
    { key: 'acct-2', loggedIn: false, totalTokens: 600 },
  ])

  // Active windows include live open 5h + weekly + scoped windows across matched accounts.
  assert.ok(res.activeWindows.some(w => w.provider === 'codex' && w.account === 'acct-1' && w.kind === '5h'))
  assert.ok(res.activeWindows.some(w => w.provider === 'codex' && w.account === 'acct-1' && w.kind === 'weekly'))
  assert.ok(res.activeWindows.some(w => w.provider === 'claude' && w.kind === 'weekly' && w.scope === 'opus'))
})

test('range filtering (7d/30d/90d/all), 182-day heatmap, and provider/account filtering work cleanly', () => {
  const entries: WindowUsageEntry[] = [
    makeEntry({
      id: 'old-120d',
      provider: 'codex',
      account: 'acct-1',
      kind: 'weekly',
      status: 'closed',
      countedFrom: NOW - 120 * DAY_MS,
      endedAt: NOW - 113 * DAY_MS,
      models: { 'gpt-5.4': counts(1000) },
      days: { '2026-07-26': { 'gpt-5.4': counts(1000) } },
    }),
    makeEntry({
      id: 'mid-20d',
      provider: 'codex',
      account: 'acct-1',
      kind: 'weekly',
      status: 'closed',
      countedFrom: NOW - 20 * DAY_MS,
      endedAt: NOW - 13 * DAY_MS,
      models: { 'gpt-5.4': counts(500) },
      days: { '2026-11-03': { 'gpt-5.4': counts(500) } },
    }),
    makeEntry({
      id: 'recent-2d',
      provider: 'codex',
      account: 'acct-2',
      kind: '5h',
      status: 'open',
      countedFrom: NOW - 2 * DAY_MS,
      resetsAt: NOW + HOUR_MS,
      models: { 'gpt-5.4-mini': counts(200) },
      days: { '2026-11-21': { 'gpt-5.4-mini': counts(200) } },
    }),
  ]

  const input = {
    now: NOW,
    trackingStartedAt: START,
    providers: [
      { provider: 'codex' as const, entries, loggedIn: [{ key: 'acct-1' }, { key: 'acct-2' }], observed: () => [], preTracking: { state: 'unavailable' as const }, errors: [] },
    ],
  }

  const r7 = buildUsageDashboard(input, { range: '7d' })
  assert.equal(r7.daily.length, 7)
  assert.equal(r7.summary.totalTokens, 200)
  // Heatmap always spans 182 days regardless of 7d range!
  assert.equal(r7.heatmap.length, 182)
  assert.equal(r7.heatmap.find(d => d.date === '2026-07-26')?.totalTokens, 1000)
  assert.equal(r7.heatmap.find(d => d.date === '2026-11-03')?.totalTokens, 500)
  assert.equal(r7.heatmap.find(d => d.date === '2026-11-21')?.totalTokens, 200)

  const r30 = buildUsageDashboard(input, { range: '30d' })
  assert.equal(r30.daily.length, 30)
  assert.equal(r30.summary.totalTokens, 700)

  const r90 = buildUsageDashboard(input, { range: '90d' })
  assert.equal(r90.daily.length, 90)
  assert.equal(r90.summary.totalTokens, 700)

  const rAll = buildUsageDashboard(input, { range: 'all' })
  assert.equal(rAll.summary.totalTokens, 1700)
  assert.equal(rAll.daily[0]?.date, '2026-07-26')
  assert.equal(rAll.daily[rAll.daily.length - 1]?.date, '2026-11-23')

  // Account filtering narrows summary, daily, heatmap, and activeWindows.
  const acct1Only = buildUsageDashboard(input, { provider: 'codex', account: 'acct-1', range: 'all' })
  assert.equal(acct1Only.filters.account, 'acct-1')
  assert.equal(acct1Only.summary.totalTokens, 1500)
  assert.equal(acct1Only.heatmap.find(d => d.date === '2026-11-21')?.totalTokens, 0)

  // Stale/missing account falls back cleanly to 'all'.
  const staleAcct = buildUsageDashboard(input, { provider: 'codex', account: 'deleted-acct', range: 'all' })
  assert.equal(staleAcct.filters.account, 'all')
  assert.equal(staleAcct.summary.totalTokens, 1700)
})

test('end-to-end UsageService + UsageHistoryController + RPC usageDashboard & clearUsageHistory(all)', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-dashboard-rpc-'))
  let clock = NOW - DAY_MS
  const store = new WindowStore({ dir, now: () => clock, saveDelayMs: 2 ** 30, advanceIntervalMs: 2 ** 30 })
  const service = new UsageService({ store })
  t.after(async () => {
    service.dispose()
    await store.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await store.ready

  // Record overlapping 5h + weekly windows on Codex and Claude through real WindowStore.
  store.observe('codex', 'acct-a', {
    supported: true,
    windows: [
      { kind: 'session', durationMs: 5 * HOUR_MS, usedPercent: 20, resetsAt: clock + 5 * HOUR_MS },
      { kind: 'weekly', durationMs: 7 * DAY_MS, usedPercent: 10, resetsAt: clock + 7 * DAY_MS },
    ],
  }, clock)
  store.recordRequest({
    provider: 'codex',
    account: 'acct-a',
    model: 'gpt-5.4',
    finishedAt: clock + 1000,
    chunk: { type: 'usage', usage: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 100, reasoningTokens: 50 } },
  })
  store.observe('claude', 'acct-b', {
    supported: true,
    windows: [
      { kind: 'session', durationMs: 5 * HOUR_MS, usedPercent: 15, resetsAt: clock + 5 * HOUR_MS },
      { kind: 'weekly', durationMs: 7 * DAY_MS, usedPercent: 5, resetsAt: clock + 7 * DAY_MS },
    ],
  }, clock)
  store.recordRequest({
    provider: 'claude',
    account: 'acct-b',
    model: 'claude-sonnet-4-6',
    finishedAt: clock + 2000,
    chunk: { type: 'usage', usage: { inputTokens: 400, outputTokens: 100 } },
  })
  await store.flush()

  clock = NOW
  const controller = createUsageHistoryController(
    service,
    async provider => provider === 'codex' ? [{ key: 'acct-a', label: 'a@example.com' }] : [],
    () => clock,
  )

  // Wire through real registerAuthRpc + fake connection.
  const ctx = new Context()
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  registerAuthRpc(
    ctx,
    {
      status: async () => ({ busy: false, accounts: [] }),
      login: async () => ({ authorizeUrl: 'https://example.invalid' }),
      saveKey: async () => {},
      manual: async () => {},
      cancel: async () => {},
      logout: async () => {},
      setDefault: async () => {},
      usage: async () => ({ supported: false }),
      readImage: async () => { throw new Error('unused') },
      readVideo: async () => { throw new Error('unused') },
    },
    { speed: async () => ({ tier: 'standard', fastModels: [] }), setSpeed: async () => {} },
    undefined,
    undefined,
    undefined,
    controller,
  )
  await new Promise(resolve => setTimeout(resolve, 20))
  const signal = new AbortController().signal

  // Validation errors on usageDashboard.
  const badRange = await fake.handler('usageDashboard', { range: '365d' }, signal)
  assert.equal(badRange.ok, false)
  if (!badRange.ok) assert.equal(badRange.error.code, 'bad-request')

  const badCopilot = await fake.handler('usageDashboard', { provider: 'copilot' }, signal)
  assert.equal(badCopilot.ok, false)
  if (!badCopilot.ok) assert.equal(badCopilot.error.code, 'unsupported')

  // Valid dashboard call: Codex 1100 (NOT 2200!) + Claude 500 (NOT 1000!) = 1600.
  const okDash = await fake.handler('usageDashboard', {}, signal)
  assert.equal(okDash.ok, true)
  if (!okDash.ok) return
  const dash = okDash.value as Awaited<ReturnType<typeof controller.usageDashboard>>
  assert.equal(dash.summary.totalTokens, 1600)
  assert.equal(dash.summary.reasoningTokens, 50)
  assert.equal(dash.clearInfo.codex.accounts, 1)
  assert.equal(dash.clearInfo.claude.accounts, 1)
  assert.equal(dash.cleared, false)
  // Quota utilization % from store.observe(...) flows into quotaCycles & activeWindows.
  const codexWeeklyCycle = dash.quotaCycles.find(c => c.provider === 'codex' && c.kind === 'weekly')
  assert.ok(codexWeeklyCycle)
  assert.equal(codexWeeklyCycle.isCurrent, true)
  assert.equal(codexWeeklyCycle.quotaUsedPercent, 10)
  assert.equal(codexWeeklyCycle.quotaPeakPercent, 10)
  assert.equal(codexWeeklyCycle.models[0]?.share, 1)

  const codex5hCycle = dash.quotaCycles.find(c => c.provider === 'codex' && c.kind === '5h')
  assert.ok(codex5hCycle)
  assert.equal(codex5hCycle.quotaUsedPercent, 20)
  assert.equal(codex5hCycle.quotaPeakPercent, 20)

  // Clear single provider (codex).
  const clearCodex = await fake.handler('clearUsageHistory', { provider: 'codex', confirm: true }, signal)
  assert.equal(clearCodex.ok, true)

  const afterCodexClear = await fake.handler('usageDashboard', { provider: 'codex' }, signal)
  assert.equal(afterCodexClear.ok, true)
  if (afterCodexClear.ok) {
    const codexDash = afterCodexClear.value as Awaited<ReturnType<typeof controller.usageDashboard>>
    assert.equal(codexDash.summary.totalTokens, 0)
    assert.equal(codexDash.cleared, true)
  }

  // Clear all providers via provider: 'all'.
  const clearAll = await fake.handler('clearUsageHistory', { provider: 'all', confirm: true }, signal)
  assert.equal(clearAll.ok, true)

  const afterAllClear = await fake.handler('usageDashboard', {}, signal)
  assert.equal(afterAllClear.ok, true)
  if (afterAllClear.ok) {
    const allDash = afterAllClear.value as Awaited<ReturnType<typeof controller.usageDashboard>>
    assert.equal(allDash.summary.totalTokens, 0)
    assert.equal(allDash.cleared, true)
    assert.equal(allDash.activeWindows.length, 0)
  }

  // Same-millisecond clear retry succeeds without false failure (Minor #3).
  const clearAgain = await fake.handler('clearUsageHistory', { provider: 'codex', confirm: true }, signal)
  assert.equal(clearAgain.ok, true)
})

test('summarizeStored handles very large entry arrays without call stack overflow (Minor #6)', () => {
  const many: WindowUsageEntry[] = []
  for (let i = 0; i < 150_000; i++) {
    many.push(makeEntry({
      id: `e-${i}`,
      provider: 'codex',
      account: `acct-${i % 5}`,
      kind: '5h',
      countedFrom: START + i * 1000,
      endedAt: START + (i + 1) * 1000,
    }))
  }
  const summary = summarizeStored(many, { state: 'unavailable' })
  assert.equal(summary.accounts, 5)
  assert.equal(summary.from, START)
  assert.equal(summary.to, START + 150_000 * 1000)
})

test('quotaCycles exposes current open cycles first, recent historical cycles newest-first (capped at 40), with quota % and model shares', () => {
  const entries: WindowUsageEntry[] = []
  // Create 45 historical closed 5h cycles + 1 open current 5h cycle with 2 models.
  for (let i = 0; i < 45; i++) {
    const start = NOW - (46 - i) * 5 * HOUR_MS
    entries.push(makeEntry({
      id: `hist-${i}`,
      provider: 'codex',
      account: 'acct-1',
      kind: '5h',
      status: 'closed',
      startsAt: start,
      countedFrom: start,
      endedAt: start + 5 * HOUR_MS,
      resetsAt: start + 5 * HOUR_MS,
      quotaUsedPercent: (i * 2) % 100,
      quotaPeakPercent: Math.min(100, (i * 2) % 100 + 5),
      quotaObservedAt: start + 4 * HOUR_MS,
      models: { 'gpt-5.4': counts(100 + i) },
      days: { '2026-11-22': { 'gpt-5.4': counts(100 + i) } },
    }))
  }
  entries.push(makeEntry({
    id: 'current-open',
    provider: 'codex',
    account: 'acct-1',
    kind: '5h',
    status: 'open',
    startsAt: NOW - 2 * HOUR_MS,
    countedFrom: NOW - 2 * HOUR_MS,
    resetsAt: NOW + 3 * HOUR_MS,
    quotaUsedPercent: 64,
    quotaPeakPercent: 72,
    quotaObservedAt: NOW - 60_000,
    models: {
      'gpt-5.4': counts(300, 100),
      'gpt-5.4-mini': counts(100, 0),
    },
    days: {
      '2026-11-23': {
        'gpt-5.4': counts(300, 100),
        'gpt-5.4-mini': counts(100, 0),
      },
    },
  }))

  const res = buildUsageDashboard({
    now: NOW,
    trackingStartedAt: START,
    providers: [
      { provider: 'codex', entries, loggedIn: [{ key: 'acct-1', label: 'a1@test.dev' }], observed: () => [], preTracking: { state: 'unavailable' }, errors: [] },
    ],
  }, { range: '30d' })

  assert.equal(res.quotaCycles.length, 40, 'quotaCycles capped at 40 entries')
  const first = res.quotaCycles[0]!
  assert.equal(first.isCurrent, true)
  assert.equal(first.status, 'open')
  assert.equal(first.quotaUsedPercent, 64)
  assert.equal(first.quotaPeakPercent, 72)
  assert.equal(first.totalTokens, 500)
  assert.equal(first.models.length, 2)
  assert.equal(first.models[0]?.model, 'gpt-5.4')
  assert.equal(first.models[0]?.share, 0.8)
  assert.equal(first.models[1]?.model, 'gpt-5.4-mini')
  assert.equal(first.models[1]?.share, 0.2)

  // Historical cycles follow newest-first with isCurrent === false.
  const hist = res.quotaCycles.slice(1)
  assert.equal(hist.length, 39)
  assert.ok(hist.every(c => !c.isCurrent && c.status === 'closed'))
  for (let i = 1; i < hist.length; i++) {
    assert.ok((hist[i - 1]!.endsAt ?? 0) >= (hist[i]!.endsAt ?? 0), 'historical cycles sorted newest-first')
  }
  assert.equal(hist[0]?.quotaUsedPercent, (44 * 2) % 100)
  assert.equal(hist[0]?.quotaPeakPercent, Math.min(100, (44 * 2) % 100 + 5))
})

test('pre-tracking daily history joins the all-accounts dashboard, not a single account', () => {
  // Tracking started on 2026-11-20, after these sessions.
  const laterStart = Date.UTC(2026, 10, 20, 0, 0, 0)
  const preTracking = {
    state: 'stored' as const,
    total: {
      v: 2 as const,
      trackingStartedAt: laterStart,
      days: {
        '2026-11-18': { 'gpt-5.4': counts(1000, 100) },
        '2026-01-01': { 'gpt-5.4-mini': counts(50) },
      },
      models: { 'gpt-5.4': counts(1000, 100), 'gpt-5.4-mini': counts(50) },
    },
  }
  const ledger = makeEntry({
    id: 'ledger',
    provider: 'codex',
    account: 'acct-1',
    kind: 'weekly',
    status: 'open',
    countedFrom: Date.UTC(2026, 10, 22, 8),
    resetsAt: Date.UTC(2026, 10, 25, 0),
    models: { 'gpt-5.4': counts(300, 100) },
    days: { '2026-11-22': { 'gpt-5.4': counts(300, 100) } },
  })
  const build = (account: string): ReturnType<typeof buildUsageDashboard> => buildUsageDashboard({
    now: NOW,
    trackingStartedAt: laterStart,
    providers: [
      { provider: 'codex', entries: [ledger], loggedIn: [{ key: 'acct-1', label: 'a1@test.dev' }], observed: () => [], preTracking, errors: [] },
    ],
  }, { range: 'all', account })

  const all = build('all')
  assert.equal(all.summary.totalTokens, 1550)
  assert.equal(all.summary.activeModels, 2)
  assert.equal(all.summary.activeDays, 3)
  assert.equal(all.summary.activeAccounts, 1, 'earlier history invents no account')
  assert.equal(all.daily.find(day => day.date === '2026-11-18')?.totalTokens, 1100)
  assert.equal(all.daily.find(day => day.date === '2026-01-01')?.totalTokens, 50)
  assert.equal(all.daily.find(day => day.date === '2026-11-22')?.totalTokens, 400)
  assert.equal(all.heatmap.find(day => day.date === '2026-11-18')?.totalTokens, 1100)
  assert.equal(all.heatmap.find(day => day.date === '2026-01-01'), undefined, 'older than the heatmap window')
  assert.equal(all.models.find(model => model.model === 'gpt-5.4-mini')?.totalTokens, 50)
  assert.equal(all.models.find(model => model.model === 'gpt-5.4')?.totalTokens, 1500)
  assert.equal(all.providers[0]?.totalTokens, 1550)
  // The account row keeps only what is attributed to it.
  assert.equal(all.providers[0]?.accounts[0]?.totalTokens, 400)

  const one = build('acct-1')
  assert.equal(one.summary.totalTokens, 400, 'a single account cannot show unattributed history')
  assert.equal(one.summary.activeModels, 1)
  assert.equal(one.summary.activeDays, 1)
  assert.equal(one.models.some(model => model.model === 'gpt-5.4-mini'), false)
  assert.equal(one.daily.some(day => day.date === '2026-11-18' || day.date === '2026-01-01'), false)
  assert.equal(one.daily.find(day => day.date === '2026-11-22')?.totalTokens, 400)
})

test('pre-tracking usage on the tracking-start day adds to that day instead of replacing the ledger', () => {
  const start = Date.UTC(2026, 10, 20, 0, 0, 0)
  const preTracking = {
    state: 'stored' as const,
    total: {
      v: 2 as const,
      trackingStartedAt: start,
      days: { '2026-11-20': { 'gpt-5.4': counts(10) } },
      models: { 'gpt-5.4': counts(10) },
    },
  }
  const ledger = makeEntry({
    id: 'same-day',
    provider: 'codex',
    account: 'acct-1',
    kind: '5h',
    status: 'open',
    countedFrom: start,
    models: { 'gpt-5.4': counts(5) },
    days: { '2026-11-20': { 'gpt-5.4': counts(5) } },
  })
  const res = buildUsageDashboard({
    now: NOW,
    trackingStartedAt: start,
    providers: [
      { provider: 'codex', entries: [ledger], loggedIn: [{ key: 'acct-1' }], observed: () => [], preTracking, errors: [] },
    ],
  }, { range: 'all' })

  assert.equal(res.summary.totalTokens, 15)
  assert.equal(res.daily.find(day => day.date === '2026-11-20')?.totalTokens, 15)
})


test('pre-tracking days are ignored when the provider is cleared', () => {
  const start = Date.UTC(2026, 10, 20, 0, 0, 0)
  const clearedAt = Date.UTC(2026, 10, 21, 0, 0, 0)
  const res = buildUsageDashboard({
    now: NOW,
    trackingStartedAt: start,
    providers: [{
      provider: 'codex',
      entries: [],
      loggedIn: [],
      observed: () => [],
      clearedAt,
      preTracking: {
        state: 'stored',
        total: {
          v: 2,
          trackingStartedAt: start,
          days: { '2026-11-18': { 'gpt-5.4': counts(100) } },
          models: { 'gpt-5.4': counts(100) },
        },
      },
      errors: [],
    }],
  }, { range: 'all', provider: 'codex' })

  assert.equal(res.summary.totalTokens, 0)
  assert.equal(res.daily.length, 0)
  assert.equal(res.cleared, true)
})
