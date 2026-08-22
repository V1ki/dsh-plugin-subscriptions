/**
 * The durable model-catalog store: per-provider round-trips over one file,
 * tolerance for missing/corrupt files, and strict snapshot validation (a
 * malformed persisted entry must read as absent, never flow into
 * resolveModel).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { catalogStore, sanitizeSnapshot } from '../src/providers/catalog-store.js'

async function tempStorePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dsh-models-')), 'models.json')
}

test('catalog store round-trips per-provider snapshots in one file', async () => {
  const path = await tempStorePath()
  const grok = catalogStore('grok', path)
  const codex = catalogStore('codex', path)
  await grok.save({
    at: 123,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500_000,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High Effort', description: 'extensive' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  await codex.save({ at: 456, models: [{ id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' }] })

  const loaded = await grok.load()
  assert.equal(loaded?.at, 123)
  assert.equal(loaded?.models[0].reasoning?.defaultEffort, 'high')
  assert.equal(loaded?.models[0].reasoning?.efforts[0].description, 'extensive')
  assert.equal((await codex.load())?.models[0].name, 'GPT-5.2 Codex')

  // Clearing one provider keeps the other.
  await grok.clear()
  assert.equal(await grok.load(), undefined)
  assert.equal((await codex.load())?.at, 456)
  // The file itself stays valid JSON (parse throws otherwise).
  JSON.parse(await readFile(path, 'utf8'))
})

test('catalog store tolerates missing and corrupt files', async () => {
  const path = await tempStorePath()
  const store = catalogStore('grok', path)
  // Missing file reads as absent; clear on a missing file is a no-op.
  assert.equal(await store.load(), undefined)
  await store.clear()
  // Corrupt JSON reads as absent instead of throwing.
  await writeFile(path, 'not json')
  assert.equal(await store.load(), undefined)
  // A corrupt file is still writable: save rebuilds it from scratch.
  await store.save({ at: 2, models: [{ id: 'g', name: 'G' }] })
  assert.equal((await store.load())?.at, 2)
})

test('sanitizeSnapshot drops malformed snapshots wholesale', () => {
  const model = { id: 'g', name: 'G' }
  const efforts = [{ id: 'high', name: 'High' }]
  // A valid snapshot passes through.
  assert.notEqual(sanitizeSnapshot({ at: 1, models: [model] }), undefined)
  assert.notEqual(
    sanitizeSnapshot({ at: 1, models: [{ ...model, reasoning: { efforts, defaultEffort: 'high' } }] }),
    undefined,
  )
  // The codex fast-tier flag round-trips; a non-boolean one drops the snapshot.
  assert.equal(
    sanitizeSnapshot({ at: 1, models: [{ ...model, fastTier: true }] })?.models[0].fastTier,
    true,
  )
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, fastTier: 'yes' }] }), undefined)
  // Copilot per-model modalities round-trip; malformed ones drop the snapshot.
  assert.deepEqual(
    sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: ['text', 'image'] }] })?.models[0].inputModalities,
    ['text', 'image'],
  )
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: [] }] }), undefined)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, inputModalities: ['video'] }] }), undefined)
  // The Copilot wire choice and dual-protocol flag round-trip (a snapshot
  // losing them would route every restarted model to the chat wire); a
  // malformed value drops the snapshot.
  const copilot = sanitizeSnapshot({
    at: 1,
    models: [{ ...model, copilotWire: 'responses', copilotResponses: true }],
  })?.models[0]
  assert.equal(copilot?.copilotWire, 'responses')
  assert.equal(copilot?.copilotResponses, true)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, copilotWire: 'grpc' }] }), undefined)
  assert.equal(sanitizeSnapshot({ at: 1, models: [{ ...model, copilotResponses: 'yes' }] }), undefined)
  for (const malformed of [
    undefined,
    null,
    'text',
    { at: 'soon', models: [model] },
    { at: 1, models: [] },
    { at: 1, models: [{ id: '', name: 'G' }] },
    { at: 1, models: [{ id: 'g', name: '' }] },
    { at: 1, models: [model, model] }, // duplicate ids
    { at: 1, models: [{ ...model, contextWindow: -5 }] },
    { at: 1, models: [{ ...model, description: 42 }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [{ id: 'high', name: '' }] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [{ id: '', name: 'High' }] } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts, defaultEffort: 'unknown' } }] },
    { at: 1, models: [{ ...model, reasoning: { efforts: [...efforts, ...efforts] } }] }, // duplicate efforts
  ]) {
    assert.equal(sanitizeSnapshot(malformed), undefined, JSON.stringify(malformed))
  }
})
