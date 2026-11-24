import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PreTracking, PreTrackingFolder, foldSessions } from '../src/usage/pre-tracking.js'
import type { HostSessionLog } from '../src/usage/host-events.js'
import { parsePreTracking } from '../src/usage/usage-schema.js'
import { buildUsageDashboard } from '../src/usage/usage-dashboard.js'
import type { TokenCounts } from '../src/usage/window-tracker.js'

const DAY_MS = 24 * 60 * 60_000
const START = Date.UTC(2026, 4, 1, 0, 0, 0) // 2026-05-01T00:00:00Z

function counts(inputTokens: number, outputTokens = 0): TokenCounts {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function message(time: number, turn: number, step: number, usage: TokenCounts, provider = 'codex', model = 'gpt-5.4') {
  return {
    type: 'assistant/message',
    time,
    seq: turn,
    data: { turn, step, usage, message: { source: { provider, model } } },
  }
}

function log(events: HostSessionLog['events'], inheritedEventCount = 0): HostSessionLog {
  return { session: { id: 's1' }, inheritedEventCount, events }
}

test('pre-tracking fold keeps UTC daily sums and their model totals in step', () => {
  const apr28 = Date.UTC(2026, 3, 28, 10, 0, 0)
  const apr29 = Date.UTC(2026, 3, 29, 9, 0, 0)
  const events = [
    { type: 'request/context', time: apr28 - 3_600_000, seq: 0, data: { provider: 'codex', model: 'gpt-5.4' } },
    message(apr28, 1, 1, counts(100, 10)),
    // A later sample in the same (turn, step) slot replaces the earlier one across days.
    message(apr29, 1, 1, counts(200, 20)),
    message(apr29 + 3_600_000, 2, 1, counts(50)),
    {
      type: 'compaction/summary',
      time: apr28 + 8 * 3_600_000,
      seq: 5,
      data: { provider: 'codex', model: 'gpt-5.4', usage: counts(7) },
    },
    // At the boundary belongs to the window entries, not here.
    message(START, 3, 1, counts(999)),
  ]
  const fold = foldSessions([log(events)], START)

  assert.deepEqual(fold.days.codex, {
    '2026-04-28': { 'gpt-5.4': counts(7) },
    '2026-04-29': { 'gpt-5.4': counts(250, 20) },
  })
  assert.deepEqual(fold.totals.codex, { 'gpt-5.4': counts(257, 20) })
  assert.equal(fold.invalid, 0)
  assert.equal(fold.unattributed, 0)

  const sum = Object.values(fold.days.codex).reduce((total, models) => {
    total.inputTokens += models['gpt-5.4']!.inputTokens
    total.outputTokens += models['gpt-5.4']!.outputTokens
    return total
  }, counts(0))
  assert.deepEqual(sum, fold.totals.codex['gpt-5.4'])
})

test('pre-tracking fold counts only own events and reports samples with no provider', () => {
  const own = message(Date.UTC(2026, 3, 30, 12), 1, 1, counts(10))
  const inherited = message(Date.UTC(2026, 3, 29, 12), 0, 0, counts(999))
  const fold = new PreTrackingFolder(START)
  fold.add(log([inherited, own], 1))
  fold.add(log([inherited], 1))
  fold.add(log([{ type: 'assistant/message', time: Date.UTC(2026, 3, 30, 13), seq: 2, data: { turn: 2, step: 1, usage: counts(5) } }]))

  assert.deepEqual(fold.result().days.codex, { '2026-04-30': { 'gpt-5.4': counts(10) } })
  assert.equal(fold.result().unattributed, 1)
})

test('pre-tracking files keep version 1 totals readable and reject malformed days', () => {
  const total = parsePreTracking({
    v: 2,
    trackingStartedAt: START,
    days: {
      '2026-04-28': { 'gpt-5.4': counts(10, 2) },
      '2026-04-29': { 'gpt-5.4': counts(5) },
    },
  })
  assert.deepEqual(total?.models, { 'gpt-5.4': counts(15, 2) })
  assert.deepEqual(total?.days['2026-04-28'], { 'gpt-5.4': counts(10, 2) })

  // A version 1 total still reads, so a host without session history can keep showing it.
  const legacy = parsePreTracking({ v: 1, trackingStartedAt: START, models: { 'gpt-5.4': counts(15) } })
  assert.equal(legacy?.v, 1)
  assert.deepEqual(legacy?.days, {})
  assert.deepEqual(legacy?.models, { 'gpt-5.4': counts(15) })
  assert.equal(parsePreTracking({ v: 2, trackingStartedAt: START, days: { '2026-4-28': {} } }), undefined)
  assert.equal(parsePreTracking({ v: 2, trackingStartedAt: START, days: { '2026-04-28': { 'gpt-5.4': { inputTokens: 1 } } } }), undefined)
})

test('the one-time scan rewrites an old total with daily buckets and keeps its sums', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-pre-tracking-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ v: 1, trackingStartedAt: START, clearedAt: {} }))
  await mkdir(join(dir, 'codex'), { recursive: true })
  const path = join(dir, 'codex', 'pre-tracking.json')
  // A version 1 file has totals but no days: it does not count as computed, so the scan runs again.
  await writeFile(path, JSON.stringify({ v: 1, trackingStartedAt: START, models: { 'gpt-5.4': counts(999) } }))

  const apr28 = Date.UTC(2026, 3, 28, 10)
  const log: HostSessionLog = {
    session: { id: 's1' },
    inheritedEventCount: 0,
    events: [
      { type: 'request/context', time: apr28, seq: 0, data: { provider: 'codex', model: 'gpt-5.4' } },
      message(apr28 + 1, 1, 1, counts(100, 10)),
      message(apr28 + 2 + DAY_MS, 2, 1, counts(5)),
    ],
  }
  const query = {
    listSessions: async () => [{ header: { id: 's1' } }],
    readSession: async () => log,
  }
  const preTracking = new PreTracking({ dir, trackingStartedAt: async () => START })
  assert.deepEqual(await preTracking.status('codex'), {
    state: 'stored',
    total: { v: 1, trackingStartedAt: START, days: {}, models: { 'gpt-5.4': counts(999) } },
  }, 'the old total stays visible until the scan fills in the days')
  const detach = preTracking.attach(query)
  await preTracking.settled()
  await detach()

  const stored = parsePreTracking(JSON.parse(await readFile(path, 'utf8')))
  assert.equal(stored?.v, 2)
  assert.deepEqual(stored?.days, {
    '2026-04-28': { 'gpt-5.4': counts(100, 10) },
    '2026-04-29': { 'gpt-5.4': counts(5) },
  })
  assert.deepEqual(stored?.models, { 'gpt-5.4': counts(105, 10) })
  const status = await preTracking.status('codex')
  assert.deepEqual(status, { state: 'stored', total: stored })

  // With no ledger entries at all, the scanned days are the dashboard's only usage.
  const dashboard = buildUsageDashboard({
    now: Date.UTC(2026, 4, 2, 12),
    trackingStartedAt: START,
    providers: [{ provider: 'codex', entries: [], loggedIn: [], observed: () => [], preTracking: status, errors: [] }],
  }, { range: 'all' })
  assert.equal(dashboard.summary.totalTokens, 115)
  assert.equal(dashboard.daily.find(day => day.date === '2026-04-28')?.totalTokens, 110)
  assert.equal(dashboard.models[0]?.model, 'gpt-5.4')
})
