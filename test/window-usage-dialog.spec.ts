import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UsageDialogBody } from '../src/client/AccountUsageDialog.js'
import { en } from '../src/client/locales.js'
import { initialUsageDialogState, usageDialogReducer as reduce } from '../src/client/usage-dialog-state.js'
import type { AccountUsageResponse } from '../src/usage/usage-rpc.js'
import type { ViewKind } from '../src/usage/window-view.js'

const end = Date.UTC(2026, 10, 20, 6)
const counts = { inputTokens: 3, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 2, reasoningTokens: 4 }
const day = '2026-11-20'

function response(kind: ViewKind = '5h', windowEnd = end, current = true): AccountUsageResponse {
  return {
    provider: 'claude', account: 'fixture',
    accounts: [{ key: 'fixture', loggedIn: true, isDefault: true }],
    stored: { accounts: 1, earlierHistory: false },
    errors: [],
    view: {
      provider: 'claude', account: 'fixture',
      kinds: [{ kind }], selected: { kind },
      trackingStartedAt: end - 20_000,
      providerTotal: { state: 'not-computed' },
      window: {
        kind, end: windowEnd, window0: false, current, oldest: true, status: 'open',
        countedFrom: end - 10_000, markers: [], entryIds: ['fixture-window'],
        models: { 'test-model': counts }, days: { [day]: { 'test-model': counts } },
      },
    },
  }
}

test('an unchanged expired window cannot immediately trigger another automatic read', () => {
  const payload = response()
  const shown = reduce(initialUsageDialogState(), { type: 'loaded', response: payload })
  assert.strictEqual(reduce(shown, { type: 'clock', now: end - 1 }), shown)
  const loading = reduce(shown, { type: 'clock', now: end })
  assert.equal(loading.load, shown.load + 1)
  assert.deepEqual(loading.request, { account: 'fixture', kind: '5h' })
  assert.strictEqual(reduce(loading, { type: 'clock', now: end }), loading)
  // RPC returned the same expired window, including after a new object arrives.
  const shownAgain = reduce(loading, { type: 'loaded', response: response() })
  for (const now of [end, end + 1, end + 59_999]) {
    assert.strictEqual(reduce(shownAgain, { type: 'clock', now }), shownAgain)
  }
  const retry = reduce(shownAgain, { type: 'clock', now: end + 60_000 })
  assert.equal(retry.load, loading.load + 1)
  // Changed metadata for an already-expired window also cannot re-run the
  // effect on the same tick. This bounds alternating server responses too.
  const next = reduce(retry, { type: 'loaded', response: response('5h', end + 30_000) })
  assert.strictEqual(reduce(next, { type: 'clock', now: end + 60_000 }), next)
  assert.equal(reduce(next, { type: 'clock', now: end + 120_000 }).load, retry.load + 1)
})

test('a historical window never auto-refreshes, and pending refresh follows the resolved kind', () => {
  const old = reduce(initialUsageDialogState(), { type: 'loaded', response: response('5h', end, false) })
  assert.strictEqual(reduce(old, { type: 'clock', now: end + 300_000 }), old)
  const pending = reduce(old, { type: 'kind', option: { kind: 'pending' } })
  const shown = reduce(pending, { type: 'loaded', response: response('weekly') })
  assert.deepEqual(reduce(shown, { type: 'refresh' }).request, { account: 'fixture', kind: 'weekly' })
  assert.deepEqual(reduce(shown, { type: 'retry' }).request, { account: 'fixture', kind: 'weekly' })
})

test('renders window and UTC-day model tokens without double-counting reasoning', () => {
  const html = renderToStaticMarkup(createElement(UsageDialogBody, {
    name: 'Claude', state: reduce(initialUsageDialogState(), { type: 'loaded', response: response() }),
    t: (key, params = {}) => en[key].replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? '')),
    titleId: 'usage-title', clearErrors: [], onAction() {}, onClear() {}, onClose() {},
  }))
  assert.match(html, /By day within this window \(UTC\)/)
  assert.match(html, /<time dateTime="2026-11-20">2026-11-20<\/time>/i)
  assert.match(html, /test-model/)
  assert.match(html, /17 tokens/)
  assert.match(html, /Input 3 · Output 5 · Cache read 7 · Cache write 2/)
  assert.match(html, /4 reasoning tokens, included in output/)
  assert.doesNotMatch(html, /21 tokens|estimated cost|\bUSD\b|request count/i)
})
