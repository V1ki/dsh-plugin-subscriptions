import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LlmRuntime, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import { CodexAdapter } from '../src/providers/codex.js'
import { saveAccountSession } from '../src/auth/store.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'

test('provider settings RPC edits picker visibility without losing the editor catalog or existing sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'settings-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapters = new Map<string, AccountAwareAdapter>()
  const tools = new Set<string>()
  const llm = new LlmRuntime(ctx)
  const registerAdapter = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (routes: string[], adapter: AccountAwareAdapter) => {
    adapters.set(routes[0], adapter)
    return registerAdapter(routes, adapter)
  }
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', { register: (definition: { name: string }) => { tools.add(definition.name); return () => {} } })
  const originalResolve = CodexAdapter.prototype.resolveOwnModel
  let unavailable = false
  CodexAdapter.prototype.resolveOwnModel = async (provider, model) => {
    if (unavailable && model === 'm2') throw new Error('capabilities unavailable')
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } }
  }
  const runtime = ctx.plugin(plugin, { providers: ['codex', 'grok'], pool: { enabled: false }, models: { codex: [{ id: 'm1', name: 'Model 1', inputModalities: ['text'] }, { id: 'm2', name: 'Model 2', inputModalities: ['text'] }] } })
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    if (!connection.registered()) await runtime
    assert.ok(connection.registered())
    assert.deepEqual(llm.listProviders(), [{ id: 'codex', name: 'ChatGPT (Codex)' }, { id: 'grok', name: 'Grok (Subscription)' }])
    await saveAccountSession('codex', 'account', { accessToken: 'token', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000, accountId: 'account', idToken: '' })
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)
    assert.equal((await call('setProviderSettings', { provider: 'codex', settings: { visibleModels: ['m1'], tools: { image_generate: false, web_search: false } } })).ok, true)
    assert.deepEqual((await adapters.get('codex')!.listModels('codex')).map(model => model.id), ['m1'])
    assert.equal((await adapters.get('codex')!.resolveModel('codex', 'm2')).id, 'm2')
    unavailable = true
    const catalog = await call('providerSettings', { provider: 'codex', force: true })
    assert.ok(catalog.ok)
    assert.deepEqual((catalog.value as { models: { id: string }[] }).models.map(model => model.id), ['m1', 'm2'])
    const rows = (catalog.value as { models: { id: string; efforts: { id: string }[]; configured?: string }[] }).models
    assert.deepEqual(rows[0].efforts.map(effort => effort.id), ['high'])
    assert.deepEqual(rows[1].efforts, [])
    assert.equal((await call('setModelDefault', { provider: 'codex', model: 'm1', effort: 'high' })).ok, true)
    const updated = await call('providerSettings', { provider: 'codex' })
    assert.ok(updated.ok)
    assert.equal((updated.value as { models: { configured?: string }[] }).models[0].configured, 'high')
    assert.equal((await call('providerSettings', { provider: 'codex', force: 'yes' })).ok, false)
    assert.equal((await call('setProviderSettings', { provider: 'codex', settings: { contextWindows: { m1: 0 } } })).ok, false)
    assert.equal((await call('setProviderSettings', { provider: 'claude', settings: {} })).ok, false)

    const names = { displayName: '我的 Codex', modelDisplayNames: { m1: '主力模型' },
      visibleModels: ['m1'], tools: { image_generate: false, web_search: false } }
    assert.equal((await call('setProviderSettings', { provider: 'codex', settings: names })).ok, true)
    const status = await call('status', {})
    assert.ok(status.ok)
    assert.equal((status.value as { providers: { codex: { displayName?: string } } }).providers.codex.displayName, '我的 Codex')
    assert.equal(llm.listProviders().find(provider => provider.id === 'codex')?.name, '我的 Codex')
    assert.equal((await adapters.get('codex')!.listModels('codex'))[0].name, '主力模型')
    const fresh = await call('providerSettings', { provider: 'codex', force: true })
    assert.ok(fresh.ok)
    assert.equal((fresh.value as { settings: { displayName: string } }).settings.displayName, '我的 Codex')
    assert.equal((fresh.value as { models: { name: string }[] }).models[0].name, 'Model 1')
    assert.equal(llm.listProviders().find(provider => provider.id === 'codex')?.name, '我的 Codex')
    const renamed = await adapters.get('codex')!.resolveModel('codex', 'm1')
    assert.equal(renamed.id, 'm1')
    assert.equal(renamed.name, '主力模型')
    assert.deepEqual(renamed.reasoning?.efforts.map(e => e.id), ['high'])

    const create = (at: number) => {
      const denied: string[] = []
      const agent = { session: { header: { createdAt: at } }, ctx: { tools: { restrict: ({ deny }: { deny: string[] }) => { denied.push(...deny) } } } }
      ctx.emit('agent/created', { agent: agent as never, source: 'startup' })
      return denied
    }
    const old = create(Date.now() - 1000)
    assert.deepEqual(old, [])
    // Grok still supplies image_generate while only Codex is disabled, and a
    // disabled Codex web_search withdraws this plugin's search provider rather
    // than denying the host's own web_search tool to every other provider.
    assert.deepEqual(create(Date.now() + 1000), [])
    assert.equal((await call('setProviderSettings', { provider: 'grok', settings: { displayName: 'MiniMax', tools: { image_generate: false, video_generate: false } } })).ok, true)
    assert.equal(llm.listProviders().find(provider => provider.id === 'grok')?.name, 'MiniMax')
    assert.deepEqual(old, [])
    assert.deepEqual(create(Date.now() + 1000).sort(), ['image_generate', 'video_generate'])
    assert.deepEqual([...tools].sort(), ['image_generate', 'video_generate', 'x_search'])
    assert.equal((await call('setProviderSettings', { provider: 'codex', settings: {} })).ok, true)
    assert.equal(llm.listProviders().find(provider => provider.id === 'codex')?.name, 'ChatGPT (Codex)')
    assert.equal((await adapters.get('codex')!.listModels('codex')).length, 2)
  } finally {
    await runtime.dispose()
    CodexAdapter.prototype.resolveOwnModel = originalResolve
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex RPC saves live global budgets and rejects invalid values', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-budget-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const adapters = new Map<string, AccountAwareAdapter>()
  const register = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (routes: string[], adapter: AccountAwareAdapter) => { adapters.set(routes[0], adapter); return register(routes, adapter) }
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', { register: () => () => {} })
  const runtime = ctx.plugin(plugin, { providers: ['codex'], pool: { enabled: false }, models: { codex: [{ id: 'm', name: 'Model', inputModalities: ['text'] }] } })
  try {
    await saveAccountSession('codex', 'account', { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600000, accountId: 'account' })
    await new Promise(resolve => setTimeout(resolve, 50))
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)
    const adapter = adapters.get('codex')!
    assert.equal((await adapter.resolveModel('codex', 'm')).defaultMaxTokens, 8_192)
    assert.ok((await call('setProviderSettings', { provider: 'codex', settings: { contextWindow: 200000, defaultMaxTokens: 32768 } })).ok)
    const resolved = await adapter.resolveModel('codex', 'm')
    assert.equal(resolved.context?.contextWindow, 200000)
    assert.equal(resolved.defaultMaxTokens, 32768)
    const catalog = await call('providerSettings', { provider: 'codex' })
    assert.ok(catalog.ok)
    assert.deepEqual((catalog.value as { settings: unknown }).settings, { contextWindow: 200000, defaultMaxTokens: 32768 })
    assert.equal((await call('setProviderSettings', { provider: 'codex', settings: { defaultMaxTokens: 0 } })).ok, false)
    assert.equal((await adapter.resolveModel('codex', 'm')).defaultMaxTokens, 32768)
    assert.ok((await call('setProviderSettings', { provider: 'codex', settings: {} })).ok)
    assert.equal((await adapter.resolveModel('codex', 'm')).defaultMaxTokens, 8_192)
  } finally {
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('Antigravity registers the real multi-account adapter with provider settings', async () => {
  const { saveAccountSession, authFilePath, accountKeyOf, listAccounts } = await import('../src/auth/store.js')
  const home = await mkdtemp(join(tmpdir(), 'antigravity-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapters = new Map<string, AccountAwareAdapter>()
  const llm = new LlmRuntime(ctx)
  const registerAdapter = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (routes: string[], adapter: AccountAwareAdapter) => {
    adapters.set(routes[0], adapter)
    return registerAdapter(routes, adapter)
  }
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  const runtime = ctx.plugin(plugin, {
    providers: ['antigravity'], pool: { enabled: false },
    models: { antigravity: [{ id: 'm1', inputModalities: ['text', 'image'] }, { id: 'm2', inputModalities: ['text'] }] },
    antigravity: { clientId: 'configured-client.example.invalid', onboard: false },
  })
  try {
    assert.ok(authFilePath().startsWith(home))
    for (const account of ['alice', 'bob']) {
      const session = { accessToken: account, refreshToken: account, expiresAt: Date.now() + 3600_000, projectId: `project-${account}`, account }
      await saveAccountSession('antigravity', accountKeyOf('antigravity', session), session)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(connection.registered(), 'the subscriptions-auth Fetch routes were registered')
    assert.deepEqual(llm.listProviders(), [{ id: 'antigravity', name: 'Google Antigravity' }])
    assert.deepEqual((await listAccounts('antigravity')).map(entry => entry.key), ['alice', 'bob'])
    const adapter = adapters.get('antigravity')!
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)

    // Antigravity is disabled by default even when saved accounts already exist.
    assert.deepEqual(await adapter.listModels('antigravity'), [])
    await assert.rejects(() => adapter.resolveModel('antigravity', 'm1'), /disabled/)
    const disabledStatus = await call('status', {})
    assert.ok(disabledStatus.ok)
    assert.equal((disabledStatus.value as { providers: { antigravity: { enabled?: boolean } } }).providers.antigravity.enabled, false)
    assert.equal((await call('login', { provider: 'antigravity' })).ok, false)
    assert.equal((await call('providerSettings', { provider: 'antigravity' })).ok, false)
    const disabledUsage = await call('usage', { provider: 'antigravity', account: 'alice' })
    assert.ok(disabledUsage.ok)
    assert.deepEqual(disabledUsage.value, { supported: false })
    assert.equal((await call('setProviderEnabled', { provider: 'codex', enabled: false })).ok, false)
    assert.equal((await call('setProviderEnabled', { provider: 'antigravity', enabled: 'yes' })).ok, false)

    // Manually enabling Antigravity activates routes immediately without restarting.
    assert.equal((await call('setProviderEnabled', { provider: 'antigravity', enabled: true })).ok, true)
    assert.deepEqual((await adapter.listModels('antigravity')).map(model => model.id), ['m1', 'm2'])
    const catalog = await call('providerSettings', { provider: 'antigravity', force: true })
    assert.ok(catalog.ok)
    assert.deepEqual((catalog.value as { models: { id: string }[] }).models.map(model => model.id), ['m1', 'm2'])
    assert.deepEqual((catalog.value as { tools: string[] }).tools, [])
    assert.deepEqual((catalog.value as { accounts: unknown[] }).accounts, ['alice', 'bob'].map(key => ({ key, label: key, models: [{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'm2' }] })))
    assert.equal((await call('setProviderSettings', { provider: 'antigravity', settings: { displayName: 'Qwen', visibleModels: ['m2'] } })).ok, true)
    assert.deepEqual(llm.listProviders(), [{ id: 'antigravity', name: 'Qwen' }])
    assert.deepEqual((await adapter.listModels('antigravity')).map(model => model.id), ['m2'])
    // Status carries local visibility without fetching a catalog. Closing the
    // manager refreshes status, so the usage panel can re-filter cached quotas.
    const originalList = adapter.listOwnModels
    adapter.listOwnModels = async () => { throw new Error('status must not discover models') }
    const selection = async () => {
      const result = await call('status', {})
      assert.ok(result.ok)
      return (result.value as { providers: { antigravity: { visibleModels?: string[]; enabled?: boolean } } }).providers.antigravity
    }
    try {
      assert.deepEqual((await selection()).visibleModels, ['m2'])
      assert.equal((await selection()).enabled, undefined, 'saving provider settings preserves enabled state')
      assert.equal((await call('setProviderSettings', { provider: 'antigravity', settings: { visibleModels: [] } })).ok, true)
      assert.deepEqual((await selection()).visibleModels, [])
      assert.equal((await call('setProviderSettings', { provider: 'antigravity', settings: {} })).ok, true)
      assert.equal(Object.hasOwn(await selection(), 'visibleModels'), false)
    } finally {
      adapter.listOwnModels = originalList
    }
    assert.equal((await call('setProviderSettings', { provider: 'antigravity', settings: { tools: { image_generate: true } } })).ok, false)
    // Disabling again hides models and blocks dispatch while keeping saved accounts intact.
    assert.equal((await call('setProviderEnabled', { provider: 'antigravity', enabled: false })).ok, true)
    assert.deepEqual(await adapter.listModels('antigravity'), [])
    await assert.rejects(() => adapter.resolveModel('antigravity', 'm1'), /disabled/)
    assert.deepEqual((await listAccounts('antigravity')).map(entry => entry.key), ['alice', 'bob'])
  } finally {
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('Antigravity cached roster remains available immediately after clearing and selecting all grouped models', async () => {
  const { catalogStore } = await import('../src/providers/catalog-store.js')
  const { antigravityCatalogCache } = await import('./fixtures/antigravity-catalog-cache.js')
  const home = await mkdtemp(join(tmpdir(), 'antigravity-grouped-settings-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const adapters = new Map<string, AccountAwareAdapter>()
  const register = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (routes: string[], adapter: AccountAwareAdapter) => { adapters.set(routes[0], adapter); return register(routes, adapter) }
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  let runtime: ReturnType<typeof ctx.plugin> | undefined
  try {
    await saveAccountSession('antigravity', 'fixture', { accessToken: 'test-token', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000, projectId: 'test-project' })
    await catalogStore('antigravity').save({ at: Date.now(), models: antigravityCatalogCache })
    runtime = ctx.plugin(plugin, { providers: ['antigravity'], pool: { enabled: false }, antigravity: { onboard: false } })
    await new Promise(resolve => setTimeout(resolve, 50))
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)
    assert.equal((await call('setProviderEnabled', { provider: 'antigravity', enabled: true })).ok, true)
    const result = await call('providerSettings', { provider: 'antigravity' })
    assert.ok(result.ok)
    const ids = (result.value as { models: { id: string }[] }).models.map(model => model.id)
    assert.deepEqual(ids, ['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b'])
    assert.ok((await call('setProviderSettings', { provider: 'antigravity', settings: { visibleModels: [] } })).ok)
    assert.deepEqual(await adapters.get('antigravity')!.listModels('antigravity'), [])
    assert.ok((await call('setProviderSettings', { provider: 'antigravity', settings: { visibleModels: ids } })).ok)
    assert.deepEqual((await adapters.get('antigravity')!.listModels('antigravity')).map(model => model.id), ids)
  } finally {
    await runtime?.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('Grok RPC exposes catalog context tiers and applies saved contextWindows overrides', async () => {
  const { catalogStore } = await import('../src/providers/catalog-store.js')
  const home = await mkdtemp(join(tmpdir(), 'grok-context-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const adapters = new Map<string, AccountAwareAdapter>()
  const register = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (routes: string[], adapter: AccountAwareAdapter) => { adapters.set(routes[0], adapter); return register(routes, adapter) }
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', { register: () => () => {} })
  let runtime: ReturnType<typeof ctx.plugin> | undefined
  try {
    await saveAccountSession('grok', 'grok-user', {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Date.now() + 3600_000,
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      account: 'grok-user@example.com',
    })
    await catalogStore('grok').save({
      at: Date.now(),
      models: [
        { id: 'grok-4.7', name: 'Grok 4.7', contextWindow: 256_000, contextWindowOptions: [256_000, 500_000] },
        { id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 256_000 },
      ],
    })
    runtime = ctx.plugin(plugin, { providers: ['grok'], pool: { enabled: false } })
    await new Promise(resolve => setTimeout(resolve, 50))
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)
    const adapter = adapters.get('grok')!

    const initial = await call('providerSettings', { provider: 'grok' })
    assert.ok(initial.ok)
    const rows = (initial.value as { models: { id: string; defaultContextWindow?: number; maxContextWindow?: number; contextWindowOptions?: number[] }[] }).models
    const g47 = rows.find(row => row.id === 'grok-4.7')
    const g43 = rows.find(row => row.id === 'grok-4.3')
    assert.deepEqual(g47 && { default: g47.defaultContextWindow, max: g47.maxContextWindow, options: g47.contextWindowOptions }, {
      default: 256_000, max: 500_000, options: [256_000, 500_000],
    })
    assert.deepEqual(g43 && { default: g43.defaultContextWindow, max: g43.maxContextWindow, options: g43.contextWindowOptions }, {
      default: 256_000, max: 256_000, options: undefined,
    })
    assert.equal((await adapter.resolveModel('grok', 'grok-4.7')).context?.contextWindow, 256_000)

    assert.equal((await call('setProviderSettings', { provider: 'grok', settings: { contextWindows: { 'grok-4.7': 500_000 } } })).ok, true)
    assert.equal((await adapter.resolveModel('grok', 'grok-4.7')).context?.contextWindow, 500_000)
    assert.equal((await call('setProviderSettings', { provider: 'grok', settings: { contextWindows: { 'grok-4.7': 0 } } })).ok, false)
    assert.equal((await call('setProviderSettings', { provider: 'grok', settings: {} })).ok, true)
    assert.equal((await adapter.resolveModel('grok', 'grok-4.7')).context?.contextWindow, 256_000)
  } finally {
    await runtime?.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
