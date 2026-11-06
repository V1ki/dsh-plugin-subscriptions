import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadStore } from '../src/auth/store.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import { catalogStore } from '../src/providers/catalog-store.js'
import { defaultEffortOf, loadModelDefaults, modelDefaultsFilePath, modelDefaultsLoadError, resetModelDefaultsForTests } from '../src/model-defaults.js'
import { proxyFilePath, proxyGetConfig, resetProxyForTests } from '../src/http.js'

test('BOM-bearing JSON loads through all five stores; malformed JSON still follows each store’s error path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subscriptions-bom-'))
  const prior = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const write = async (file: string, text: string) => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '\uFEFF' + text)
  }
  try {
    const auth = join(dir, 'auth.json')
    await write(auth, JSON.stringify({ codex: { default: 'a', accounts: { a: { accessToken: 'dummy', refreshToken: 'dummy', accountId: 'a', expiresAt: 1 } } } }))
    assert.ok((await loadStore(auth)).codex?.accounts.a)
    await write(auth, '{')
    await assert.rejects(loadStore(auth))

    const settings = join(dir, 'settings.json')
    await write(settings, JSON.stringify({ providers: { grok: { displayName: 'sample' } }, toolHistory: [] }))
    assert.equal(new ProviderSettingsStore(settings).get('grok').displayName, 'sample')
    await write(settings, '{')
    assert.throws(() => new ProviderSettingsStore(settings))

    const catalog = join(dir, 'catalog.json')
    await write(catalog, JSON.stringify({ codex: { at: 1, models: [{ id: 'm', name: 'M' }] } }))
    assert.equal((await catalogStore('codex', catalog).load())?.models[0]?.id, 'm')
    await write(catalog, '{')
    assert.equal(await catalogStore('codex', catalog).load(), undefined)

    await resetModelDefaultsForTests()
    await write(modelDefaultsFilePath(), JSON.stringify({ codex: { m: 'high' } }))
    await loadModelDefaults()
    assert.equal(defaultEffortOf('codex', 'm'), 'high')
    await write(modelDefaultsFilePath(), '{')
    await resetModelDefaultsForTests()
    await loadModelDefaults()
    assert.ok(modelDefaultsLoadError())

    await resetProxyForTests()
    await write(proxyFilePath(), JSON.stringify({ enabled: false, url: '', bypass: ['example.invalid'] }))
    assert.deepEqual((await proxyGetConfig()).bypass, ['example.invalid'])
    await write(proxyFilePath(), '{')
    await resetProxyForTests()
    assert.ok((await proxyGetConfig()).error)
  } finally {
    await resetProxyForTests()
    await resetModelDefaultsForTests()
    if (prior === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prior
    await rm(dir, { recursive: true, force: true })
  }
})
