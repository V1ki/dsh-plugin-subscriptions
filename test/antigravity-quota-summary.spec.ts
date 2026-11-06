import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AntigravityQuotaSummary } from '../src/client/AntigravityQuotaSummary.js'
import { en, zh } from '../src/client/locales.js'
import { parseAntigravityQuotaSummary } from '../src/providers/antigravity-usage.js'
import { antigravityQuotaSummary } from './fixtures/antigravity-quota-summary.js'

test('quota bars use the same horizontal track as other subscriptions and fill the remaining share', () => {
  const html = renderToStaticMarkup(createElement(AntigravityQuotaSummary, {
    windows: [
      { kind: 'weekly', scope: 'Gemini Models', usedPercent: 27 },
      { kind: 'session', scope: 'Gemini Models', usedPercent: 7 },
      { kind: 'weekly', scope: 'Claude and GPT models', usedPercent: 77 },
      { kind: 'session', scope: 'Claude and GPT models', usedPercent: 0 },
    ], t: (key, params) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')),
  }))
  for (const percent of [73, 93, 23, 100]) assert.ok(html.includes(`width:${percent}%`))
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 4)
  assert.ok(html.includes('height:4px') && html.includes('border-radius:2px'))
  assert.ok(!html.includes('<svg') && !html.includes('<circle'))
})

test('mixed summary keeps explicit model quotas visible without inventing a weekly window', () => {
  for (const dictionary of [en, zh]) {
    const html = renderToStaticMarkup(createElement(AntigravityQuotaSummary, {
      windows: [
        { kind: 'weekly', scope: 'Claude and GPT models', usedPercent: 75 },
        { kind: 'other', scope: 'gemini-4-argon-high', usedPercent: 4 },
      ],
      t: (key, params) => dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')),
    }))
    assert.ok(html.includes('gemini-4-argon-high'))
    assert.ok(html.includes(dictionary.usageRemaining.replace('{percent}', '96')))
    assert.equal((html.match(/role="progressbar"/g) ?? []).length, 2)
    assert.equal((html.match(new RegExp(dictionary.usageWeeklyLimit, 'g')) ?? []).length, 2, 'only the explicitly weekly shared row and its accessible label are weekly')
  }
})

test('summary renders the three provider groups with remaining allowance and accessible indicators', () => {
  const windows = parseAntigravityQuotaSummary(antigravityQuotaSummary())
  for (const dictionary of [en, zh]) {
    const html = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { windows,
      t: (key, params) => dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')),
    }))
    for (const title of [dictionary.usageGeminiModels, dictionary.usageClaudeGptModels, dictionary.usageArgon]) assert.ok(html.includes(title))
    assert.equal((html.match(/role="progressbar"/g) ?? []).length, 5)
    assert.equal((html.match(/aria-valuenow="99"/g) ?? []).length, 2)
    assert.equal((html.match(/aria-valuenow="100"/g) ?? []).length, 2)
    assert.equal((html.match(/aria-valuenow="67"/g) ?? []).length, 1)
    assert.ok(!html.includes('chat_') && !html.includes('tab_'))
  }
})
