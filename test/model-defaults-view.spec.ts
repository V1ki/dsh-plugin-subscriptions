import './css-hook.js'
/**
 * Unit tests for the collapsible default-effort section's pure logic: which
 * models become rows, the counts the collapsed header reports, when the name
 * filter appears and what it matches (`deriveModelDefaultsView`), plus when
 * the catalog is (re)fetched (`shouldFetchModelDefaults` /
 * `modelDefaultsSignature`). No DOM and no React — these functions are the
 * whole contract the section renders and fetches from.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
const { deriveModelDefaultsView, modelDefaultsSignature, shouldFetchModelDefaults } = await import('../src/client/SubscriptionsSection.js')
import type {
  ModelDefaultsFetchInput,
  ModelDefaultView,
  ProviderStatus,
} from '../src/client/SubscriptionsSection.js'

/** One catalog entry; `configured` present only when an override is set. */
function model(id: string, name: string, efforts: string[], configured?: string): ModelDefaultView {
  return {
    id,
    name,
    efforts: efforts.map(effort => ({ id: effort, name: effort })),
    ...configured === undefined ? {} : { configured },
  }
}

/** A catalog of `count` reasoning models named `m0…`, plus optional dead ones. */
function catalog(count: number, withoutEfforts = 0): ModelDefaultView[] {
  return [
    ...Array.from({ length: count }, (_, index) => model(`m${index}`, `Model ${index}`, ['low', 'high'])),
    ...Array.from({ length: withoutEfforts }, (_, index) => model(`d${index}`, `Dead ${index}`, [])),
  ]
}

test('a loading catalog derives an empty section rather than throwing', () => {
  const view = deriveModelDefaultsView(undefined, '')
  assert.deepEqual(view, { shown: [], total: 0, overridden: 0, withoutEfforts: 0, showFilter: false })
})

test('only models with reasoning levels become rows; the rest ride as one count', () => {
  const view = deriveModelDefaultsView(catalog(2, 3), '')
  assert.deepEqual(view.shown.map(entry => entry.id), ['m0', 'm1'])
  assert.equal(view.total, 2, 'the header total counts reasoning models only')
  assert.equal(view.withoutEfforts, 3, 'three dead models collapse into one count line')
})

test('the header counts the configured overrides, not the effective defaults', () => {
  const models = [
    model('a', 'A', ['low', 'high'], 'high'),
    model('b', 'B', ['low', 'high']),
    // An advertised default with no override must not count as overridden.
    { ...model('c', 'C', ['low', 'high']), effective: 'low' },
    // A dead model can never be overridden, so it stays out of both counts.
    model('d', 'D', [], 'high'),
  ]
  const view = deriveModelDefaultsView(models, '')
  assert.equal(view.total, 3)
  assert.equal(view.overridden, 1)
  assert.equal(view.withoutEfforts, 1)
})

test('the filter box appears only past the threshold, counting reasoning models', () => {
  assert.equal(deriveModelDefaultsView(catalog(8), '').showFilter, false, '8 models still scan fine')
  assert.equal(deriveModelDefaultsView(catalog(9), '').showFilter, true)
  // Dead models pad the catalog but never earn a filter: they are one line.
  assert.equal(deriveModelDefaultsView(catalog(3, 40), '').showFilter, false)
})

test('the filter matches display name or model id, case- and space-insensitively', () => {
  const models = [
    model('gpt-5.6-sol', 'GPT-5.6 Sol', ['low']),
    model('claude-sonnet-5', 'Claude Sonnet 5', ['low']),
    model('claude-opus-5', 'Claude Opus 5', ['low']),
  ]
  assert.deepEqual(
    deriveModelDefaultsView(models, '  SONNET ').shown.map(entry => entry.id),
    ['claude-sonnet-5'],
    'the query is trimmed and lowercased before matching',
  )
  assert.deepEqual(
    deriveModelDefaultsView(models, 'claude-').shown.map(entry => entry.id),
    ['claude-sonnet-5', 'claude-opus-5'],
    'the id matches even when the display name does not contain the query',
  )
  assert.deepEqual(deriveModelDefaultsView(models, 'gpt').shown.map(entry => entry.id), ['gpt-5.6-sol'])
})

