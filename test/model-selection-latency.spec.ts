import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AntigravityAdapter } from '../src/providers/antigravity.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { AccountPreferencesAdapter } from '../src/providers/account-preferences.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import { accountCatalogStore, catalogStore } from '../src/providers/catalog-store.js'
import { CodexAdapter } from '../src/providers/codex.js'
import { saveAccountSession } from '../src/auth/store.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'
import type { AntigravitySession } from '../src/auth/store.js'
import type { CatalogSnapshot, FetchFn } from '../src/providers/common.js'

function memoryStore(at = 1) {
  let value: CatalogSnapshot | undefined = { at, models: [{ id: 'gemini-cached', name: 'Cached', contextWindow: 1000 }] }
  return { load: async () => value, save: async (v: CatalogSnapshot) => { value = v }, clear: async () => { value = undefined } }
}
function accounts() {
  const entries = new Map<string, AntigravitySession>(['a', 'b'].map(key => [key, {
    accessToken: key, refreshToken: key, expiresAt: Date.now() + 3600_000, account: key, projectId: key,
  } satisfies AntigravitySession]))
  const tokens = new AccountTokenManager<AntigravitySession>({
    provider: 'antigravity', displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: async value => value, isPermanent: () => false }),
    io: { list: async () => [...entries].map(([key, session]) => ({ key, session })),
      get: async key => entries.get(key ?? 'a'), save: async (key, value) => { entries.set(key, value) }, remove: async key => { entries.delete(key) } },
  })
  return { entries, tokens }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('native registry can list and resolve cached account models before a stalled refresh completes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'picker-latency-'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const stores = { a: memoryStore(), b: memoryStore() }
  const { tokens, entries } = accounts()
  let fetches = 0, changed = 0
  const options = {
    models: [], discovery: true, streamIdleTimeoutMs: 1000, tokens,
    catalogStore: stores.a, accountCatalogStore: () => stores.b,
    onCatalogChanged: () => { changed++ },
    fetchFn: (async () => { fetches++; await gate; return Response.json({ models: { 'gemini-new': { displayName: 'New', inputTokenLimit: 2000 } } }) }) as FetchFn,
  }
  const raw = new AntigravityAdapter(options)
  const settings = new ProviderSettingsStore(join(home, 'settings.json'))
  const route = new AccountPreferencesAdapter({ provider: 'antigravity', adapter: raw, settings,
    accounts: async () => [...entries.keys()].map(key => ({ key, label: key })), pool: () => undefined })
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  llm.registerAdapter(['antigravity'], route)
  // Startup/hourly discovery is independent of menu reads.
  const refreshes = ['a', 'b'].map(key => raw.listOwnModels('antigravity', key))
  const start = performance.now()
  const selection = (async () => {
    const models = await llm.listModels('antigravity')
    assert.ok(models.some(model => model.id === 'gemini-cached'))
    return llm.resolveModelInfo('antigravity', 'gemini-cached')
  })()
  try {
    const result = await Promise.race([selection, pause(500).then(() => undefined)])
    t.diagnostic(`cached registry selection: ${Math.round(performance.now() - start)} ms; network still blocked`)
    assert.ok(result, 'cached selection must finish while the catalog network request is still blocked')
    assert.equal(result.context?.contextWindow, 1000)
    assert.equal(fetches, 2, 'one coalesced refresh per account')
    release()
    for (let i = 0; i < 100 && changed < 2; i++) await pause(5)
    assert.equal(changed, 2, 'changed background catalogs notify the registered menu')
    assert.deepEqual((await route.listModels('antigravity')).map(model => model.id), ['gemini-new'])
    entries.clear()
    assert.deepEqual(await route.listModels('antigravity'), [], 'logged-out accounts cannot use persisted catalogs')
  } finally {
    release()
    await selection.catch(() => undefined)
    await Promise.allSettled(refreshes)
    await rm(home, { recursive: true, force: true })
  }
})

