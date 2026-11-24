import './keep-alive.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, LlmError, LlmRuntime, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPreferencesAdapter, accountModelId, parseAccountModelId, accountAllowsPool } from '../src/providers/account-preferences.js'
import { ProviderSettingsStore, validatePreferences } from '../src/provider-settings.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { buildAccountPools } from '../src/providers/pool-family.js'
import { groupAntigravityModels } from '../src/providers/antigravity-models.js'

class Raw extends LlmAdapter {
  calls: string[] = []
  failAccount?: string
  async listOwnModels(provider: string, account?: string) { return [{ provider, id: 'm:/模型', name: 'Model' }, ...(account === 'b' ? [{ provider, id: 'exclusive', name: 'Exclusive' }] : [])] }
  async resolveOwnModel(provider: string, model: string, account?: string) { this.calls.push(`resolve:${account}:${model}`); return { provider, id: model, name: 'Model', context: { contextWindow: account === 'b' ? 200 : 100 } } }
  clearAccountCatalog() {}
  async *stream(): AsyncIterable<StreamChunk> { throw new Error('default path forbidden') }
  async *streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> { this.calls.push(`stream:${account}:${options.model}`); if (this.failAccount === account) throw new LlmError('quota exhausted', 'RATE_LIMIT'); yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } }
}
const options = (model: string): GenerateOptions => ({ provider: 'codex', model, messages: [] })
async function consume(route: LlmAdapter, id: string) { for await (const _ of route.stream(options(id))) { /* collect */ } }

test('registered account routes preserve provider retry policy in the DSH runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-runtime-'))
  const raw = new Raw()
  const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 9, backoff: { maxDelayMs: 7200000 } }, 'test')
  raw.providerRetryPolicy = () => policy
  const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw,
    settings: new ProviderSettingsStore(join(dir, 'settings.json')), accounts: async () => [{ key: 'a', label: 'A' }], pool: () => undefined })
  const llm = new LlmRuntime(new Context())
  const dispose = llm.registerAdapter(['codex'], route)
  try { assert.deepEqual(llm.providerRetryPolicy('codex'), policy) }
  finally { dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('DSH prepared calls keep the account whose capabilities were resolved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-prepared-'))
  const raw = new Raw()
  let order = ['a', 'b']
  const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw,
    settings: new ProviderSettingsStore(join(dir, 'settings.json')), accounts: async () => order.map(key => ({ key, label: key })), pool: () => undefined })
  const llm = new LlmRuntime(new Context())
  const dispose = llm.registerAdapter(['codex'], route)
  try {
    const prepared = await llm.prepareCall({ provider: 'codex', model: 'm:/模型' })
    assert.equal(prepared.context?.contextWindow, 100)
    order = ['b', 'a']
    for await (const _ of prepared.stream({ ...prepared.config, messages: [] })) { /* drain */ }
    assert.ok(raw.calls.includes('stream:a:m:/模型'), raw.calls.join(', '))
    assert.equal(raw.calls.some(call => call.startsWith('stream:b:')), false)
  } finally { dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('DSH capability preparation promptly settles when cancelled during discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-abort-'))
  const raw = new Raw()
  let release!: () => void
  let enter!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  raw.listOwnModels = async provider => { enter(); await gate; return [{ provider, id: 'm:/模型', name: 'Model' }] }
  const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw,
    settings: new ProviderSettingsStore(join(dir, 'settings.json')), accounts: async () => [{ key: 'a', label: 'A' }], pool: () => undefined })
  const llm = new LlmRuntime(new Context())
  const dispose = llm.registerAdapter(['codex'], route)
  const controller = new AbortController()
  const reason = new DOMException('Test cancelled', 'AbortError')
  try {
    const pending = llm.prepareCall({ provider: 'codex', model: 'm:/模型' }, controller.signal).then(() => 'resolved', error => error)
    await entered
    controller.abort(reason)
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('hung'), 100))])
    assert.equal(result, reason)
  } finally { release(); dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('revoking a prepared account refuses dispatch rather than bypassing preferences', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-revoked-'))
  const raw = new Raw()
  const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
  const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw, settings,
    accounts: async () => ['a', 'b'].map(key => ({ key, label: key })), pool: () => undefined })
  const llm = new LlmRuntime(new Context())
  const dispose = llm.registerAdapter(['codex'], route)
  try {
    const prepared = await llm.prepareCall({ provider: 'codex', model: 'm:/模型' })
    await settings.set('codex', { accounts: { a: { poolEnabled: false } } })
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'NO_ADAPTER'))
    assert.equal(raw.calls.some(call => call.startsWith('stream:')), false)
  } finally { dispose(); await rm(dir, { recursive: true, force: true }) }
})

