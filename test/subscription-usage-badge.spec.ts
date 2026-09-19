import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerHooks } from 'node:module'
// The host primitives ship CSS modules; Node needs only their empty class map
// for these pure-logic / server-render tests, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { AccountWindows, compactSegment, createCurrentModelReader, previewWindows,
  collapsedDisplays, expandedDisplays } = await import('../src/client/SubscriptionUsageBadge.js')
css.deregister()
import type { ProviderUsageDisplay } from '../src/client/SubscriptionUsageBadge.js'
import { groupUsageWindows } from '../src/client/SubscriptionsSection.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

const windows: UsageWindow[] = Array.from({ length: 60 }, (_, i) => ({
  kind: 'other', scope: `gemini-model-${i}`, usedPercent: i,
}))
function display(provider: ProviderUsageDisplay['provider'] = 'antigravity', values = windows): ProviderUsageDisplay {
  return { provider, name: provider === 'antigravity' ? 'Antigravity' : 'Codex', accounts: [
    { key: 'default', isDefault: true, windows: values },
  ] }
}

test('Antigravity compact readout selects exact current model, not the entire catalog', () => {
  const d = display('antigravity', [...windows, { kind: 'weekly', scope: 'gemini-model-59', usedPercent: 81 }])
  assert.equal(compactSegment(d, 'gemini-model-59'), 'Antigravity Window 59% · Weekly 81%')
  assert.equal(compactSegment(d), 'Antigravity 60 model quotas')
  assert.equal(compactSegment(d, 'missing'), 'Antigravity Current model quota unavailable')
  assert.ok(compactSegment(d, 'gemini-model-1').length < 60)
})

test('compact summary uses default account and preserves bounded non-Antigravity windows', () => {
  const d = display('codex', [{ kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }])
  d.accounts.unshift({ key: 'other', isDefault: false, windows: [{ kind: 'session', usedPercent: 99 }] })
  assert.equal(compactSegment(d), 'Codex 5h 13% · Wk 25%')
  assert.ok(compactSegment(display('codex')).endsWith('+58'))
})

test('preview promotes current-model windows without losing, merging, or mutating data', () => {
  const original = structuredClone(windows)
  const { shown, hidden } = previewWindows(windows, 'gemini-model-59')
  assert.equal(shown.length, 4)
  assert.equal(hidden.length, 56)
  assert.equal(shown[0]?.scope, 'gemini-model-59')
  assert.equal(new Set([...shown, ...hidden]).size, 60)
  assert.deepEqual(windows, original)
  assert.deepEqual(previewWindows([]), { shown: [], hidden: [] })
  assert.deepEqual(previewWindows(windows.slice(0, 2)).hidden, [])
})

test('rendered account keeps other windows in a closed native disclosure with localized labels', () => {
  for (const dictionary of [en, zh]) {
    const translate = (key: keyof typeof en, params?: Record<string, unknown>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const html = renderToStaticMarkup(createElement(AccountWindows, { windows, model: 'gemini-model-59', translate }))
    assert.ok(html.includes('<details'))
    assert.ok(!html.includes('open=""'))
    assert.ok(html.includes(translate('usageBadgeMoreWindows', { count: 60 })))
    assert.ok(html.includes(translate('usageBadgeCurrent')))
    assert.ok(html.indexOf('gemini-model-59') < html.indexOf('</summary>'))
    assert.ok(html.includes('gemini-model-58'))
  }
})



test('equal displayed percentages collapse into one bar and preserve model names', () => {
  const input: UsageWindow[] = [
    { kind: 'other', scope: 'zero-a', usedPercent: 0 },
    { kind: 'other', scope: 'zero-b', usedPercent: 0.4 },
    { kind: 'other', scope: 'busy-a', usedPercent: 57, resetsAt: 123 },
    { kind: 'other', scope: 'busy-b', usedPercent: 57.2, resetsAt: 123 },
    { kind: 'other', scope: 'other', usedPercent: 20 },
  ]
  const groups = groupUsageWindows(input)
  assert.deepEqual(groups.map(group => [group.percent, group.windows.map(window => window.scope)]), [
    [0, ['zero-a', 'zero-b']],
    [57, ['busy-a', 'busy-b']],
    [20, ['other']],
  ])
  assert.equal(groups[1]?.resetsAt, 123)
  assert.deepEqual(input.map(window => window.scope), ['zero-a', 'zero-b', 'busy-a', 'busy-b', 'other'])
})

test('collapsed Antigravity account renders grouped bars and expanded full model list', () => {
  const values: UsageWindow[] = [
    { kind: 'other', scope: 'gemini-a', usedPercent: 0 },
    { kind: 'other', scope: 'gemini-b', usedPercent: 0 },
    { kind: 'other', scope: 'gemini-c', usedPercent: 57 },
  ]
  const html = renderToStaticMarkup(createElement(AccountWindows, { windows: values, model: undefined, translate: (key: keyof typeof en, params?: Record<string, unknown>) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')) }))
  assert.ok(html.includes('<details'))
  assert.ok(!html.includes('open=""'))
  assert.ok(html.includes('gemini-a +1'))
  assert.ok(html.includes('title="Window · gemini-a'))
  assert.ok(html.includes('Window · gemini-b'))
  assert.ok(html.indexOf('gemini-a +1') < html.indexOf('</summary>'))
  assert.ok(html.lastIndexOf('gemini-b') > html.indexOf('</summary>'))
})

test('provider ordering stays independent from model-window filtering', () => {
  const all = [display('codex'), display()]
  assert.deepEqual(collapsedDisplays(all, 'antigravity'), [all[1]])
  assert.deepEqual(expandedDisplays(all, 'antigravity'), [all[1], all[0]])
  assert.deepEqual(collapsedDisplays(all, undefined), all)
})

test('model reader observes switches within the same provider and handles missing directories', async () => {
  let model = 'one'
  const read = createCurrentModelReader(() => ({ directoryFor: sessionId => {
    assert.equal(sessionId, 'session')
    return { load: async () => ({ current: { provider: 'antigravity', model } }) }
  } }), 'session')
  assert.deepEqual(await read(), { provider: 'antigravity', model: 'one' })
  model = 'two'
  assert.deepEqual(await read(), { provider: 'antigravity', model: 'two' })
  assert.equal(await createCurrentModelReader(() => undefined, 'session')(), undefined)
  assert.equal(await createCurrentModelReader(() => ({ directoryFor: () => ({ load: async () => ({ current: null }) }) }), 'session')(), undefined)
})