test('non-default Antigravity catalogs survive restart and explicit refresh still waits for new data', async () => {
  const { tokens } = accounts()
  const stores = { a: memoryStore(Date.now()), b: memoryStore(Date.now()) }
  let release!: () => void
  let fetches = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const options = { models: [], discovery: true, streamIdleTimeoutMs: 1000, tokens,
    catalogStore: stores.a, accountCatalogStore: () => stores.b,
    fetchFn: (async () => { fetches++; await gate; return Response.json({ models: { fresh: {} } }) }) as FetchFn }
  const raw = new AntigravityAdapter(options)
  try {
    const initial = raw.listOwnModels('antigravity', 'b')
    const result = await Promise.race([initial, pause(100).then(() => undefined)])
    assert.ok(result, 'the second account should seed its own saved catalog after restart')
    assert.equal(fetches, 0)
    raw.clearAccountCatalog('b')
    await pause(0)
    assert.equal(await stores.b.load(), undefined)
    let settled = false
    const forced = raw.listOwnModels('antigravity', 'b').then(value => { settled = true; return value })
    await pause(20)
    assert.equal(settled, false)
    release()
    assert.deepEqual((await forced).map(model => model.id), ['fresh'])
  } finally { release() }
})

test('simultaneous provider and secondary-account snapshots survive in the shared catalog file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'catalog-concurrent-'))
  const path = join(home, 'models.json')
  const stores = [catalogStore('codex', path), catalogStore('grok', path), catalogStore('antigravity', path), accountCatalogStore('antigravity', 'second', path)]
  try {
    await Promise.all(stores.map((store, index) => store.save({ at: 1, models: [{ id: `m${index}`, name: `M${index}` }] })))
    for (const [index, store] of stores.entries()) assert.equal((await store.load())?.models[0].id, `m${index}`)
    await Promise.all([stores[0].clear(), stores[3].save({ at: 2, models: [{ id: 'updated', name: 'Updated' }] })])
    assert.equal(await stores[0].load(), undefined)
    assert.equal((await stores[3].load())?.models[0].id, 'updated')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('the installed plugin route resolves pooled models without waiting for another provider catalog', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pool-picker-latency-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  const prototypes = [CodexAdapter.prototype, AntigravityAdapter.prototype] as unknown as { fetchCatalog: (...args: unknown[]) => Promise<unknown[]> }[]
  const originals = prototypes.map(value => value.fetchCatalog)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  for (const prototype of prototypes) prototype.fetchCatalog = async () => { await gate; return [] }
  const runtime = ctx.plugin(plugin, { providers: ['codex', 'antigravity'] })
  let selection: Promise<unknown> | undefined
  try {
    await saveAccountSession('codex', 'c', { accessToken: 'c', refreshToken: 'c', expiresAt: Date.now() + 3600_000, accountId: 'c' })
    for (const key of ['a', 'b']) await saveAccountSession('antigravity', key, { accessToken: key, refreshToken: key, expiresAt: Date.now() + 3600_000, account: key, projectId: key })
    await catalogStore('codex').save({ at: 1, models: [{ id: 'c', name: 'C' }] })
    await catalogStore('antigravity').save({ at: 1, models: [{ id: 'm', name: 'M', contextWindow: 1000 }] })
    await accountCatalogStore('antigravity', 'b').save({ at: 1, models: [{ id: 'm', name: 'M', contextWindow: 900 }] })
    for (let i = 0; i < 100 && !connection.registered(); i++) await pause(5)
    assert.ok(connection.registered())
    const start = performance.now()
    selection = (async () => {
      assert.ok((await llm.listModels('antigravity')).some(model => model.id === 'm'))
      const result = await llm.resolveModelInfo('antigravity', 'm')
      assert.equal(result.context?.contextWindow, 900, 'both account capabilities still constrain the pool')
      return result
    })()
    assert.ok(await Promise.race([selection, pause(500).then(() => undefined)]), 'all-provider pool assembly must use saved catalogs')
    t.diagnostic(`registered multi-provider pool selection: ${Math.round(performance.now() - start)} ms; all network refreshes still blocked`)
  } finally {
    release()
    await selection?.catch(() => undefined)
    await pause(20)
    await runtime.dispose()
    prototypes.forEach((value, index) => { value.fetchCatalog = originals[index] })
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('scheduled discovery still retries rejected credentials and clears the old catalog', async () => {
  const { tokens } = accounts()
  const store = memoryStore()
  let calls = 0
  const raw = new AntigravityAdapter({ models: [], discovery: true, streamIdleTimeoutMs: 1000, tokens,
    catalogStore: store, fetchFn: async () => { calls++; return new Response('{}', { status: 401 }) } })
  await raw.listOwnModels('antigravity', 'a')
  for (let i = 0; i < 100 && await store.load() !== undefined; i++) await pause(5)
  assert.equal(calls, 2, 'discovery retried once after refreshing the credential')
  assert.equal(await store.load(), undefined, 'rejected credentials cannot resurrect stale metadata')
})