test('a filter that matches nothing empties the rows but keeps the header counts', () => {
  const view = deriveModelDefaultsView(catalog(9, 2), 'no-such-model')
  assert.deepEqual(view.shown, [], 'the list renders the empty-filter notice instead of rows')
  assert.equal(view.total, 9, 'the header still reports the unfiltered total')
  assert.equal(view.withoutEfforts, 2)
  assert.equal(view.showFilter, true, 'the filter box must not vanish under its own query')
})

test('a blank filter is not a query: every reasoning model stays shown', () => {
  const models = catalog(3)
  assert.equal(deriveModelDefaultsView(models, '   ').shown.length, 3)
})

/** One provider status carrying `keys` as its account list. */
function status(...keys: string[]): ProviderStatus {
  return { busy: false, accounts: keys.map((key, index) => ({ key, isDefault: index === 0 })) }
}

/** Base fetch-decision input: codex logged in and open, nothing loaded yet. */
function fetchInput(overrides: Partial<ModelDefaultsFetchInput> = {}): ModelDefaultsFetchInput {
  return {
    loggedIn: ['codex'],
    open: ['codex'],
    loadedFor: undefined,
    signature: 'sig-1',
    failed: false,
    ...overrides,
  }
}

test('shouldFetchModelDefaults: an open disclosure fetches once, then stays put', () => {
  assert.equal(shouldFetchModelDefaults(fetchInput()), true, 'first open fetches')
  assert.equal(
    shouldFetchModelDefaults(fetchInput({ loadedFor: 'sig-1' })),
    false,
    'the answered signature latches the attempt, so re-renders do not refetch',
  )
})

test('shouldFetchModelDefaults: an empty answer still counts as loaded', () => {
  // Regression: deriving "loaded" from a non-empty payload re-ran the fetch on
  // every render whenever the node half legitimately answered nothing (a
  // narrowed config.providers, or a catalog that was briefly unavailable).
  assert.equal(
    shouldFetchModelDefaults(fetchInput({ loadedFor: 'sig-1' })),
    false,
    'an empty catalog is a result, not a missing load',
  )
})

test('shouldFetchModelDefaults: a collapsed page never pays for the catalog', () => {
  assert.equal(shouldFetchModelDefaults(fetchInput({ open: [] })), false)
  // Open, but for a provider that has no account: nothing to ask about.
  assert.equal(shouldFetchModelDefaults(fetchInput({ open: ['claude'] })), false)
})

test('shouldFetchModelDefaults: a new account refetches so an open card is never stale', () => {
  // Regression: connecting a second provider after the first load left that
  // card showing the previous answer (no models, and no way to recover).
  assert.equal(
    shouldFetchModelDefaults(fetchInput({
      loggedIn: ['codex', 'claude'],
      open: ['codex', 'claude'],
      loadedFor: 'sig-1',
      signature: 'sig-2',
    })),
    true,
    'a changed account signature invalidates the previous answer',
  )
})

test('shouldFetchModelDefaults: a failure latches until the retry clears it', () => {
  assert.equal(shouldFetchModelDefaults(fetchInput({ failed: true })), false, 'no retry storm')
  assert.equal(shouldFetchModelDefaults(fetchInput({ failed: false })), true, 'Retry clears the latch')
})

test('shouldFetchModelDefaults: a logged-out page asks for nothing', () => {
  assert.equal(shouldFetchModelDefaults(fetchInput({ loggedIn: [], open: ['codex'] })), false)
})

test('modelDefaultsSignature: tracks accounts, not order or provider identity alone', () => {
  const one = modelDefaultsSignature({ codex: status('a') })
  assert.equal(modelDefaultsSignature({ codex: status('a') }), one, 'stable across renders')
  assert.notEqual(modelDefaultsSignature({ codex: status('a', 'b') }), one, 'an added account shows')
  assert.notEqual(modelDefaultsSignature({ claude: status('a') }), one, 'the provider is part of it')
  assert.equal(
    modelDefaultsSignature({ codex: status('b', 'a') }),
    modelDefaultsSignature({ codex: status('a', 'b') }),
    'account order is not significant',
  )
  assert.equal(modelDefaultsSignature({}), modelDefaultsSignature({ codex: status() }), 'no accounts reads as empty')
})