for (const gateAt of ['accounts', 'models'] as const) test(`independent-entry revocation during ${gateAt} lookup refuses dispatch`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-independent-revoked-'))
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entry = new Promise<void>(resolve => { entered = resolve })
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    await settings.set('codex', { accounts: { a: { independentEntry: true } } })
    const raw = new Raw()
    const list = raw.listOwnModels.bind(raw)
    if (gateAt === 'models') raw.listOwnModels = async (provider, account) => { entered(); await gate; return list(provider, account) }
    const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw, settings, pool: () => undefined,
      accounts: async () => { if (gateAt === 'accounts') { entered(); await gate }; return [{ key: 'a', label: 'A' }] } })
    const pending = consume(route, accountModelId('a', 'm:/模型'))
    const rejected = assert.rejects(pending, /unavailable/)
    await entry
    await settings.set('codex', { accounts: { a: { independentEntry: false } } })
    release()
    await rejected
    assert.deepEqual(raw.calls, [])
  } finally { release(); await rm(dir, { recursive: true, force: true }) }
})

test('model display names decorate list and resolution without changing routing or capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-display-names-'))
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    const raw = new Raw()
    const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw, settings,
      accounts: async () => [{ key: 'a', label: 'A' }], pool: () => undefined })
    await settings.set('codex', { modelDisplayNames: { 'm:/模型': '主力模型' }, accounts: { a: { alias: '主账号', independentEntry: true } } })
    const id = accountModelId('a', 'm:/模型')
    const models = await route.listModels('codex')
    assert.equal(models.find(m => m.id === 'm:/模型')?.name, '主力模型')
    assert.equal(models.find(m => m.id === id)?.name, '主账号 · 主力模型')
    const resolved = await route.resolveModel('codex', 'm:/模型')
    assert.equal(resolved.name, '主力模型')
    assert.equal(resolved.id, 'm:/模型')
    assert.equal(resolved.context?.contextWindow, 100)
    assert.equal((await route.resolveModel('codex', id)).name, '主账号 · 主力模型')
    await consume(route, id)
    assert.ok(raw.calls.includes('stream:a:m:/模型'))
    assert.equal((await raw.listOwnModels('codex'))[0].name, 'Model')
    await settings.set('codex', {})
    assert.equal((await route.listModels('codex'))[0].name, 'Model')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

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

test('legacy Antigravity pool selections admit their family without widening concrete routes', () => {
  const preferences = { poolModels: ['claude-sonnet-5-5-low', 'gemini-4-hydrogen-xhigh', 'gpt-oss-120b-medium'] }
  const original = structuredClone(preferences)
  const catalog = ['claude-sonnet-5-5', 'gemini-4-hydrogen', 'gpt-oss-120b'].map(id => ({ id }))
  for (const { id: family } of catalog) {
    assert.equal(accountAllowsPool(preferences, family, 'antigravity', catalog), true)
    assert.equal(accountAllowsPool(preferences, family, 'codex', catalog), false)
    assert.equal(accountAllowsPool(preferences, family), false)
    assert.equal(accountAllowsPool(preferences, family, 'antigravity'), false, 'no inferred migration without a catalog')
  }
  assert.equal(accountAllowsPool(preferences, 'claude-sonnet-5-5', 'antigravity', [...catalog, { id: 'claude-sonnet-5-5-low' }]), false, 'a live concrete selection must not permit a separate family route')
  assert.equal(accountAllowsPool(preferences, 'claude-sonnet-5-5-low', 'antigravity'), true, 'manual concrete catalogs retain exact matching')
  assert.equal(accountAllowsPool(preferences, 'claude-sonnet-5-5-high', 'antigravity'), false)
  assert.equal(accountAllowsPool({ poolModels: ['claude-sonnet-5-5'] }, 'claude-sonnet-5-5-high', 'antigravity'), false)
  assert.equal(accountAllowsPool({ poolModels: ['gemini-3.8-flash-tiered'] }, 'gemini-3.8-flash', 'antigravity', [{ id: 'gemini-3.8-flash' }]), false)
  assert.equal(accountAllowsPool({ poolModels: ['custom-high'] }, 'custom', 'antigravity', [{ id: 'custom' }]), false)
  assert.equal(accountAllowsPool({ poolModels: [] }, 'claude-sonnet-5-5', 'antigravity', catalog), false)
  assert.equal(accountAllowsPool({ ...preferences, poolEnabled: false }, 'claude-sonnet-5-5', 'antigravity', catalog), false)
  assert.equal(accountAllowsPool(undefined, 'claude-sonnet-5-5', 'antigravity'), true)
  assert.deepEqual(preferences, original)
})

