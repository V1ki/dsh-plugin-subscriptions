import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleUsageWindows } from '../src/client/usage-window-filter.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

const windows: UsageWindow[] = [
  { kind: 'other', scope: 'gemini-3-flash', usedPercent: 20, resetsAt: 123 },
  { kind: 'weekly', scope: 'gemini-3-flash', usedPercent: 40 },
  { kind: 'other', scope: 'claude-sonnet-4-6', usedPercent: 70 },
  { kind: 'other', scope: 'tab_jump_flash_lite_preview', usedPercent: 0 },
]

test('Google usage follows exact saved model IDs, retaining ordinary and weekly windows', () => {
  const before = structuredClone(windows)
  assert.deepEqual(visibleUsageWindows('antigravity', windows, ['gemini-3-flash']), windows.slice(0, 2))
  assert.deepEqual(visibleUsageWindows('antigravity', windows, ['claude-sonnet-4-6']), [windows[2]])
  assert.deepEqual(visibleUsageWindows('antigravity', windows, ['gemini-3']), [])
  assert.deepEqual(windows, before, 'presentation filtering must not mutate raw quotas')
})

test('automatic visibility shows all models; empty and unavailable selections show none', () => {
  assert.strictEqual(visibleUsageWindows('antigravity', windows, undefined), windows)
  assert.deepEqual(visibleUsageWindows('antigravity', windows, []), [])
  assert.deepEqual(visibleUsageWindows('antigravity', windows, ['unavailable-model']), [])
  assert.deepEqual(visibleUsageWindows('antigravity', undefined, ['gemini-3-flash']), [])
  assert.deepEqual(visibleUsageWindows('antigravity', [], undefined), [])
})

test('visibility never removes account-wide windows or other providers family quotas', () => {
  const unscoped: UsageWindow[] = [
    { kind: 'session', usedPercent: 10 },
    { kind: 'weekly', scope: '', usedPercent: 30 },
  ]
  assert.deepEqual(visibleUsageWindows('antigravity', [...windows, ...unscoped], []), unscoped)
  for (const provider of ['codex', 'claude', 'grok', 'copilot'] as const) {
    assert.strictEqual(visibleUsageWindows(provider, windows, []), windows)
  }
})

test('filtered-empty usage has distinct bilingual copy from missing upstream quotas', () => {
  for (const locale of [en, zh]) {
    assert.ok(locale.usageNoVisibleModels)
    assert.notEqual(locale.usageNoVisibleModels, locale.usageEmpty)
  }
})
