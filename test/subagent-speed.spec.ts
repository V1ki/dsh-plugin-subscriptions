/** Exercise real plugin RPC, agent lookup, account routing, and intercepted Codex requests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import { accountModelId, parseAccountModelId } from '../src/providers/account-preferences.js'
import { saveAccountSession } from '../src/auth/store.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'

const sol = 'gpt-6.2-sol'
const astra = 'gpt-6.2-astra'

test('session speed is independent of other conversations and subagent defaults', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'subagent-speed-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const requests: Record<string, unknown>[] = []
  let supportsFast = true
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/codex/models')) return new Response(JSON.stringify({ models: [
      { slug: sol, display_name: 'GPT-6.2 Sol', service_tiers: supportsFast ? [{ id: 'priority' }] : [] },
      { slug: 'plain-model', display_name: 'Plain model' },
      { slug: astra, display_name: 'GPT-6.2 Astra', service_tiers: [{ id: 'priority' }] },
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
      agents!.enter(agent)
    }
    if (agents) {
      register('parent', {}, 'claude')
      register('fresh', {})
      register('child', { origin: 'subagent', parentSession: 'parent' })
      register('nested', { origin: 'subagent', parentSession: 'child' })
      register('restored-fork', { origin: 'subagent', parentSession: 'absent-parent', isSeeded: true })
      register('ordinary-fork', { parentSession: 'parent', isSeeded: true })
    }
    const stream = async (id: string | undefined, expected: 'priority' | undefined, model = sol) => {
      const before = requests.length
      for await (const chunk of adapterMap.get('codex')!.stream({ provider: 'codex', model, messages: [],
        ...(id === undefined ? {} : { sessionId: id as NonNullable<GenerateOptions['sessionId']> }),
      })) void chunk
      assert.equal(requests.length, before + 1)
      const request = requests.at(-1)!
      assert.equal(request.model, parseAccountModelId(model)?.model ?? model)
      assert.equal(request.service_tier, expected, `${id}/${model}`)
    }
    const setSpeed = async (sessionId: string, tier: 'standard' | 'fast', model?: string) => {
      assert.equal((await call('setSpeed', { sessionId, tier, model })).ok, true)
    }
    const expectSpeed = async (sessionId: string, model: string, tier: 'standard' | 'fast', sessionTier?: 'standard' | 'fast') => {
      const reply = await call('speed', { sessionId, model })
      assert.ok(reply.ok)
      const { fastModels: _, ...speeds } = reply.value as import('../src/auth/rpc.js').SpeedState
      assert.deepEqual(speeds, { tier, ...(sessionTier === undefined ? {} : { sessionTier }) }, `${sessionId}/${model}`)
    }
    const setDefaults = async (tier: 'standard' | 'fast') => {
      assert.equal((await call('setProviderSettings', { provider: 'codex', settings: {
        subagentSpeeds: { [sol]: tier, 'plain-model': 'fast' },
        accounts: { a: { independentEntry: true } },
      } })).ok, true)
    }
    return { runtime, call, stream, setSpeed, expectSpeed, setDefaults }
  }
  let host: Awaited<ReturnType<typeof mount>> | undefined
  try {
    for (const account of ['a', 'b']) await saveAccountSession('codex', account, {
      accessToken: `synthetic-${account}`, refreshToken: 'synthetic-refresh', accountId: account, expiresAt: Date.now() + 86400000,
    })
    const legacyDir = join(home, 'plugins', 'subscriptions')
    const speedsPath = join(legacyDir, 'model-speeds.json')
    const legacySpeeds = { [sol]: 'standard', [astra]: 'fast' }
    await mkdir(legacyDir, { recursive: true })
    await writeFile(speedsPath, JSON.stringify(legacySpeeds))
    host = await mount()
    const main = host
    await t.test('switching Sol Standard to Astra ignores legacy Fast until explicitly selected', async () => {
      await main.expectSpeed('fresh', sol, 'standard')
      await main.stream('fresh', undefined, sol)
      await main.stream('fresh', undefined, astra)
      await main.expectSpeed('fresh', astra, 'standard')
      await main.setSpeed('fresh', 'fast', astra)
      await main.expectSpeed('fresh', astra, 'fast', 'fast')
      await main.stream('fresh', 'priority', astra)
      await main.stream('parent', undefined, astra)
    })
    await host.setSpeed('parent', 'fast')
    await host.stream('parent', 'priority')
    await host.expectSpeed('parent', astra, 'fast', 'fast') // legacy model-less override
    await host.stream('child', undefined, sol)
    await host.setSpeed('parent', 'standard')
    await host.setDefaults('fast')
    await host.stream('parent', undefined)
    for (const child of ['child', 'nested', 'restored-fork']) await host.stream(child, 'priority')
    for (const id of ['ordinary-fork', 'unknown', undefined]) await host.stream(id, undefined)
    await host.stream('child', undefined, 'plain-model')
    await host.stream('child', 'priority', accountModelId('a', sol))
    assert.deepEqual(await host.call('speed', { sessionId: 'child', model: accountModelId('a', sol) }), {
      ok: true, value: { tier: 'fast', fastModels: [
        sol, astra, accountModelId('a', sol), accountModelId('a', astra),
      ] },
    })
    assert.equal((await host.call('speed', { sessionId: 'child', model: 1 })).ok, false)
    const catalog = await host.call('providerSettings', { provider: 'codex' })
    assert.ok(catalog.ok)
    assert.deepEqual((catalog.value as { models: { fastTier: boolean }[] }).models.map(row => row.fastTier), [true, false, true])
    await host.setDefaults('standard')
    await host.setSpeed('parent', 'fast')
    await host.stream('parent', 'priority')
    await host.stream('child', undefined)
    await host.setDefaults('fast')
    await host.setSpeed('child', 'standard')
    await host.stream('child', undefined)
    await host.stream('nested', 'priority')
    await host.expectSpeed('child', sol, 'standard', 'standard')
    // Model switches only change the model in subsequent RPC/stream calls; no speed write is needed.
    await host.setSpeed('parent', 'fast', sol)
    await host.expectSpeed('parent', 'plain-model', 'standard', 'fast')
    await host.stream('parent', undefined, 'plain-model')
    await host.expectSpeed('parent', astra, 'fast', 'fast')
    await host.stream('parent', 'priority', astra)
    await host.stream('parent', 'priority', accountModelId('a', astra))
    await host.expectSpeed('unknown', sol, 'standard')
    await host.expectSpeed('unknown', astra, 'standard')
    await host.stream('unknown', undefined, astra)
    await host.stream('child', undefined, astra)
    await host.stream('nested', 'priority')

    // Explicit Standard is also sticky, without changing another session’s Fast.
    await host.setSpeed('parent', 'standard', accountModelId('a', astra))
    await host.expectSpeed('parent', sol, 'standard', 'standard')
    await host.stream('parent', undefined)
    await host.stream('fresh', 'priority')
    await host.stream('nested', 'priority')
    assert.deepEqual(JSON.parse(await readFile(speedsPath, 'utf8')), legacySpeeds)

    await host.runtime.dispose()
    host = await mount(true, true)
    await host.expectSpeed('fresh', astra, 'standard') // previously explicit Fast is not restored
    await host.stream('fresh', undefined, astra)
    await host.expectSpeed('parent', sol, 'standard')
    await host.expectSpeed('parent', astra, 'standard')
    await host.stream('parent', undefined)
    await host.stream('child', 'priority') // saved child default stays independent
    await host.stream('child', 'priority', accountModelId('a', sol))
    supportsFast = false
    await host.call('providerSettings', { provider: 'codex', force: true })
    await host.stream('child', undefined) // retained setting cannot bypass current capability
    await host.runtime.dispose()
    supportsFast = true
    host = await mount(false)
    await host.call('providerSettings', { provider: 'codex', force: true })
    await host.stream('child', undefined) // without a registry, do not assume subagent origin
    await host.setSpeed('child', 'fast')
    await host.stream('child', 'priority') // existing explicit speed still works
  } finally {
    await host?.runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
