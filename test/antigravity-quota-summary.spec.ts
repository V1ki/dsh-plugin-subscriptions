import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AntigravityQuotaSummary } from '../src/client/AntigravityQuotaSummary.js'
import { en, zh } from '../src/client/locales.js'
import { parseAntigravityQuotaSummary } from '../src/providers/antigravity-usage.js'
import { antigravityQuotaSummary } from './fixtures/antigravity-quota-summary.js'

test('quota bars use the same horizontal track and follow used/remaining display mode and warning colors', () => {
  const windows = [
    { kind: 'weekly' as const, scope: 'Gemini Models', usedPercent: 27 },
    { kind: 'session' as const, scope: 'Gemini Models', usedPercent: 7 },
    { kind: 'weekly' as const, scope: 'Claude and GPT models', usedPercent: 85 },
    { kind: 'session' as const, scope: 'Claude and GPT models', usedPercent: 0 },
  ]
  const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
    en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

  const usedHtml = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { windows, t }))
  for (const percent of [27, 7, 85, 0]) {
    assert.ok(usedHtml.includes(`width:${percent}%`))
    assert.ok(usedHtml.includes(t('quotaUsedPercent', { percent })))
  }
  assert.ok(usedHtml.includes('var(--dsw-alias-state-warn-label)'))

  const remainingHtml = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { windows, t, mode: 'remaining' }))
  for (const percent of [73, 93, 15, 100]) {
    assert.ok(remainingHtml.includes(`width:${percent}%`))
    assert.ok(remainingHtml.includes(t('quotaRemainingPercent', { percent })))
  }
  assert.ok(remainingHtml.includes('var(--dsw-alias-state-warn-label)'), 'warning color still reflects high usage in remaining mode')
  assert.equal((remainingHtml.match(/role="progressbar"/g) ?? []).length, 4)
  assert.ok(remainingHtml.includes('height:4px') && remainingHtml.includes('border-radius:2px'))
  assert.ok(!remainingHtml.includes('<svg') && !remainingHtml.includes('<circle'))
})

test('mixed summary keeps explicit model quotas visible without inventing a weekly window in both modes', () => {
  for (const dictionary of [en, zh]) {
    const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const windows = [
      { kind: 'weekly' as const, scope: 'Claude and GPT models', usedPercent: 75 },
      { kind: 'other' as const, scope: 'gemini-4-argon-high', usedPercent: 4 },
    ]
    const usedHtml = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { windows, t, mode: 'used' }))
    assert.ok(usedHtml.includes('gemini-4-argon-high'))
    assert.ok(usedHtml.includes(dictionary.quotaUsedPercent.replace('{percent}', '4')))

    const remainingHtml = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { windows, t, mode: 'remaining' }))
    assert.ok(remainingHtml.includes('gemini-4-argon-high'))
    assert.ok(remainingHtml.includes(dictionary.quotaRemainingPercent.replace('{percent}', '96')))
    assert.equal((remainingHtml.match(/role="progressbar"/g) ?? []).length, 2)
    assert.equal((remainingHtml.match(new RegExp(dictionary.usageWeeklyLimit, 'g')) ?? []).length, 2, 'only the explicitly weekly shared row and its accessible label are weekly')
  }
})

test('summary renders the three provider groups with accessible indicators for both used and remaining modes', () => {
  const windows = parseAntigravityQuotaSummary(antigravityQuotaSummary())
  for (const dictionary of [en, zh]) {
    const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const usedHtml = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { windows, t }))
    for (const title of [dictionary.usageGeminiModels, dictionary.usageClaudeGptModels, dictionary.usageArgon]) assert.ok(usedHtml.includes(title))
    assert.equal((usedHtml.match(/aria-valuenow="1"/g) ?? []).length, 2)
    assert.equal((usedHtml.match(/aria-valuenow="0"/g) ?? []).length, 2)
    assert.equal((usedHtml.match(/aria-valuenow="33"/g) ?? []).length, 1)

    const remainingHtml = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { windows, t, mode: 'remaining' }))
    assert.equal((remainingHtml.match(/role="progressbar"/g) ?? []).length, 5)
    assert.equal((remainingHtml.match(/aria-valuenow="99"/g) ?? []).length, 2)
    assert.equal((remainingHtml.match(/aria-valuenow="100"/g) ?? []).length, 2)
    assert.equal((remainingHtml.match(/aria-valuenow="67"/g) ?? []).length, 1)
    assert.ok(!remainingHtml.includes('chat_') && !remainingHtml.includes('tab_'))
  }
})
