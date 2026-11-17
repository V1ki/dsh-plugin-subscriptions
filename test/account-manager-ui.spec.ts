import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountModelRows, accountPoolSelection, mergeAccountChanges, mergeLatestAccounts } from '../src/client/account-preferences.js'
import { en, zh } from '../src/client/locales.js'

const models = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
test('account pool defaults include newly discovered models; [] includes none', () => {
  assert.deepEqual([...accountPoolSelection({}, models)], ['a', 'b'])
  assert.deepEqual([...accountPoolSelection({ poolModels: [] }, models)], [])
  assert.deepEqual([...accountPoolSelection({ poolModels: ['a'] }, models)], ['a'])
})
test('saved unavailable model IDs remain editable without inventing discovered models', () => {
  assert.deepEqual(accountModelRows({ key: 'personal', label: 'Personal', models: [] }, { poolModels: ['gone'] }), [
    { id: 'gone', name: 'gone', unavailable: true },
  ])
})
test('Antigravity account editor maps legacy choices only to discovered family rows', () => {
  const family = 'claude-sonnet-5-5'
  const catalog = [{ id: family, name: 'Sonnet' }, { id: 'gemini-4-hydrogen', name: 'Hydrogen' }]
  const preferences = { poolModels: [`${family}-low`, `${family}-high`, 'gemini-4-hydrogen-xhigh', 'gemini-3.8-flash-tiered', 'missing-high'] }
  const original = structuredClone(preferences)
  const selected = accountPoolSelection(preferences, catalog, 'antigravity')
  assert.deepEqual([...selected], [family, 'gemini-4-hydrogen', 'gemini-3.8-flash-tiered', 'missing-high'])
  assert.deepEqual(accountModelRows({ key: 'primary', label: 'Primary', models: catalog }, preferences, 'antigravity'), [
    ...catalog.map(model => ({ ...model, unavailable: false })),
    { id: 'gemini-3.8-flash-tiered', name: 'gemini-3.8-flash-tiered', unavailable: true },
    { id: 'missing-high', name: 'missing-high', unavailable: true },
  ])
  selected.delete(family)
  const saved = mergeAccountChanges({ accounts: { primary: preferences } }, { primary: { poolModels: [...selected] } })
  assert.equal(accountPoolSelection(saved.accounts!.primary, catalog, 'antigravity').has(family), false, 'unchecking the family must not resurrect a hidden legacy selection')
  assert.deepEqual(accountPoolSelection(preferences, [], 'antigravity'), new Set(preferences.poolModels), 'an unavailable catalog must not erase or migrate saved IDs')
  assert.deepEqual(accountPoolSelection(preferences, catalog, 'codex'), new Set(preferences.poolModels))
  assert.deepEqual(preferences, original)
})

test('Antigravity account editor preserves concrete manual catalogs and explicit exclusions', () => {
  const family = 'claude-sonnet-5-5'
  const concrete = { id: `${family}-low`, name: 'Sonnet Low' }
  const account = { key: 'primary', label: 'Primary', models: [concrete, { id: family, name: 'Sonnet' }] }
  const preferences = { poolModels: [concrete.id] }
  assert.deepEqual([...accountPoolSelection(preferences, account.models, 'antigravity')], [concrete.id])
  assert.deepEqual(accountModelRows(account, preferences, 'antigravity'), account.models.map(model => ({ ...model, unavailable: false })))
  assert.deepEqual([...accountPoolSelection({}, account.models, 'antigravity')], account.models.map(model => model.id))
  assert.deepEqual([...accountPoolSelection({ poolModels: [] }, account.models, 'antigravity')], [])
})

test('model editor saves latest accounts, not its old draft, including removal', () => {
  const draft = { visibleModels: ['a'], accounts: { personal: { alias: 'Old' } } }
  assert.deepEqual(mergeLatestAccounts(draft, { accounts: { personal: { alias: 'New', poolEnabled: false } } }), {
    visibleModels: ['a'], accounts: { personal: { alias: 'New', poolEnabled: false } },
  })
  assert.deepEqual(mergeLatestAccounts(draft, {}), { visibleModels: ['a'] })
  assert.equal(draft.accounts.personal.alias, 'Old')
})
test('account manager preserves latest other settings and untouched accounts', () => {
  const latest = { visibleModels: [], tools: { image_generate: false }, contextWindows: { a: 1000 },
    accounts: { work: { alias: 'Work' }, personal: { alias: 'Old' } } }
  assert.deepEqual(mergeAccountChanges(latest, { personal: { poolEnabled: false, independentEntry: true, poolModels: [] } }), {
    ...latest, accounts: { work: { alias: 'Work' }, personal: { poolEnabled: false, independentEntry: true, poolModels: [] } },
  })
  assert.equal(latest.accounts.personal.alias, 'Old')
})
test('account manager has bilingual copy and explicitly limits isolation claims', () => {
  for (const key of Object.keys(en).filter(key => key.startsWith('accounts')) as (keyof typeof en)[]) {
    assert.ok(en[key].length)
    assert.ok(zh[key].length)
  }
  assert.match(en.accountsHint, /only to LLM routing/)
  assert.match(en.accountsIndependentHint, /no fallback/)
  assert.match(zh.accountsIndependentHint, /不会回退/)
})
