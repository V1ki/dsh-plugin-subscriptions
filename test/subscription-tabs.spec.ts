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
  assert.deepEqual(ids({}), ['claude', 'codex', 'copilot', 'glm', 'antigravity', 'grok', 'kimi', 'qwen'])
})

test('connected tabs precede disconnected tabs and sort by displayed name', () => {
  assert.deepEqual(ids({
    grok: connected(), copilot: connected('Alpha'), claude: disconnected('Zulu'), codex: disconnected(),
  }), ['copilot', 'grok', 'codex', 'glm', 'antigravity', 'kimi', 'qwen', 'claude'])
})

test('busy without an account remains disconnected; an empty alias uses the brand name', () => {
  assert.deepEqual(ids({ grok: { ...disconnected(''), busy: true }, antigravity: connected() }),
    ['antigravity', 'claude', 'codex', 'copilot', 'glm', 'grok', 'kimi', 'qwen'])
})

test('tab list has localized accessible labels', () => {
  assert.ok(en.providerTabs)
  assert.ok(zh.providerTabs)
})
