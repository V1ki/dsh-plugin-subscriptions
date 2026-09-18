import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPreferencesAdapter, accountModelId, parseAccountModelId, accountAllowsPool } from '../src/providers/account-preferences.js'
import { ProviderSettingsStore, validatePreferences } from '../src/provider-settings.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'

class Raw extends LlmAdapter {
  calls: string[] = []
  failAccount?: string
  async listOwnModels(provider: string, account?: string) { return [{ provider, id: 'm:/模型', name: 'Model' }, ...(account === 'b' ? [{ provider, id: 'exclusive', name: 'Exclusive' }] : [])] }
  async resolveOwnModel(provider: string, model: string, account?: string) { this.calls.push(`resolve:${account}:${model}`); return { provider, id: model, name: 'Model', context: { contextWindow: account === 'b' ? 200 : 100 } } }
  clearAccountCatalog() {}
  async *stream(): AsyncIterable<StreamChunk> { throw new Error('default path forbidden') }
  async *streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> { this.calls.push(`stream:${account}:${options.model}`); if (this.failAccount === account) throw new LlmError('quota exhausted', 'RATE_LIMIT'); yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } }
}
const options = (model: string) => ({ provider: 'codex', model } as GenerateOptions)
async function consume(route: LlmAdapter, id: string) { for await (const _ of route.stream(options(id))) { /* collect */ } }

test('account preferences validate, persist and distinguish absent and empty allowlists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-preferences-'))
  try {
    const store = new ProviderSettingsStore(join(dir, 'settings.json'))
    await store.set('codex', { accounts: JSON.parse('{"__proto__":{"alias":"  Work  ","poolEnabled":false,"independentEntry":true,"poolModels":[]},"b":{}}') })
    const prefs = new ProviderSettingsStore(store.path).get('codex').accounts!
    assert.equal(prefs['__proto__'].alias, 'Work')
    assert.equal(accountAllowsPool(prefs['__proto__'], 'm'), false)
    assert.equal(accountAllowsPool(prefs.b, 'm'), true)
    assert.equal(accountAllowsPool({ poolModels: [] }, 'm'), false)
    assert.equal(accountAllowsPool({ poolModels: ['m'] }, 'm'), true)
    for (const account of [{ poolEnabled: 'true' }, { independentEntry: 1 }, { poolModels: [null] }, { alias: 3 }, []]) assert.throws(() => validatePreferences('codex', { accounts: { a: account } }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('independent entries use stable IDs, raw account capabilities and no default fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-route-'))
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    const raw = new Raw()
    let accounts = [{ key: 'a:/账户', label: 'Original' }, { key: 'b', label: 'Other' }]
    const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw, settings, accounts: async () => accounts, pool: () => undefined })
    const id = accountModelId('a:/账户', 'm:/模型')
    assert.deepEqual(parseAccountModelId(id), { account: 'a:/账户', model: 'm:/模型' })
    await settings.set('codex', { accounts: { 'a:/账户': { alias: 'Work', independentEntry: true, poolEnabled: false, poolModels: [] } } })
    assert.equal((await route.listModels('codex')).find(model => model.id === id)?.name, 'Work · Model')
    assert.equal((await route.resolveModel('codex', id)).context?.contextWindow, 100)
    await consume(route, id)
    assert.ok(raw.calls.includes('stream:a:/账户:m:/模型'))
    raw.failAccount = 'a:/账户'
    const beforeFailure = raw.calls.length
    await assert.rejects(consume(route, id), /quota exhausted/)
    assert.deepEqual(raw.calls.slice(beforeFailure), ['stream:a:/账户:m:/模型'])
    delete raw.failAccount
    await consume(route, 'm:/模型')
    assert.ok(raw.calls.includes('stream:b:m:/模型'))
    await settings.set('codex', { accounts: { 'a:/账户': { independentEntry: false }, b: { poolModels: [] } } })
    await assert.rejects(consume(route, id), /unavailable/)
    await assert.rejects(route.resolveModel('codex', id), /unavailable/)
    accounts = []
    await assert.rejects(consume(route, id), /unavailable/)
    await assert.rejects(consume(route, '~account:broken'), /Invalid/)
    await assert.rejects(consume(route, '~account:%ZZ:m'), /Invalid/)
    await assert.rejects(consume(route, 'm:/模型'), /No eligible/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('singleton and explicit families/tiers enforce account and model exclusion at pool seams', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-pool-'))
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    const raw = new Raw()
    let pool: PoolAdapter | undefined
    let accounts = [{ key: 'a', label: 'A' }]
    const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw, settings, accounts: async () => accounts, pool: () => pool })
    await settings.set('codex', { accounts: { a: { poolModels: [] } } })
    await assert.rejects(consume(route, 'm:/模型'), /No eligible/)
    pool = new PoolAdapter({ adapters: { codex: route.poolMember() }, health: new PoolHealthRegistry(), usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2, defaultAccount: async () => 'a', families: async () => new Map([['codex/m:/模型', { members: [{ provider: 'codex', account: 'a', model: 'm:/模型' }] }]]), tiers: { tier: [{ provider: 'codex', model: 'm:/模型' }] }, onWarn: () => {} })
    for (const id of ['m:/模型', 'tier']) {
      await assert.rejects(consume(route, id))
      await assert.rejects(route.resolveModel('codex', id), /no usable member/)
    }
    assert.equal(raw.calls.length, 0)
    assert.deepEqual(await route.listModels('codex'), [])
    await settings.set('codex', { accounts: { a: { poolModels: ['m:/模型'] } } })
    await consume(route, 'tier')
    assert.ok(raw.calls.includes('stream:a:m:/模型'))
    accounts = [...accounts, { key: 'b', label: 'B' }]
    await settings.set('codex', { accounts: { a: { poolEnabled: false } } })
    pool = new PoolAdapter({ adapters: { codex: route.poolMember() }, health: new PoolHealthRegistry(), usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2, defaultAccount: async () => 'a', families: async () => new Map(), tiers: { mixed: [{ provider: 'codex', account: 'a', model: 'm:/模型' }, { provider: 'codex', account: 'b', model: 'm:/模型' }] }, onWarn: () => {} })
    assert.equal((await route.resolveModel('codex', 'mixed')).context?.contextWindow, 200)
    await consume(route, 'mixed')
    assert.ok(raw.calls.includes('stream:b:m:/模型'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
