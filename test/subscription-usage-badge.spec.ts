import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerHooks } from 'node:module'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
// The host primitives ship CSS modules; Node needs only their empty class map
// for these pure-logic / server-render tests, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { AccountWindows, CodexExhaustionNotice, compactSegment, createCurrentModelReader, enabledBadgeRoster, previewWindows,
  collapsedDisplays, expandedDisplays, retainSubscriptionSelection, usageBadgeIcon, compactQuotaRows, budgetTargetRemaining, budgetTargetTone, compactQuotaColor } = await import('../src/client/SubscriptionUsageBadge.js')
const { ImageGenerateToolview } = await import('../src/client/ImageGenerateToolview.js')
const { VideoGenerateToolview } = await import('../src/client/VideoGenerateToolview.js')
css.deregister()
import type { ProviderUsageDisplay } from '../src/client/SubscriptionUsageBadge.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'
import { visibleUsageWindows } from '../src/client/usage-window-filter.js'

test('media tool views render the preparing phase before arguments are available', () => {
  for (const [Component, name] of [[ImageGenerateToolview, 'image_generate'], [VideoGenerateToolview, 'video_generate']] as const) {
    // `args` is required on every tool-call head since DSH 0.2.1-rc.2; EMPTY is
    // the honest view for a call whose arguments have not arrived yet.
    const block = {
      phase: 'preparing' as const, callId: 'media-call', name, turn: 0, step: 0, time: 0,
      subCalls: [], args: PartialArguments.EMPTY,
    }
    const html = renderToStaticMarkup(createElement(Component, { block }))
    assert.ok(html.includes(name))
  }
})

test('media views observe streaming prompt updates and settled arguments', () => {
  for (const [Component, name] of [[ImageGenerateToolview, 'image_generate'], [VideoGenerateToolview, 'video_generate']] as const) {
    const args = new PartialArguments()
    const block = { phase: 'preparing' as const, callId: 'media-call', name, turn: 0, step: 0, time: 0, subCalls: [], args }
    const render = () => renderToStaticMarkup(createElement(Component, { block }))
    assert.match(render(), new RegExp(name))
    args.append('{"prompt":"Hello')
    assert.equal(args.refresh(), true)
    assert.match(render(), /Hello/)
    args.append(' world","referenceImages":[{},{}]}')
    assert.equal(args.refresh(), true)
    assert.match(render(), /Hello world/)
    if (name === 'image_generate') assert.match(render(), /\(2 ref\)/)
    const settled = { kind: 'tool-result' as const, seq: 1, time: 0, callId: 'media-call', name,
      args: PartialArguments.fromObject({ prompt: 'Finished', referenceImages: [{}, {}] }),
      call: null, callTime: null, content: [], subCalls: [], isError: false }
    assert.match(renderToStaticMarkup(createElement(Component, { block: settled })), /Finished/)
  }
})

test('media views support legacy calls without argument views', () => {
  for (const [Component, name] of [[ImageGenerateToolview, 'image_generate'], [VideoGenerateToolview, 'video_generate']] as const) {
    const raw = JSON.stringify({ prompt: 'Legacy prompt', referenceImages: [{}, {}] })
    const start = { phase: 'start', callId: 'legacy', name, turn: 0, step: 0, time: 0, subCalls: [], argsRaw: raw }
    const result = { kind: 'tool-result', seq: 1, time: 0, callId: 'legacy', name,
      call: { name, argsRaw: raw }, callTime: 0, content: [], subCalls: [], isError: false }
    for (const legacy of [start, result]) {
      const block = legacy as unknown as NonNullable<Parameters<typeof ImageGenerateToolview>[0]['block']>
      const html = renderToStaticMarkup(createElement(Component, { block }))
      assert.match(html, /Legacy prompt/)
      if (name === 'image_generate') assert.match(html, /\(2 ref\)/)
    }
    const malformed = { ...start, argsRaw: 'invalid raw\nsecond line' } as unknown as NonNullable<Parameters<typeof ImageGenerateToolview>[0]['block']>
    assert.match(renderToStaticMarkup(createElement(Component, { block: malformed })), /invalid raw/)
  }
})

const windows: UsageWindow[] = Array.from({ length: 60 }, (_, i) => ({
  kind: 'other', scope: `gemini-model-${i}`, usedPercent: i,
}))
function display(provider: ProviderUsageDisplay['provider'] = 'antigravity', values = windows): ProviderUsageDisplay {
  return { provider, name: provider === 'antigravity' ? 'Antigravity' : 'Codex', accounts: [
    { key: 'default', isDefault: true, windows: values },
  ] }
}

