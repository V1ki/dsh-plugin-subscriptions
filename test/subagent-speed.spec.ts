/** Exercise real plugin RPC, agent lookup, account routing, and intercepted Codex requests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import { accountModelId } from '../src/providers/account-preferences.js'
import { saveAccountSession } from '../src/auth/store.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'

test('main speed and per-model subagent defaults stay independent through RPC, routing and restart', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'subagent-speed-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const requests: Record<string, unknown>[] = []
  let supportsFast = true
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/codex/models')) return new Response(JSON.stringify({ models: [
      { slug: 'fast-model', display_name: 'Fast model', service_tiers: supportsFast ? [{ id: 'priority' }] : [] },
      { slug: 'plain-model', display_name: 'Plain model' },
    ] }))
    if (url.endsWith('/codex/responses')) {
      requests.push(JSON.parse(String(init?.body)))
      return new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n')
    }
    throw new Error(`Unexpected outbound request: ${url}`)
  })
  const mount = async (withAgents = true, pooling = false) => {
    const ctx = new Context()
    const agents = withAgents ? new AgentRegistry(ctx) : undefined
    const adapterMap = new Map<string, AccountAwareAdapter>()
    ctx.provide('llm', { registerAdapter: (routes: string[], adapter: AccountAwareAdapter) => {
      for (const route of routes) adapterMap.set(route, adapter)
      return Object.assign(() => {}, { replace: () => {} })
    } })
    const connection = createFakeConnection()
    ctx.provide('connection', connection.connection)
    const runtime = ctx.plugin(plugin, { providers: ['codex'], codexClientVersion: '0.100.0', pool: { enabled: pooling } })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(connection.registered())
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)
    const register = (id: string, header: Record<string, unknown>, provider = 'codex') => {
      const agent = { id, ctx, options: { provider }, session: { id, header: { id, ...header } } } as unknown as Agent
      agents!.enter(agent, undefined)
    }
    if (agents) {
      register('parent', {}, 'claude')
      register('child', { origin: 'subagent', parentSession: 'parent' })
      register('nested', { origin: 'subagent', parentSession: 'child' })
      register('restored-fork', { origin: 'subagent', parentSession: 'absent-parent', isSeeded: true })
      register('ordinary-fork', { parentSession: 'parent', isSeeded: true })
    }
    const stream = async (id: string | undefined, expected: 'priority' | undefined, model = 'fast-model') => {
      const before = requests.length
      for await (const chunk of adapterMap.get('codex')!.stream({ provider: 'codex', model, messages: [],
        ...(id === undefined ? {} : { sessionId: id as NonNullable<GenerateOptions['sessionId']> }),
      })) void chunk
      assert.equal(requests.length, before + 1)
      assert.equal(requests.at(-1)!.service_tier, expected, `${id}/${model}`)
    }
    const setSpeed = async (sessionId: string, tier: 'standard' | 'fast') => {
      assert.equal((await call('setSpeed', { sessionId, tier })).ok, true)
    }
    const setDefaults = async (tier: 'standard' | 'fast') => {
      assert.equal((await call('setProviderSettings', { provider: 'codex', settings: {
        subagentSpeeds: { 'fast-model': tier, 'plain-model': 'fast' },
        accounts: { a: { independentEntry: true } },
      } })).ok, true)
    }
    return { runtime, call, stream, setSpeed, setDefaults }
  }
  let host: Awaited<ReturnType<typeof mount>> | undefined
  try {
    for (const account of ['a', 'b']) await saveAccountSession('codex', account, {
      accessToken: `synthetic-${account}`, refreshToken: 'synthetic-refresh', accountId: account, expiresAt: Date.now() + 86400000,
    })
    host = await mount()
    await host.setSpeed('parent', 'fast')
    await host.stream('parent', 'priority')
    await host.stream('child', undefined, 'fast-model')
    await host.setSpeed('parent', 'standard')
    await host.setDefaults('fast')
    await host.stream('parent', undefined)
    for (const child of ['child', 'nested', 'restored-fork']) await host.stream(child, 'priority')
    for (const id of ['ordinary-fork', 'unknown', undefined]) await host.stream(id, undefined)
    await host.stream('child', undefined, 'plain-model')
    await host.stream('child', 'priority', accountModelId('a', 'fast-model'))
    assert.deepEqual(await host.call('speed', { sessionId: 'child', model: accountModelId('a', 'fast-model') }), {
      ok: true, value: { tier: 'fast', fastModels: ['fast-model', accountModelId('a', 'fast-model')] },
    })
    assert.equal((await host.call('speed', { sessionId: 'child', model: 1 })).ok, false)
    const catalog = await host.call('providerSettings', { provider: 'codex' })
    assert.ok(catalog.ok)
    assert.deepEqual((catalog.value as { models: { fastTier: boolean }[] }).models.map(row => row.fastTier), [true, false])
    await host.setDefaults('standard')
    await host.setSpeed('parent', 'fast')
    await host.stream('parent', 'priority')
    await host.stream('child', undefined)
    await host.setDefaults('fast')
    await host.setSpeed('child', 'standard')
    await host.stream('child', undefined)
    await host.stream('nested', 'priority')
    assert.equal((await host.call('speed', { sessionId: 'child', model: 'fast-model' }) as { value: { tier: string } }).value.tier, 'standard')
    await host.runtime.dispose()
    host = await mount(true, true)
    await host.stream('parent', undefined)
    await host.stream('child', 'priority') // saved default survives, explicit choices do not
    await host.stream('child', 'priority', accountModelId('a', 'fast-model'))
    supportsFast = false
    await host.call('providerSettings', { provider: 'codex', force: true })
    await host.stream('child', undefined) // retained setting cannot bypass current capability
    await host.runtime.dispose()
    supportsFast = true
    host = await mount(false)
    await host.call('providerSettings', { provider: 'codex', force: true })
    await host.stream('child', undefined) // minimal host cannot classify a child
    await host.setSpeed('child', 'fast')
    await host.stream('child', 'priority') // existing explicit speed still works
  } finally {
    await host?.runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
