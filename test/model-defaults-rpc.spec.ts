/**
 * Unit tests for the `modelDefaults` / `setModelDefault` endpoints: payload
 * validation, the catalog shape served to the Settings page, and the
 * durable round trip through the per-model defaults store. Drives the real
 * plugin wiring with a fake host connection and a fake llm catalog;
 * DSH_HOME is redirected to a temp dir so the store file never leaks.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'

const HOME = mkdtempSync(join(tmpdir(), 'model-defaults-rpc-test-'))

const plugin = await import('../src/index.js')
const { modelDefaultsFilePath, resetModelDefaultsForTests } = await import('../src/model-defaults.js')

interface FakeLlm {
  registered: string[]
  replaced: string[]
}

/**
 * Mount the plugin with a fake llm catalog; return its RPC handler.
 *
 * DSH_HOME is set per mount rather than once at import: the specs share one
 * process and ESM runs every top-level body before the first test, so a
 * top-level assignment let whichever spec imported last own the home for all
 * of them. Each mount also resets the store and deletes the file, so the cases
 * below are independent — they used to pass only in their written order.
 */
async function mount(options: { tier?: string } = {}): Promise<{ handler: ConnectionRpcHandler; fake: FakeLlm }> {
  process.env.DSH_HOME = HOME
  assert.ok(modelDefaultsFilePath().startsWith(HOME), 'the store resolves inside this spec\'s temp home')
  await resetModelDefaultsForTests()
  rmSync(modelDefaultsFilePath(), { force: true })
  let handler: ConnectionRpcHandler | undefined
  const fake: FakeLlm = { registered: [], replaced: [] }
  const ctx = new Context()
  const listed = [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }]
  // A configured tier appears in the picker catalog the same way the pool
  // contributes it, so the settings catalog has to recognise and skip it.
  if (options.tier !== undefined) listed.push({ id: options.tier, name: options.tier })
  const fakeLlm = {
    listProviders: async (): Promise<{ id: string; name: string }[]> => [{ id: 'codex', name: 'Codex (ChatGPT)' }],
    listModels: async (): Promise<{ id: string; name: string }[]> => listed,
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      id: model,
      name: 'GPT-5.6-Sol',
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('low'),
      },
    }),
    registerAdapter: (providers: string[]) => {
      fake.registered.push(...providers)
      return Object.assign(() => {}, {
        replace: (next: string[]) => { fake.replaced.push(...next) },
      })
    },
  }
  ctx.provide('llm', fakeLlm)
  ctx.provide('connection', {
    rpc: {
      handle: (_channel: string, h: ConnectionRpcHandler) => {
        handler = h
        return () => Promise.resolve()
      },
    },
  })
  ctx.plugin(plugin, {
    providers: ['codex'],
    ...options.tier === undefined ? {} : {
      pool: { tiers: { [options.tier]: [{ provider: 'codex', model: 'gpt-5.6-sol' }] } },
    },
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(handler !== undefined, 'the /subscriptions-auth channel was registered')
  return { handler, fake }
}

async function call(
  handler: ConnectionRpcHandler,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  return handler(endpoint, payload, new AbortController().signal)
}

test('modelDefaults serves the listed models with their advertised efforts', async () => {
  const { handler } = await mount()
  const result = await call(handler, 'modelDefaults', {})
  assert.equal(result.ok, true)
  if (!result.ok) return
  const value = result.value as { provider: string; models: { id: string; name: string; efforts: { id: string }[]; configured?: string }[] }[]
  assert.equal(value.length, 1)
  assert.equal(value[0]?.provider, 'codex')
  assert.deepEqual(value[0]?.models[0], {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
  })
})

test('setModelDefault persists and the next modelDefaults reports it', async () => {
  const { handler, fake } = await mount()
  const set = await call(handler, 'setModelDefault', {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  })
  assert.deepEqual(set, { ok: true, value: { ok: true } })
  // The route re-announces so the model picker re-queries the catalog.
  assert.deepEqual(fake.replaced, ['codex'])
  const view = await call(handler, 'modelDefaults', {})
  assert.equal(view.ok, true)
  if (!view.ok) return
  const model = (view.value as { provider: string; models: { configured?: string }[] }[])[0]?.models[0]
  assert.equal(model?.configured, 'high')
})

test('setModelDefault without effort clears the override', async () => {
  const { handler } = await mount()
  await call(handler, 'setModelDefault', { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
  await call(handler, 'setModelDefault', { provider: 'codex', model: 'gpt-5.6-sol' })
  const view = await call(handler, 'modelDefaults', {})
  assert.equal(view.ok, true)
  if (!view.ok) return
  const model = (view.value as { provider: string; models: { configured?: string }[] }[])[0]?.models[0]
  assert.equal(model?.configured, undefined)
})

test('setModelDefault rejects unknown providers and empty efforts', async () => {
  const { handler } = await mount()
  const badProvider = await call(handler, 'setModelDefault', {
    provider: 'nope',
    model: 'gpt-5.6-sol',
    effort: 'high',
  })
  assert.equal(badProvider.ok, false)
  if (!badProvider.ok) assert.match(badProvider.error.message, /payload.provider must be one of/)
  const badEffort = await call(handler, 'setModelDefault', {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: '',
  })
  assert.equal(badEffort.ok, false)
  if (!badEffort.ok) assert.match(badEffort.error.message, /payload.effort must be a non-empty string/)
})

test('setModelDefault rejects an effort the model catalog does not advertise', async () => {
  const { handler } = await mount()
  // The fake catalog advertises low/high only; max must not be accepted.
  const result = await call(handler, 'setModelDefault', {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'max',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error.message, /does not advertise a "max" reasoning effort/)
  // And nothing was persisted.
  const view = await call(handler, 'modelDefaults', {})
  assert.equal(view.ok, true)
  if (!view.ok) return
  const model = (view.value as { provider: string; models: { configured?: string }[] }[])[0]?.models[0]
  assert.equal(model?.configured, undefined)
})

test('setModelDefault accepts an advertised effort and clears with no effort', async () => {
  const { handler } = await mount()
  const ok = await call(handler, 'setModelDefault', { provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' })
  assert.equal(ok.ok, true)
  const cleared = await call(handler, 'setModelDefault', { provider: 'codex', model: 'gpt-5.6-sol' })
  assert.equal(cleared.ok, true, 'clearing always passes the whitelist')
})

test('modelDefaults leaves out configured tier rows', async () => {
  // A tier resolves through the pool, which intersects its members' own
  // capabilities and never consults the override for the tier id. Offering the
  // row would save cleanly and change nothing the user can observe.
  const { handler } = await mount({ tier: 'smart-tier' })
  const result = await call(handler, 'modelDefaults', {})
  assert.equal(result.ok, true)
  if (!result.ok) return
  const value = result.value as { provider: string; models: { id: string }[] }[]
  const ids = value[0]?.models.map(model => model.id) ?? []
  assert.deepEqual(ids, ['gpt-5.6-sol'], 'the tier row is skipped, the real model stays')
})
