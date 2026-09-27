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
  collapsedDisplays, expandedDisplays, retainSubscriptionSelection, usageBadgeIcon } = await import('../src/client/SubscriptionUsageBadge.js')
css.deregister()
import type { ProviderUsageDisplay } from '../src/client/SubscriptionUsageBadge.js'
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
    assert.ok(html.includes(translate('usageBadgeMoreWindows', { count: 56 })))
    assert.ok(html.includes(translate('usageBadgeCurrent')))
    assert.ok(html.indexOf('gemini-model-59') < html.indexOf('<details'))
    assert.ok(html.includes('gemini-model-58'))
  }
})

test('provider ordering stays independent from model-window filtering', () => {
  const all = [display('codex'), display()]
  assert.deepEqual(collapsedDisplays(all, 'antigravity'), [all[1]])
  assert.deepEqual(expandedDisplays(all, 'antigravity'), [all[1], all[0]])
  assert.deepEqual(collapsedDisplays(all, undefined), [])
  assert.deepEqual(collapsedDisplays(all, 'deepseek'), [])
  assert.deepEqual(collapsedDisplays(all, 'grok'), [])
})

test('non-subscription selections retain only the last subscription and its model scope', () => {
  const codex = { provider: 'codex', model: 'gpt-test' }
  const anti = { provider: 'antigravity', model: 'gemini-model-59' }
  const api = { provider: 'deepseek', model: 'deepseek-chat' }
  assert.equal(retainSubscriptionSelection(undefined, api), undefined)
  assert.equal(retainSubscriptionSelection(undefined, undefined), undefined)
  assert.equal(retainSubscriptionSelection(undefined, codex), codex)
  assert.equal(retainSubscriptionSelection(codex, api), codex)
  assert.equal(retainSubscriptionSelection(codex, anti), anti)
  assert.equal(retainSubscriptionSelection(anti, api), anti)
  assert.equal(retainSubscriptionSelection(anti, undefined), anti)
  assert.deepEqual(collapsedDisplays([display('codex'), display()], retainSubscriptionSelection(anti, api)?.provider).map(d => d.provider), ['antigravity'])
  assert.deepEqual(collapsedDisplays([display('codex')], anti.provider), [])
})

test('data icon supports both DSH export names without requiring either named import', () => {
  const modern = () => createElement('svg', { 'data-version': 'modern' })
  const legacy = () => createElement('svg', { 'data-version': 'legacy' })
  assert.equal(usageBadgeIcon({ IconDataOutlineRegular: modern, IconDataOutline16: legacy }), modern)
  assert.equal(usageBadgeIcon({ IconDataOutlineRegular: modern }), modern)
  assert.equal(usageBadgeIcon({ IconDataOutline16: legacy }), legacy)
  assert.match(renderToStaticMarkup(createElement(usageBadgeIcon({ IconDataOutlineRegular: modern }))), /data-version="modern"/)
  assert.equal(renderToStaticMarkup(createElement(usageBadgeIcon({}))), '')
})

test('Antigravity previews only the exact current model, retaining all hidden windows', () => {
  const original = structuredClone(windows)
  assert.deepEqual(previewWindows(windows, undefined, 'antigravity'), { shown: [], hidden: windows })
  assert.deepEqual(previewWindows(windows, 'missing', 'antigravity'), { shown: [], hidden: windows })
  const current = previewWindows(windows, 'gemini-model-59', 'antigravity')
  assert.equal(current.shown.length, 1)
  assert.equal(current.shown[0]?.scope, 'gemini-model-59')
  assert.equal(current.hidden.length, 59)
  const multiple: UsageWindow[] = [...windows,
    { kind: 'weekly', scope: 'gemini-model-59', usedPercent: 81 },
    { kind: 'session', scope: 'gemini-model-59', usedPercent: 25 }]
  const bounded = previewWindows(multiple, 'gemini-model-59', 'antigravity')
  assert.deepEqual(bounded.shown.map(w => w.usedPercent), [59, 81])
  assert.equal(new Set([...bounded.shown, ...bounded.hidden]).size, multiple.length)
  assert.deepEqual(windows, original)
  for (const provider of ['codex', 'grok', 'claude'] as const) {
    assert.equal(previewWindows(windows, undefined, provider).shown.length, 4)
  }
})

test('inactive Antigravity renders every model inside a closed disclosure', () => {
  const translate = (key: keyof typeof en, params?: Record<string, unknown>) =>
    en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  const html = renderToStaticMarkup(createElement(AccountWindows, { windows, model: undefined, provider: 'antigravity', translate }))
  assert.ok(html.indexOf('<details') < html.indexOf('gemini-model-0'))
  assert.ok(html.includes(translate('usageBadgeMoreWindows', { count: 60 })))
  assert.ok(!html.includes('open=""'))
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
