import './css-hook.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
const { sortedSubscriptionProviders } = await import('../src/client/SubscriptionsSection.js')
import type { ProviderStatus } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

const connected = (displayName?: string): ProviderStatus => ({
  busy: false, accounts: [{ key: 'account', isDefault: true }], ...(displayName === undefined ? {} : { displayName }),
})
const disconnected = (displayName?: string): ProviderStatus => ({ busy: false, accounts: [], ...(displayName === undefined ? {} : { displayName }) })
const ids = (statuses: Parameters<typeof sortedSubscriptionProviders>[0]) =>
  sortedSubscriptionProviders(statuses).map(provider => provider.id)

test('tabs are alphabetic when no account is connected', () => {
  assert.deepEqual(ids({}), ['claude', 'codex', 'copilot', 'antigravity', 'grok', 'qwen-subscription'])
})

test('connected tabs precede disconnected tabs and sort by displayed name', () => {
  assert.deepEqual(ids({
    grok: connected(), copilot: connected('Alpha'), claude: disconnected('Zulu'), codex: disconnected(),
  }), ['copilot', 'grok', 'codex', 'antigravity', 'qwen-subscription', 'claude'])
})

test('busy without an account remains disconnected; an empty alias uses the brand name', () => {
  assert.deepEqual(ids({ grok: { ...disconnected(''), busy: true }, antigravity: connected() }),
    ['antigravity', 'claude', 'codex', 'copilot', 'grok', 'qwen-subscription'])
})

test('Qwen appears among connected providers and respects its alias', () => {
  assert.equal(ids({ 'qwen-subscription': connected('Aardvark') })[0], 'qwen-subscription')
})

test('tab list has localized accessible labels', () => {
  assert.ok(en.providerTabs)
  assert.ok(zh.providerTabs)
  for (const locale of [en, zh]) {
    assert.ok(locale.deviceCodeUnavailable)
    assert.doesNotMatch(locale.deviceCodePrompt, /GitHub/i)
    assert.doesNotMatch(locale.deviceCodeOpenPage, /GitHub/i)
  }
})