test('Codex exhaustion notice renders localized credits and reset guidance only for all displayed exhausted accounts', () => {
  const d = display('codex', [{ kind: 'weekly', usedPercent: 100 }])
  d.accounts.push({ key: 'second', isDefault: false, windows: [{ kind: 'session', usedPercent: 105 }] })
  for (const dictionary of [en, zh]) {
    const translate = (key: keyof typeof en) => dictionary[key]
    const render = () => renderToStaticMarkup(createElement(CodexExhaustionNotice, { display: d, translate }))
    assert.match(render(), /role="status"/)
    assert.ok(render().includes(dictionary.usageBadgeAllCodexExhausted))
    d.accounts[0]!.usage = { supported: true, credits: { hasCredits: true, unlimited: false, balance: '12.5' } }
    assert.ok(render().includes(dictionary.usageBadgeCodexCreditsFallback))
    assert.ok(!render().includes(dictionary.usageBadgeAllCodexExhausted))
    d.accounts[0]!.usage = { supported: true, credits: { hasCredits: true, unlimited: false, balance: '0' } }
    assert.ok(render().includes(dictionary.usageBadgeAllCodexExhausted))
    delete d.accounts[0]!.usage
    d.accounts[1]!.windows[0]!.usedPercent = 99.99
    assert.equal(render(), '', 'do not treat rounded 100% as exhaustion')
    d.accounts[1]!.windows[0]!.usedPercent = Infinity
    assert.equal(render(), '', 'non-finite telemetry is unknown, not exhaustion')
    d.accounts[1]!.windows = []
    assert.equal(render(), '', 'unknown usage is not known exhaustion')
    d.accounts[1]!.windows = [{ kind: 'session', usedPercent: 105 }]
  }
  assert.equal(renderToStaticMarkup(createElement(CodexExhaustionNotice, {
    display: display('claude', [{ kind: 'weekly', usedPercent: 100 }]), translate: key => en[key],
  })), '')
})

