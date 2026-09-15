import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderSettingsStore, validatePreferences } from '../src/provider-settings.js'

test('provider selections survive refresh-independent reloads and concurrent provider saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-settings-'))
  try {
    const path = join(dir, 'settings.json')
    const store = new ProviderSettingsStore(path)
    assert.equal(store.visible('codex', 'future-model'), true)
    await Promise.all([
      store.set('codex', { visibleModels: ['gpt-6-astra'], contextWindows: { 'gpt-6-astra': 512000 } }),
      store.set('grok', { visibleModels: [] }),
    ])
    const reload = new ProviderSettingsStore(path)
    assert.equal(reload.visible('codex', 'gpt-6-astra'), true)
    assert.equal(reload.visible('codex', 'future-model'), false)
    assert.equal(reload.visible('grok', 'grok-4'), false)
    assert.equal(reload.contextWindow('gpt-6-astra'), 512000)
    await reload.set('codex', {})
    assert.equal(reload.visible('codex', 'future-model'), true)
    assert.equal(reload.contextWindow('gpt-6-astra'), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('tool policies retain old-session settings across changes and restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-tools-'))
  try {
    const path = join(dir, 'settings.json')
    const store = new ProviderSettingsStore(path)
    await store.set('codex', { tools: { image_generate: false, web_search: false } })
    const doc = JSON.parse(await readFile(path, 'utf8'))
    const at = doc.toolHistory[0].at as number
    const reload = new ProviderSettingsStore(path)
    assert.equal(reload.toolEnabled('codex', 'image_generate', at - 1), true)
    assert.equal(reload.toolEnabled('codex', 'image_generate', at + 1), false)
    assert.equal(reload.toolEnabled('codex', 'web_search', at + 1), false)
    assert.equal(reload.toolEnabled('grok', 'image_generate', at + 1), true)
    assert.equal(reload.toolEnabled('grok', 'x_search', at + 1), true)
    await new Promise(resolve => setTimeout(resolve, 5))
    await reload.set('codex', { tools: { image_generate: true, web_search: true } })
    const again = new ProviderSettingsStore(path)
    assert.equal(again.toolEnabled('codex', 'image_generate', at + 1), false)
    assert.equal(again.toolEnabled('codex', 'image_generate', Date.now() + 1), true)
    assert.equal(again.toolEnabled('codex', 'web_search', Date.now() + 1), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('provider settings reject invalid contexts and unsupported tools; ids are safe object keys', () => {
  for (const value of [0, -1, 1.2, Infinity, NaN, '500000']) {
    assert.throws(() => validatePreferences('codex', { contextWindows: { model: value } }))
  }
  assert.throws(() => validatePreferences('claude', { tools: { image_generate: false } }))
  assert.throws(() => validatePreferences('codex', { tools: { video_generate: true } }))
  assert.throws(() => validatePreferences('codex', { visibleModels: [null] }))
  const prefs = validatePreferences('codex', JSON.parse('{"contextWindows":{"__proto__":512000,"toString":123}}'))
  assert.equal(prefs.contextWindows?.['__proto__'], 512000)
  assert.equal(prefs.contextWindows?.['toString'], 123)
})

test('failed persistence leaves live settings unchanged and permits a later retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-failure-'))
  const { mkdir } = await import('node:fs/promises')
  const store = new ProviderSettingsStore(join(dir, 'settings.json'))
  // Put a directory at the target after construction to force atomic rename failure.
  await mkdir(store.path)
  try {
    await assert.rejects(store.set('codex', { visibleModels: [] }))
    assert.equal(store.visible('codex', 'm'), true)
    await rm(store.path, { recursive: true })
    await store.set('codex', { visibleModels: [] })
    assert.equal(store.visible('codex', 'm'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
