import './css-hook.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const { AntigravityRiskNotice, sortedSubscriptionProviders } = await import('../src/client/SubscriptionsSection.js')
import type { ProviderStatus } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

const connected = (displayName?: string): ProviderStatus => ({
  busy: false, accounts: [{ key: 'account', isDefault: true }], ...(displayName === undefined ? {} : { displayName }),
})
const disconnected = (displayName?: string): ProviderStatus => ({ busy: false, accounts: [], ...(displayName === undefined ? {} : { displayName }) })
const ids = (statuses: Parameters<typeof sortedSubscriptionProviders>[0]) =>
  sortedSubscriptionProviders(statuses).map(provider => provider.id)

test('tabs are alphabetic when no account is connected', () => {
  assert.deepEqual(ids({}), ['claude', 'codex', 'copilot', 'antigravity', 'grok'])
})

test('connected tabs precede disconnected tabs and sort by displayed name', () => {
  assert.deepEqual(ids({
    grok: connected(), copilot: connected('Alpha'), claude: disconnected('Zulu'), codex: disconnected(),
  }), ['copilot', 'grok', 'codex', 'antigravity', 'claude'])
})

test('busy without an account remains disconnected; an empty alias uses the brand name', () => {
  assert.deepEqual(ids({ grok: { ...disconnected(''), busy: true }, antigravity: connected() }),
    ['antigravity', 'claude', 'codex', 'copilot', 'grok'])
})

test('tab list has localized accessible labels', () => {
  assert.ok(en.providerTabs)
  assert.ok(zh.providerTabs)
})

test('disabled Antigravity sorts after enabled providers even with saved accounts, and renders bilingual risk notice', () => {
  assert.deepEqual(ids({
    antigravity: { ...connected(), enabled: false },
    grok: connected(),
    codex: disconnected(),
  }), ['grok', 'claude', 'codex', 'copilot', 'antigravity'])
  for (const dictionary of [en, zh]) {
    const html = renderToStaticMarkup(createElement(AntigravityRiskNotice, { t: key => dictionary[key] }))
    assert.ok(html.includes(dictionary.antigravityNoticeTitle))
    assert.ok(html.includes(dictionary.antigravityNoticeBody))
    assert.doesNotMatch(html, /dsh-agy-link/i)
  }
  assert.match(zh.antigravityNoticeBody, /用量/)
  assert.match(en.antigravityNoticeBody, /usage/i)
})