test('saved Antigravity variant allowlists survive grouped discovery across direct and pool routes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-account-groups-'))
  try {
    const path = join(dir, 'settings.json')
    const saved = JSON.stringify({ providers: { antigravity: { accounts: {
      primary: { independentEntry: true, poolModels: ['claude-sonnet-5-5-low', 'claude-sonnet-5-5-high'] },
      excluded: { poolEnabled: false },
    } } }, toolHistory: [] })
    await writeFile(path, saved)
    const settings = new ProviderSettingsStore(path)
    const raw = new Raw()
    const family = 'claude-sonnet-5-5'
    raw.listOwnModels = async provider => groupAntigravityModels([
      { id: `${family}-low`, name: 'Sonnet (Low)', antigravity: { visible: true } },
      { id: `${family}-high`, name: 'Sonnet (High)', antigravity: { visible: true } },
    ]).map(model => ({ provider, id: model.id, name: model.name }))
    const accounts = ['primary', 'excluded'].map(key => ({ key, label: key }))
    let pool: PoolAdapter | undefined
    const route = new AccountPreferencesAdapter({ provider: 'antigravity', adapter: raw, settings,
      accounts: async () => accounts, pool: () => pool })
    const request: GenerateOptions = { provider: 'antigravity', model: family, messages: [] }
    assert.deepEqual((await route.listModels('antigravity')).map(model => model.id), [family, accountModelId('primary', family)])
    const prepared = await route.prepareCall('antigravity', family)
    for await (const _ of prepared.stream(request)) { /* drain */ }
    for await (const _ of route.stream(request)) { /* drain */ }
    assert.deepEqual(raw.calls, [`resolve:primary:${family}`, `stream:primary:${family}`, `stream:primary:${family}`])
    const families = async () => buildAccountPools({ antigravity: { catalogs: await Promise.all(accounts.map(async ({ key }) => {
      const models = await raw.listOwnModels('antigravity', key)
      return { account: key, models: models.filter(model => accountAllowsPool(settings.get('antigravity').accounts?.[key], model.id, 'antigravity', models)) }
    })) } })
    assert.deepEqual((await families()).get(`antigravity/${family}`)?.members, [{ provider: 'antigravity', account: 'primary', model: family }])
    pool = new PoolAdapter({ adapters: { antigravity: route.poolMember() }, health: new PoolHealthRegistry(),
      usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
      defaultAccount: async () => 'primary', families, tiers: {}, onWarn: () => {} })
    const pooled = await route.prepareCall('antigravity', family)
    for await (const _ of pooled.stream(request)) { /* drain */ }
    assert.equal(raw.calls.at(-1), `stream:primary:${family}`)
    assert.equal(raw.calls.some(call => call.includes(':excluded:')), false)
    assert.equal(await readFile(path, 'utf8'), saved, 'routing does not rewrite saved account preferences')
    const revoked = settings.get('antigravity')
    revoked.accounts!.primary.poolModels = []
    await settings.set('antigravity', revoked)
    pool.invalidate()
    await assert.rejects(route.resolveModel('antigravity', family), /No eligible/)
    const callsBeforeRevokedDispatch = raw.calls.length
    await assert.rejects(async () => { for await (const _ of prepared.stream(request)) { /* drain */ } }, /unavailable/)
    assert.equal(raw.calls.length, callsBeforeRevokedDispatch)
    const independent = await route.prepareCall('antigravity', accountModelId('primary', family))
    for await (const _ of independent.stream({ ...request, model: accountModelId('primary', family) })) { /* drain */ }
    assert.equal(raw.calls.at(-1), `stream:primary:${family}`, 'pool exclusion does not change independent-entry policy')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('unrelated Antigravity allowlists are rejected before catalog discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-precheck-'))
  try {
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    await settings.set('antigravity', {
      accounts: {
        unrelated: { poolModels: ['gemini-4-hydrogen'] },
        eligible: { poolModels: ['claude-sonnet-5-5-high'] },
      },
    })
    const raw = new Raw()
    const probed: string[] = []
    raw.listOwnModels = async (provider, account) => {
      probed.push(account ?? '')
      if (account === 'unrelated') throw new Error('should not discover excluded account')
      return [{ provider, id: 'claude-sonnet-5-5', name: 'Sonnet' }]
    }
    const route = new AccountPreferencesAdapter({
      provider: 'antigravity',
      adapter: raw,
      settings,
      accounts: async () => [{ key: 'unrelated', label: 'Unrelated' }, { key: 'eligible', label: 'Eligible' }],
      pool: () => undefined,
    })
    const prepared = await route.prepareCall('antigravity', 'claude-sonnet-5-5')
    for await (const _ of prepared.stream({ provider: 'antigravity', model: 'claude-sonnet-5-5', messages: [] })) { /* drain */ }
    assert.deepEqual(probed, ['eligible', 'eligible'])
    assert.deepEqual(raw.calls, ['resolve:eligible:claude-sonnet-5-5', 'stream:eligible:claude-sonnet-5-5'])
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

test('a timed-out discovery falls back to the account\'s last known catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-timeout-'))
  try {
    class Hanging extends Raw {
      known: string[] | undefined = ['m:/模型']
      override listOwnModels(provider: string, account?: string, signal?: AbortSignal) {
        if (account === undefined) return super.listOwnModels(provider, account)
        return new Promise<{ provider: string; id: string; name: string }[]>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      async lastKnownOwnModels(provider: string) { return this.known?.map(id => ({ provider, id, name: 'Model' })) }
    }
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    const raw = new Hanging()
    const route = new AccountPreferencesAdapter({ provider: 'codex', adapter: raw, settings, accounts: async () => [{ key: 'a', label: 'A' }], pool: () => undefined, discoveryTimeoutMs: 20 })
    assert.deepEqual((await route.listModels('codex')).map(model => model.id), ['m:/模型'])
    await consume(route, 'm:/模型')
    assert.ok(raw.calls.includes('stream:a:m:/模型'))
    raw.known = undefined
    await assert.rejects(consume(route, 'm:/模型'), /No eligible/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
