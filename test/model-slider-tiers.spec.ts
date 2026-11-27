import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelSliderStops, sliderProviderTarget, type SliderGroup } from '../src/client/model-slider-tiers.js'

function group(provider: string, ...ids: string[]): SliderGroup {
  return { provider, models: ids.map(id => ({ id })) }
}

test('Codex orders live families by tier, not generation, version-sorting siblings numerically', () => {
  const groups = [
    group('codex', 'gpt-6.2-astra', 'gpt-6.10-sol', 'gpt-5.6-terra', 'gpt-6.2-sol', 'gpt-6-luna', 'gpt-6.1-terra'),
    group('copilot', 'gpt-7-luna', 'gpt-7-astra'),
  ]
  assert.deepEqual(modelSliderStops(groups, { provider: 'codex', model: 'gpt-6-luna' }), [
    { id: 'gpt-6-luna', name: 'Luna', premium: false },
    { id: 'gpt-6.1-terra', name: 'Terra', premium: false },
    { id: 'gpt-6.10-sol', name: 'Sol', premium: false },
    { id: 'gpt-6.2-astra', name: 'Astra', premium: true },
  ])
})

test('Codex preserves the exact selected sibling and skips tiers missing from the provider', () => {
  const groups = [
    { provider: 'codex', models: [
      { id: 'gpt-6.2-sol' },
      { id: 'gpt-5.6-sol', name: 'My Sol' },
      { id: 'gpt-6.3-sol' },
      { id: 'gpt-6-luna' },
    ] },
    group('copilot', 'gpt-6.2-astra', 'gpt-6.1-terra'),
  ]
  assert.deepEqual(modelSliderStops(groups, { provider: 'codex', model: 'gpt-5.6-sol' }), [
    { id: 'gpt-6-luna', name: 'Luna', premium: false },
    { id: 'gpt-5.6-sol', name: 'My Sol', premium: false },
  ])
})

test('Claude recognizes both legacy and family-first IDs; generations outrank dates', () => {
  const groups = [group('claude',
    'claude-fable-5', 'claude-fable-5-2',
    'claude-opus-5-5', 'claude-3-opus-20240229', 'claude-opus-5',
    'claude-sonnet-5-5', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001', 'claude-haiku-5-5',
  )]
  assert.deepEqual(modelSliderStops(groups, { provider: 'claude', model: 'claude-3-5-sonnet-20241022' }), [
    { id: 'claude-haiku-5-5', name: 'Haiku', premium: false },
    { id: 'claude-3-5-sonnet-20241022', name: 'Sonnet', premium: false },
    { id: 'claude-opus-5-5', name: 'Opus', premium: false },
    { id: 'claude-fable-5-2', name: 'Fable', premium: true },
  ])
})

test('Claude dates break ties within a generation', () => {
  const groups = [group('claude', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620', 'claude-3-haiku-20240307')]
  const stops = modelSliderStops(groups, { provider: 'claude', model: 'claude-3-haiku-20240307' })
  assert.deepEqual(stops.map(stop => stop.id), ['claude-3-haiku-20240307', 'claude-3-5-sonnet-20241022'])
})

test('no slider when selection is null, unrecognized, unavailable, or on an unsupported provider', () => {
  const groups = [
    group('codex', 'gpt-5.4', 'gpt-6-luna', 'gpt-6.2-sol'),
    group('copilot', 'gpt-6-luna', 'gpt-6.2-sol', 'gpt-5.6-sol'),
  ]
  assert.deepEqual(modelSliderStops(groups, null), [])
  assert.deepEqual(modelSliderStops(groups, { provider: 'codex', model: 'gpt-5.4' }), [])
  assert.deepEqual(modelSliderStops(groups, { provider: 'codex', model: 'gpt-5.6-sol' }), [])
  assert.deepEqual(modelSliderStops(groups, { provider: 'copilot', model: 'gpt-6.2-sol' }), [])
})

test('at least two distinct tiers must be available', () => {
  const groups = [group('codex', 'gpt-5.6-sol', 'gpt-6.2-sol', 'gpt-5.4')]
  assert.deepEqual(modelSliderStops(groups, { provider: 'codex', model: 'gpt-6.2-sol' }), [])
})

test('provider target restores the exact recognized model before considering the balanced family', () => {
  const groups = [
    group('codex', 'gpt-6.2-sol', 'gpt-6.2-astra'),
    { provider: 'codex', models: [{ id: 'gpt-5.6-astra', name: 'Remembered Astra' }] },
  ]
  assert.deepEqual(sliderProviderTarget(groups, 'codex', 'gpt-5.6-astra'), {
    id: 'gpt-5.6-astra', name: 'Remembered Astra', premium: true,
  })
})

test('Codex target uses the newest Sol when the remembered ID is unavailable or unrecognized', () => {
  const groups = [
    group('codex', 'gpt-6-luna', 'gpt-6.10-sol', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.4'),
    group('copilot', 'gpt-7-sol', 'gpt-5.6-sol'),
  ]
  const sol = { id: 'gpt-6.10-sol', name: 'Sol', premium: false }
  assert.deepEqual(sliderProviderTarget(groups, 'codex'), sol)
  assert.deepEqual(sliderProviderTarget(groups, 'codex', 'gpt-5.6-sol'), sol)
  assert.deepEqual(sliderProviderTarget(groups, 'codex', 'gpt-5.4'), sol)
})

test('Claude target uses the newest Sonnet when there is no remembered model', () => {
  const groups = [group('claude', 'claude-fable-5', 'claude-haiku-5',
    'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6', 'claude-3-5-sonnet-20241022')]
  assert.deepEqual(sliderProviderTarget(groups, 'claude'), {
    id: 'claude-sonnet-4-6', name: 'Sonnet', premium: false,
  })
})

test('provider target falls back to the first recognized family in ladder order', () => {
  const groups = [group('codex', 'gpt-6.2-astra', 'gpt-5.6-terra', 'gpt-6.2-terra')]
  assert.deepEqual(sliderProviderTarget(groups, 'codex', 'gpt-5.6-luna'), {
    id: 'gpt-6.2-terra', name: 'Terra', premium: false,
  })
})

test('provider target accepts a one-model catalog and is undefined with no recognized models', () => {
  assert.deepEqual(sliderProviderTarget([group('claude', 'claude-fable-5')], 'claude'), {
    id: 'claude-fable-5', name: 'Fable', premium: true,
  })
  const groups = [group('codex', 'gpt-5.4'), group('copilot', 'gpt-6.2-sol')]
  assert.equal(sliderProviderTarget(groups, 'codex', 'gpt-6.2-sol'), undefined)
})
