import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'

test('provider settings RPC edits picker visibility without losing the editor catalog or existing sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'settings-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapters = new Map<string, AccountAwareAdapter>()
  const tools = new Set<string>()
  ctx.provide('llm', {
    registerAdapter: (routes: string[], adapter: AccountAwareAdapter) => {
      adapter.listModels = async provider => [
        { provider, id: 'm1', name: 'Model 1' }, { provider, id: 'm2', name: 'Model 2' },
      ]
      adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } })
      adapters.set(routes[0], adapter)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', { register: (definition: { name: string }) => { tools.add(definition.name); return () => {} } })
  const runtime = ctx.plugin(plugin, { providers: ['codex', 'grok'], pool: { enabled: false } })
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(connection.registered())
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)
    assert.equal((await call('setProviderSettings', { provider: 'codex', settings: { visibleModels: ['m1'], tools: { image_generate: false, web_search: false } } })).ok, true)
    assert.deepEqual((await adapters.get('codex')!.listModels('codex')).map(model => model.id), ['m1'])
    assert.equal((await adapters.get('codex')!.resolveModel('codex', 'm2')).id, 'm2')
    const resolve = adapters.get('codex')!.resolveModel
    adapters.get('codex')!.resolveModel = async (provider, model) => {
      if (model === 'm2') throw new Error('capabilities unavailable')
      return resolve(provider, model)
    }
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

    const create = (at: number) => {
      const denied: string[] = []
      const agent = { session: { header: { createdAt: at } }, ctx: { tools: { restrict: ({ deny }: { deny: string[] }) => { denied.push(...deny) } } } }
      ctx.emit('agent/created', { agent: agent as never })
      return denied
    }
    const old = create(Date.now() - 1000)
    assert.deepEqual(old, [])
    // Grok still supplies image_generate while only Codex is disabled.
    assert.deepEqual(create(Date.now() + 1000), ['web_search'])
    assert.equal((await call('setProviderSettings', { provider: 'grok', settings: { tools: { image_generate: false, video_generate: false } } })).ok, true)
    assert.deepEqual(old, [])
    assert.deepEqual(create(Date.now() + 1000).sort(), ['image_generate', 'video_generate', 'web_search'])
    assert.deepEqual([...tools].sort(), ['image_generate', 'video_generate', 'x_search'])
    assert.equal((await call('setProviderSettings', { provider: 'codex', settings: {} })).ok, true)
    assert.equal((await adapters.get('codex')!.listModels('codex')).length, 2)
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
  ctx.provide('llm', {
    registerAdapter: (routes: string[], adapter: AccountAwareAdapter) => {
      adapters.set(routes[0], adapter)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
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
    assert.deepEqual((await listAccounts('antigravity')).map(entry => entry.key), ['alice', 'bob'])
    const adapter = adapters.get('antigravity')!
    assert.deepEqual((await adapter.listOwnModels('antigravity', 'bob')).map(model => model.id), ['m1', 'm2'])
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)
    const catalog = await call('providerSettings', { provider: 'antigravity', force: true })
    assert.ok(catalog.ok)
    assert.deepEqual((catalog.value as { models: { id: string }[] }).models.map(model => model.id), ['m1', 'm2'])
    assert.deepEqual((catalog.value as { tools: string[] }).tools, [])
    assert.equal((await call('setProviderSettings', { provider: 'antigravity', settings: { visibleModels: ['m2'] } })).ok, true)
    assert.deepEqual((await adapter.listModels('antigravity')).map(model => model.id), ['m2'])
    assert.equal((await call('setProviderSettings', { provider: 'antigravity', settings: { tools: { image_generate: true } } })).ok, false)
  } finally {
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
