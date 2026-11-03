import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAntigravityQuotaSummary } from '../src/providers/antigravity-usage.js'
import { antigravityQuotaApplies } from '../src/antigravity-model-id.js'
import { antigravityQuotaSummary } from './fixtures/antigravity-quota-summary.js'

test('provider summary yields exactly the shared weekly/5h groups and Argon weekly limit', () => {
  const windows = parseAntigravityQuotaSummary(antigravityQuotaSummary())
  assert.deepEqual(windows.map(window => [window.scope, window.kind, Math.round(window.usedPercent)]), [
    ['Gemini Models', 'weekly', 1], ['Gemini Models', 'session', 1],
    ['Claude and GPT models', 'weekly', 0], ['Claude and GPT models', 'session', 0],
    ['Gemini 4 Argon', 'weekly', 33],
  ])
  assert.ok(windows.every(window => Number.isFinite(window.resetsAt)))
})

test('summary tolerates snake case and percent strings but never invents a window or fraction', () => {
  const windows = parseAntigravityQuotaSummary({ groups: [{ display_name: 'Gemini Models', buckets: [
    { display_name: '5-hour limit', remaining_fraction: '99%', reset_time: 'invalid' },
    { window: 'WEEKLY', remainingFraction: '0.5' },
    { window: 'WEEKLY', remainingFraction: 'garbage' },
    { window: 'WEEKLY', remainingFraction: '' },
    { window: 'WEEKLY', remainingFraction: '50garbage' },
    { window: 'WEEKLY', remainingFraction: 2 },
    { window: 'WEEKLY', remainingFraction: -0.1 },
    { window: 'UNKNOWN', remainingFraction: 1 },
    null,
  ] }] })
  assert.deepEqual(windows.map(window => [window.kind, Math.round(window.usedPercent)]), [['session', 1], ['weekly', 50]])
  assert.equal(windows[0].resetsAt, undefined)
  for (const malformed of [null, [], {}, { groups: {} }, { groups: [null, {}, { displayName: 'Unknown', buckets: [] }] }]) {
    assert.deepEqual(parseAntigravityQuotaSummary(malformed), [])
  }
})

test('shared quota membership isolates Argon from Gemini and includes both Claude and GPT', () => {
  assert.equal(antigravityQuotaApplies('Gemini Models', 'gemini-3.8-flash'), true)
  assert.equal(antigravityQuotaApplies('Gemini Models', 'gemini-4-argon'), false)
  assert.equal(antigravityQuotaApplies('Gemini 4 Argon', 'gemini-3.8-flash'), false)
  assert.equal(antigravityQuotaApplies('Gemini 4 Argon', 'gemini-4-argon-high'), true)
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5-low', 'gpt-oss-120b']) {
    assert.equal(antigravityQuotaApplies('Claude and GPT models', model), true)
    assert.equal(antigravityQuotaApplies('Gemini Models', model), false)
  }
})