test('native shared account panel follows used/remaining quota display mode despite an Argon-only whitelist', () => {
  const shared: UsageWindow[] = [
    { kind: 'weekly', scope: 'Gemini Models', usedPercent: 27 },
    { kind: 'session', scope: 'Gemini Models', usedPercent: 7 },
    { kind: 'weekly', scope: 'Claude and GPT models', usedPercent: 77 },
    { kind: 'session', scope: 'Claude and GPT models', usedPercent: 0 },
  ]
  const filtered = visibleUsageWindows('antigravity', shared, ['gemini-4-argon-high'])
  assert.deepEqual(filtered, shared, 'model visibility does not hide account-wide shared quotas')
  for (const dictionary of [en, zh]) {
    const translate = (key: keyof typeof en, params?: Record<string, unknown>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const usedHtml = renderToStaticMarkup(createElement(AccountWindows, {
      windows: filtered, model: 'gemini-4-argon', provider: 'antigravity', translate,
    }))
    assert.equal((usedHtml.match(/role="progressbar"/g) ?? []).length, 4)
    for (const percent of [27, 7, 77, 0]) assert.ok(usedHtml.includes(translate('quotaUsedPercent', { percent })))
    assert.ok(!usedHtml.includes('gemini-4-argon-') && !usedHtml.includes('<details'))
    assert.equal(compactSegment(display('antigravity', shared), 'gemini-4-argon', translate),
      `Antigravity · ${translate('quotaUsedPercent', { percent: 7 })} / ${translate('quotaUsedPercent', { percent: 27 })}`,
      'the pill keeps two percentages, session window first, and no account or window label')

    const remainingHtml = renderToStaticMarkup(createElement(AccountWindows, {
      windows: filtered, model: 'gemini-4-argon', provider: 'antigravity', translate, mode: 'remaining',
    }))
    for (const percent of [73, 93, 23, 100]) assert.ok(remainingHtml.includes(translate('quotaRemainingPercent', { percent })))
    assert.equal(compactSegment(display('antigravity', shared), 'gemini-4-argon', translate, 'remaining'),
      `Antigravity · ${translate('quotaRemainingPercent', { percent: 93 })} / ${translate('quotaRemainingPercent', { percent: 73 })}`)
  }
})

test('Antigravity compact readout selects exact current model, not the entire catalog', () => {
  const d = display('antigravity', [...windows, { kind: 'weekly', scope: 'gemini-model-59', usedPercent: 81 }])
  assert.equal(compactSegment(d, 'gemini-model-59'), 'Antigravity · 81% used / 59% used')
  assert.equal(compactSegment(d), 'Antigravity · 60 model quotas')
  assert.equal(compactSegment(d, 'missing'), 'Antigravity · Current model quota unavailable')
  assert.ok(compactSegment(d, 'gemini-model-1').length < 90)
})

test('the compact readout drops window labels, freshness, overflow and credits', () => {
  const d = display('codex', [{ kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }])
  d.accounts[0]!.usage = { supported: true, stale: true, fetchedAt: 1, credits: { hasCredits: true, unlimited: false, balance: '12.5' } }
  const label = compactSegment(d)
  assert.equal(label, 'Codex · 13% used / 25% used')
  assert.doesNotMatch(label, /Default account|Listed account|stale|credits|\+/)
  assert.ok(compactSegment(display('codex')).length < 40, 'a long catalogue never widens the pill')
})

test('compact summary counts signed-in accounts without aggregating their percentages', () => {
  const d = display('codex', [{ kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }])
  d.accounts.unshift({ key: 'other', isDefault: false, windows: [{ kind: 'session', usedPercent: 99 }] })
  assert.equal(compactSegment(d), 'Codex · 2 signed-in accounts')
  assert.equal(compactSegment(display('codex', [
    { kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }, { kind: 'weekly', usedPercent: 40 },
  ])), 'Codex · 13% used / 25% used', 'extra windows are counted in the dialog, never on the pill')
})

test('enabledBadgeRoster skips disabled Antigravity accounts so the badge neither polls nor displays them', () => {
  const roster = enabledBadgeRoster({
    codex: { busy: false, accounts: [{ key: 'c1', isDefault: true }] },
    antigravity: { busy: false, enabled: false, accounts: [{ key: 'a1', isDefault: true }] },
  })
  assert.deepEqual(roster, [{ provider: 'codex', account: { key: 'c1', isDefault: true } }])
  const enabledRoster = enabledBadgeRoster({
    antigravity: { busy: false, accounts: [{ key: 'a1', isDefault: true }] },
  })
  assert.deepEqual(enabledRoster, [{ provider: 'antigravity', account: { key: 'a1', isDefault: true } }])
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

test('Google dialog previews and disclosure counts only include selected models', () => {
  const filtered = visibleUsageWindows('antigravity', windows, ['gemini-model-1', 'gemini-model-59'])
  const translate = (key: keyof typeof en, params?: Record<string, unknown>) =>
    en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  const html = renderToStaticMarkup(createElement(AccountWindows, {
    windows: filtered, model: 'gemini-model-59', provider: 'antigravity', translate,
  }))
  assert.equal((html.match(/<dt /g) ?? []).length, 2)
  assert.ok(html.includes(translate('usageBadgeMoreWindows', { count: 1 })))
  assert.ok(!html.includes('gemini-model-58'))
  assert.equal(windows.length, 60)
  for (const dictionary of [en, zh]) {
    const empty = renderToStaticMarkup(createElement(AccountWindows, {
      windows: [], model: 'gemini-model-59', provider: 'antigravity', translate: key => dictionary[key],
    }))
    assert.ok(empty.includes(dictionary.usageNoVisibleModels))
    assert.ok(!empty.includes('<details'))
    assert.ok(!empty.includes('<dt'))
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

test('a non-subscription model clears the badge instead of keeping the last subscription', () => {
  const codex = { provider: 'codex', model: 'gpt-test' }
  const anti = { provider: 'antigravity', model: 'gemini-model-59' }
  const api = { provider: 'deepseek', model: 'deepseek-chat' }
  assert.equal(retainSubscriptionSelection(undefined, api), undefined)
  assert.equal(retainSubscriptionSelection(undefined, undefined), undefined)
  assert.equal(retainSubscriptionSelection(undefined, codex), codex)
  assert.equal(retainSubscriptionSelection(codex, api), undefined, 'an API model drops the pill')
  assert.equal(retainSubscriptionSelection(codex, anti), anti)
  assert.equal(retainSubscriptionSelection(anti, api), undefined, 'switching away from a subscription drops the pill')
  assert.equal(retainSubscriptionSelection(anti, undefined), anti, 'an unreadable model keeps the pill instead of flickering')
  assert.deepEqual(collapsedDisplays([display('codex'), display()], retainSubscriptionSelection(anti, api)?.provider).map(d => d.provider), [])
  assert.deepEqual(collapsedDisplays([display('codex')], anti.provider), [])
  assert.deepEqual(collapsedDisplays([display('codex'), display('antigravity')], retainSubscriptionSelection(anti, undefined)?.provider).map(d => d.provider), ['antigravity'])
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

test('Antigravity badge previews variant quota scopes for the grouped current model', () => {
  const windows: UsageWindow[] = [
    { kind: 'other', scope: 'claude-opus-5-5-medium', usedPercent: 70 },
    { kind: 'other', scope: 'gemini-4-argon-high', usedPercent: 20 },
    { kind: 'weekly', scope: 'gemini-4-argon-low', usedPercent: 40 },
  ]
  const preview = previewWindows(windows, 'gemini-4-argon', 'antigravity')
  assert.deepEqual(preview.shown, windows.slice(1))
  assert.deepEqual(preview.hidden, [windows[0]])
})

test('the compact readout keeps the percentage mode and unknown values, and leaves source detail to the dialog', () => {
  const d = display('claude', [{ kind: 'weekly', scope: 'Opus', usedPercent: 28 }])
  d.name = 'Claude'
  d.accounts[0]!.isDefault = false
  d.accounts[0]!.usage = { supported: true, stale: true, fetchedAt: 1 }
  assert.equal(compactSegment(d, undefined, undefined, 'remaining'), 'Claude · 72% remaining')
  d.accounts[0]!.windows[0]!.usedPercent = NaN
  assert.equal(compactSegment(d, undefined, undefined, 'remaining'), 'Claude · Unknown quota')
  assert.doesNotMatch(compactSegment(d, undefined, undefined, 'remaining'), /100%/)
  d.accounts.push({ key: 'unknown', isDefault: false, windows: [] })
  assert.match(compactSegment(d), /2 signed-in accounts/)
  assert.doesNotMatch(compactSegment(d), /%/)
})

test('Compact rows show only the default account shared windows as remaining quotas', () => {
  const d = display('claude', [
    { kind: 'weekly', usedPercent: 57, resetsAt: 1_900_000_000_000 },
    { kind: 'session', usedPercent: 25, resetsAt: 1_800_000_000_000 },
    { kind: 'weekly', scope: 'Fable', usedPercent: 9 },
  ])
  d.accounts.unshift({ key: 'other', isDefault: false,
    windows: [{ kind: 'session', usedPercent: 99 }, { kind: 'weekly', usedPercent: 100 }] })
  assert.deepEqual(compactQuotaRows(d), [
    { kind: 'session', shortLabel: '5h', usedPercent: 25, remainingPercent: 75, resetsAt: 1_800_000_000_000 },
    { kind: 'weekly', shortLabel: '7d', usedPercent: 57, remainingPercent: 43, resetsAt: 1_900_000_000_000 },
  ])
  assert.deepEqual(compactQuotaRows(display('antigravity', [{ kind: 'weekly', scope: 'Gemini', usedPercent: 20 }])), [])
  assert.deepEqual(compactQuotaRows(display('codex', [{ kind: 'session', usedPercent: 110 }, { kind: 'weekly', usedPercent: -4 }])), [
    { kind: 'session', shortLabel: '5h', usedPercent: 100, remainingPercent: 0 },
    { kind: 'weekly', shortLabel: '7d', usedPercent: 0, remainingPercent: 100 },
  ])
})

test('budget line tracks elapsed time within the reset duration, hiding invalid resets', () => {
  const hour = 3600_000
  const now = 2_000_000_000_000
  assert.equal(budgetTargetRemaining({ kind: 'session', resetsAt: now + 2.5 * hour }, now), 50)
  assert.equal(budgetTargetRemaining({ kind: 'weekly', resetsAt: now + 3.5 * 24 * hour }, now), 50)
  assert.equal(budgetTargetRemaining({ kind: 'session', resetsAt: now + hour, durationMs: 2 * hour }, now), 50)
  assert.equal(budgetTargetRemaining({ kind: 'session', resetsAt: now + 5 * hour }, now), 100)
  assert.equal(budgetTargetRemaining({ kind: 'session', resetsAt: now }, now), 0)
  assert.equal(budgetTargetRemaining({ kind: 'session' }, now), undefined)
  assert.equal(budgetTargetRemaining({ kind: 'session', resetsAt: now - 1 }, now), undefined)
  assert.equal(budgetTargetRemaining({ kind: 'session', resetsAt: now + 6 * hour }, now), undefined)
  assert.equal(budgetTargetRemaining({ kind: 'session', resetsAt: now + hour, durationMs: 0 }, now), undefined)
})

test('budget marker tone is white when safe, orange when near, red when over', () => {
  assert.equal(budgetTargetTone(75, 60), 'safe')
  assert.equal(budgetTargetTone(70.01, 60), 'safe')
  assert.equal(budgetTargetTone(70, 60), 'near')
  assert.equal(budgetTargetTone(60, 60), 'near')
  assert.equal(budgetTargetTone(59.999, 60), 'over')
  assert.equal(budgetTargetTone(40, 50), 'over')
})

test('compact quota fill uses no green and bright warning colors', () => {
  assert.equal(compactQuotaColor(100), '#cbd5e1')
  assert.equal(compactQuotaColor(60), '#cbd5e1')
  assert.equal(compactQuotaColor(40), '#ffda24')
  assert.equal(compactQuotaColor(20), '#ffaa00')
  assert.equal(compactQuotaColor(0), '#ff244c')
})
