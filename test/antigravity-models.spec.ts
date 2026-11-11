import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupAntigravityModels, selectAntigravityVariant } from '../src/providers/antigravity-models.js'

test('explicit Gemini and Claude variants expose one model and only advertised efforts', () => {
  const input = [
    { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)', contextWindow: 200000, maxOutputTokens: 16000 },
    { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', contextWindow: 100000, maxOutputTokens: 8000 },
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon Medium' },
    { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon High' },
    { id: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 Low' },
    { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 Medium' },
    { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 High' },
  ]
  const snapshot = structuredClone(input)
  const groups = groupAntigravityModels(input)
  assert.deepEqual(input, snapshot, 'normalization does not mutate the cached catalog')
  assert.deepEqual(groups.map(model => [model.id, model.name, model.reasoning?.efforts.map(effort => effort.id)]), [
    ['claude-opus-5-5', 'Claude Opus 5.5', ['low', 'high']],
    ['gemini-4-argon', 'Gemini 4 Argon', ['medium', 'high']],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', ['low', 'medium', 'high']],
  ])
  assert.equal(groups[0].contextWindow, 100000)
  assert.equal(groups[0].maxOutputTokens, 8000)
  assert.equal(selectAntigravityVariant(groups[0], 'low').id, 'claude-opus-5-5-low')
  assert.equal(selectAntigravityVariant(groups[0]).id, 'claude-opus-5-5-high')
  assert.throws(() => selectAntigravityVariant(groups[0], 'medium'), /does not support/)
  assert.throws(() => selectAntigravityVariant(groups[0], 'constructor'), /does not support/)
})

test('unrelated models with identical names and unknown effort-like ids stay separate', () => {
  const groups = groupAntigravityModels([
    { id: 'unknown-low', name: 'Same' }, { id: 'unknown-high', name: 'Same' },
    { id: 'gemini-3-flash', name: 'Same' }, { id: 'gemini-3.5-flash-lite', name: 'Same' },
  ])
  assert.equal(groups.length, 4)
  assert.ok(groups.every(group => group.variants === undefined))
})

test('cached internal and known retired ids are hidden without generating new variants', () => {
  const groups = groupAntigravityModels([
    ...['tab_jump_flash_lite_preview', 'chat_23310', 'gemini-2.5-flash', 'gemini-3.5-flash-low', 'gemini-3-flash-agent', 'gemini-3-image', 'gemini-3-tts', 'model-disabled'].map(id => ({ id, name: id })),
    { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash (Tiered)' },
  ])
  assert.deepEqual(groups.map(group => group.id), ['gemini-3.8-flash-tiered'])
  assert.equal(groups[0].variants, undefined, 'a tiered name alone is not evidence of callable variants')
})

test('groups retain only the variants available in their account', () => {
  const alice = groupAntigravityModels([{ id: 'gemini-4-argon-low', name: 'Argon Low' }, { id: 'gemini-4-argon-high', name: 'Argon High' }])[0]
  const bob = groupAntigravityModels([{ id: 'gemini-4-argon-high', name: 'Argon High' }])[0]
  assert.equal(selectAntigravityVariant(alice, 'low').id, 'gemini-4-argon-low')
  assert.throws(() => selectAntigravityVariant(bob, 'low'), /does not support/)
})

test('non-selectable category routes do not become synthetic model ids', () => {
  const groups = groupAntigravityModels([
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', antigravity: { visible: true, thinkingLevel: 'HIGH' } },
    { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash Tiered', antigravity: { visible: false, thinkingLevel: 'HIGH' } },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', antigravity: { visible: false, thinkingLevel: 'LOW' } },
  ])
  assert.deepEqual(groups.map(model => [model.id, model.name]), [['gemini-3.8-flash', 'Gemini 3.8 Flash']])
})

test('reported cache shows the five native model families without duplicate Flash or Pro aliases', async () => {
  const { antigravityCatalogCache } = await import('./fixtures/antigravity-catalog-cache.js')
  const groups = groupAntigravityModels(antigravityCatalogCache)
  assert.deepEqual(groups.map(model => [model.id, model.name]), [
    ['gemini-4-argon', 'Gemini 4 Argon'], ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
    ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['gpt-oss-120b', 'GPT-OSS 120B'],
  ])
})
