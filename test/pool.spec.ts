/**
 * Same-subscription account pools: aggregation by catalog wire id, member
 * selection (priority failover and quota-aware urgency with sticky
 * hysteresis), stream failover (switch before the first chunk, never after),
 * extra tier listing, and capability intersection. Members are fake adapters.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PoolAdapter } from '../src/providers/pool.js'
import { unionAccountCatalogs } from '../src/providers/accounts.js'
import { buildAccountPools, poolKey } from '../src/providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef, ProviderPoolSource } from '../src/providers/pool-family.js'
import { memberKey, PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { ProviderUsage } from '../src/providers/common.js'
import type { ProviderId } from '../src/auth/store.js'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'

/** Brand a string as a GenerateOptions sessionId (the loop-stamped session identity). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

const OPTIONS: GenerateOptions = { provider: 'codex', model: 'm', messages: [] }

test('pool canonicalizes legacy aliases before deduplication', async () => {
  const adapter = new FakeAdapter(() => serveOk())
  const pool = new PoolAdapter({
    adapters: { codex: adapter }, health: new PoolHealthRegistry(),
    usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
    defaultAccount: async () => 'canonical',
    resolveAccount: async (_provider, account) => account === 'legacy' ? 'canonical' : account,
    families: async () => new Map([[poolKey('codex', 'm'), { members: [
      { provider: 'codex', model: 'm', account: 'legacy' },
      { provider: 'codex', model: 'm', account: 'canonical' },
    ] }]]), tiers: {}, onWarn: () => {},
  })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(adapter.accounts, ['canonical'])
})

test('pool context intersects each account and each model, including same-provider tiers', async () => {
  const adapter = new FakeAdapter(() => serveOk())
  const visited: string[] = []
  adapter.resolveOwnModel = async (provider: string, model: string, account?: string) => {
    visited.push(`${model}/${account}`)
    return { provider, id: model, name: model, context: { contextWindow: account === 'small' ? 300000 : 872000 } }
  }
  const pool = new PoolAdapter({
    adapters: { codex: adapter }, health: new PoolHealthRegistry(),
    usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
    defaultAccount: async () => 'large', onWarn: () => {},
    families: async () => new Map([[poolKey('codex', 'm'), { members: [
      { provider: 'codex', model: 'm', account: 'large' },
      { provider: 'codex', model: 'm', account: 'small' },
    ] }]]),
    tiers: {},
  })
  assert.equal((await pool.resolveModel('codex', 'm')).context?.contextWindow, 300000)
  assert.deepEqual(visited, ['m/large', 'm/small'])
})

/** A scripted member adapter: serves chunks from `serve`, counts calls and the accounts used. */
class FakeAdapter extends LlmAdapter implements AccountAwareAdapter {
  calls = 0
  readonly accounts: string[] = []
  /** resolveModel calls that bypassed the own-model seam (must stay zero from the pool). */
  directResolves = 0

  constructor(
    private readonly serve: (options: GenerateOptions, account: string) => AsyncIterable<StreamChunk>,
    private readonly resolved: Partial<LlmResolvedModelInfo> = {},
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.directResolves += 1
    return this.resolveOwnModel(provider, model)
  }

  resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.resolved })
  }

  listOwnModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  clearAccountCatalog(): void {}

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamCore(options, 'default')
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async *streamCore(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.accounts.push(account)
    yield* this.serve(options, account)
  }
}

async function* serveOk(text = 'hi'): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* serveFail(error: LlmError): AsyncIterable<StreamChunk> {
  throw error
}

async function* servePartial(error: LlmError): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text: 'partial' }
  throw error
}

async function* serveEmpty(): AsyncIterable<StreamChunk> {
  // A stream that ends without a single chunk.
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** Two Codex accounts of one catalog model (the default account-pool shape). */
const freshAccounts = (): Map<string, PoolDefinition> =>
  new Map([[poolKey('codex', 'm'), {
    members: [
      { provider: 'codex', account: 'a1', model: 'm' },
      { provider: 'codex', account: 'a2', model: 'm' },
    ],
  }]])

interface PoolHarness {
  pool: PoolAdapter
  health: PoolHealthRegistry
  usage: PoolUsageTracker
  warnings: string[]
}

function makePool(
  adapters: Partial<Record<ProviderId, FakeAdapter>>,
  options: {
    strategy?: 'priority' | 'quota_aware'
    switchMargin?: number
    usage?: (provider: ProviderId, account: string) => (() => Promise<ProviderUsage>) | undefined
    families?: Map<string, PoolDefinition>
    tiers?: Record<string, PoolMemberRef[]>
    defaultAccount?: string
    familiesFn?: () => Promise<Map<string, PoolDefinition>>
  } = {},
): PoolHarness {
  const health = new PoolHealthRegistry()
  const usage = new PoolUsageTracker(options.usage ?? (() => undefined))
  const warnings: string[] = []
  const pool = new PoolAdapter({
    adapters,
    health,
    usage,
    strategy: options.strategy ?? 'priority',
    switchMargin: options.switchMargin ?? 2,
    defaultAccount: () => Promise.resolve(options.defaultAccount ?? 'a1'),
    families: options.familiesFn ?? (() => Promise.resolve(options.families ?? freshAccounts())),
    tiers: options.tiers ?? {},
    onWarn: message => { warnings.push(message) },
  })
  return { pool, health, usage, warnings }
}

/** A one-or-more-account pool source (every account sees the same catalog). */
function source(provider: ProviderId, ids: string[], accounts: readonly string[] = ['a1']): ProviderPoolSource {
  const models = ids.map(id => ({ provider, id, name: id }))
  return { catalogs: accounts.map(account => ({ account, models })) }
}

test('unionAccountCatalogs keeps the first account\'s row and appends unique ids', async () => {
  const models = await unionAccountCatalogs(['plus', 'max'], account => Promise.resolve(
    account === 'plus'
      ? [{ provider: 'claude', id: 'sonnet', name: 'Sonnet' }]
      : [
          { provider: 'claude', id: 'sonnet', name: 'Sonnet from Max' },
          { provider: 'claude', id: 'opus', name: 'Opus' },
        ],
  ))
  assert.deepEqual(models.map(model => model.id), ['sonnet', 'opus'])
  assert.equal(models[0].name, 'Sonnet')
})

test('unionAccountCatalogs reorders by catalog priority after the merge', async () => {
  const models = await unionAccountCatalogs(['plus', 'pro'], account => Promise.resolve(
    account === 'plus'
      ? [
          { provider: 'codex', id: 'gpt-5.6-terra', name: 'Terra', priority: 2 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.6-luna', name: 'Luna', priority: 3 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.5', name: 'GPT-5.5', priority: 7 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.4-mini', name: 'Mini', priority: 23 } as LlmModelInfo,
        ]
      : [
          { provider: 'codex', id: 'gpt-5.6-sol', name: 'Sol', priority: 1 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.6-terra', name: 'Terra', priority: 2 } as LlmModelInfo,
          { provider: 'codex', id: 'gpt-5.4', name: 'GPT-5.4', priority: 8 } as LlmModelInfo,
        ],
  ))
  assert.deepEqual(models.map(model => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
  ])
})

test('unionAccountCatalogs sits out an account that throws so siblings still list', async () => {
  const models = await unionAccountCatalogs(
    ['expired', 'ok'],
    account => account === 'ok'
      ? Promise.resolve([{ provider: 'codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }])
      : Promise.reject(new Error('refresh failed')),
  )
  assert.deepEqual(models.map(model => model.id), ['gpt-5.6-sol'])
})

test('unionAccountCatalogs sits out an account that exceeds the timeout', async () => {
  const started = Date.now()
  const models = await unionAccountCatalogs(
    ['plus', 'max'],
    (account, signal) => {
      if (account === 'plus') {
        return Promise.resolve([{ provider: 'claude', id: 'sonnet', name: 'Sonnet' }])
      }
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    },
    { timeoutMs: 20 },
  )
  assert.deepEqual(models.map(model => model.id), ['sonnet'])
  assert.ok(Date.now() - started < 500)
})

test('buildAccountPools pools two accounts of one provider under the wire id', () => {
  const pools = buildAccountPools({
    claude: source('claude', ['claude-sonnet-4-5-20250929'], ['alice', 'bob']),
  })
  assert.deepEqual(pools.get(poolKey('claude', 'claude-sonnet-4-5-20250929'))?.members, [
    { provider: 'claude', account: 'alice', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'claude', account: 'bob', model: 'claude-sonnet-4-5-20250929' },
  ])
})

test('buildAccountPools does not cross providers or invent a family key', () => {
  const pools = buildAccountPools({
    copilot: source('copilot', ['gpt-5.4', 'claude-sonnet-4.5']),
    codex: source('codex', ['gpt-5.4']),
    claude: source('claude', ['claude-sonnet-4-5-20250929']),
  })
  // Each model stays on its own provider — even when the wire id matches.
  assert.deepEqual(pools.get(poolKey('codex', 'gpt-5.4'))?.members.map(member => member.provider), ['codex'])
  assert.deepEqual(pools.get(poolKey('copilot', 'gpt-5.4'))?.members.map(member => member.provider), ['copilot'])
  assert.equal(pools.has(poolKey('claude', 'claude-sonnet-4.5')), false)
  assert.equal(pools.has(poolKey('claude', 'claude-sonnet-4-5-20250929')), true)
})

test('buildAccountPools only pools accounts whose catalog lists the model', () => {
  const pools = buildAccountPools({
    claude: {
      catalogs: [
        { account: 'plus', models: [{ provider: 'claude', id: 'sonnet', name: 'Sonnet' }] },
        { account: 'max', models: [
          { provider: 'claude', id: 'sonnet', name: 'Sonnet' },
          { provider: 'claude', id: 'opus', name: 'Opus' },
        ] },
      ],
    },
  })
  assert.deepEqual(pools.get(poolKey('claude', 'sonnet'))?.members, [
    { provider: 'claude', account: 'plus', model: 'sonnet' },
    { provider: 'claude', account: 'max', model: 'sonnet' },
  ])
  // Only the Max account lists Opus — pinned to Max, still in the picker.
  assert.deepEqual(pools.get(poolKey('claude', 'opus'))?.members, [
    { provider: 'claude', account: 'max', model: 'opus' },
  ])
})

test('buildAccountPools records a single-account model as a one-member route', () => {
  const pools = buildAccountPools({
    claude: source('claude', ['claude-sonnet-5'], ['alice']),
    codex: source('codex', ['gpt-5.4'], ['a1', 'a2']),
  })
  assert.deepEqual(pools.get(poolKey('claude', 'claude-sonnet-5'))?.members, [
    { provider: 'claude', account: 'alice', model: 'claude-sonnet-5' },
  ])
  assert.equal(pools.get(poolKey('codex', 'gpt-5.4'))?.members.length, 2)
})

test('modelsForProvider lists only extra tiers, not account pools', async () => {
  const { pool } = makePool(
    { codex: new FakeAdapter(() => serveOk()) },
    { tiers: { smart: [{ provider: 'codex', account: 'a1', model: 'other' }] } },
  )
  const extras = await pool.modelsForProvider('codex')
  assert.deepEqual(extras.map(model => model.id), ['smart'])
  assert.equal(extras[0].provider, 'codex')
  // The account pool reuses the catalog row — it is not listed again.
  assert.equal(extras.some(model => model.id === 'm'), false)
  assert.deepEqual(await pool.modelsForProvider('claude'), [])
})

test('a model listed by one account is pinned to that account', async () => {
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'pro-only'), {
      members: [{ provider: 'codex', account: 'max', model: 'pro-only' }],
    }],
  ])
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, { families: family })
  assert.equal(await pool.owns('codex', 'pro-only'), true)
  const chunks = await collect(pool.stream({ provider: 'codex', model: 'pro-only', messages: [] }))
  assert.equal((chunks[0] as { text: string }).text, 'max')
  assert.deepEqual(codex.accounts, ['max'])
})

test('owns recognizes the account pool on its provider and catalog id', async () => {
  const { pool } = makePool({ codex: new FakeAdapter(() => serveOk()) })
  assert.equal(await pool.owns('codex', 'm'), true)
  assert.equal(await pool.owns('claude', 'm'), false)
  assert.equal(await pool.owns('codex', 'unknown'), false)
})

test('a tier overriding an account-pool id wins with a single warning', async () => {
  const { pool, warnings } = makePool(
    { codex: new FakeAdapter(() => serveOk()), claude: new FakeAdapter(() => serveOk()) },
    { tiers: { m: [{ provider: 'codex', account: 'a1', model: 'other' }] } },
  )
  const extras = await pool.modelsForProvider('codex')
  assert.deepEqual(extras.map(model => model.id), ['m'])
  await pool.modelsForProvider('codex')
  assert.equal(warnings.filter(message => message.includes('overrides')).length, 1)
})

test('invalidate drops the pools snapshot so the next read reassembles', async () => {
  let reads = 0
  const familiesFn = async (): Promise<Map<string, PoolDefinition>> => {
    reads += 1
    return freshAccounts()
  }
  const { pool } = makePool({ codex: new FakeAdapter(() => serveOk()) }, { familiesFn })
  await pool.owns('codex', 'm')
  await pool.owns('codex', 'm')
  assert.equal(reads, 1)
  pool.invalidate()
  await pool.owns('codex', 'm')
  assert.equal(reads, 2)
})

test('priority: the first healthy account serves', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a1')
  assert.deepEqual(codex.accounts, ['a1'])
  assert.equal(codex.calls, 1)
})

test('priority: a configured member without an account uses the default account', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'm'), { members: [{ provider: 'codex', model: 'm' }, { provider: 'codex', account: 'bob', model: 'm' }] }],
  ])
  const { pool } = makePool({ codex }, { families: family, defaultAccount: 'alice' })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['alice'])
})

test('priority: a cooling account is skipped', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool, health } = makePool({ codex })
  health.markUnavailable(memberKey('codex', 'a1', 'm'), 60_000, 'QUOTA')
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
  assert.deepEqual(codex.accounts, ['a2'])
})

test('priority: a sticky session keeps its account after the leader recovers', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool, health } = makePool({ codex })
  const options = { ...OPTIONS, sessionId: SessionId('s1') }
  health.markUnavailable(memberKey('codex', 'a1', 'm'), 60_000, 'QUOTA')
  await collect(pool.stream(options))
  assert.deepEqual(codex.accounts, ['a2'])
  health.clear('codex')
  const chunks = await collect(pool.stream(options))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
  assert.deepEqual(codex.accounts, ['a2', 'a2'])
})

/** Usage fetchers reading a mutable snapshot, keyed by provider or provider/account. */
function usageFetchers(data: Record<string, ProviderUsage>) {
  return (provider: ProviderId, account: string): (() => Promise<ProviderUsage>) | undefined => {
    const snapshot = data[`${provider}/${account}`] ?? data[provider]
    return snapshot === undefined ? undefined : () => Promise.resolve(snapshot)
  }
}

/** A usage snapshot with one session window of `usedPercent`, resetting in `horizonMs`. */
function windowUsage(usedPercent: number, horizonMs: number): ProviderUsage {
  return {
    supported: true,
    windows: [{ kind: 'session', usedPercent, resetsAt: Date.now() + horizonMs }],
  }
}

test('quota_aware: the most urgent window (soon reset, plenty left) wins', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      'codex/a1': windowUsage(50, 5 * 60 * 60_000),
      'codex/a2': windowUsage(10, 30 * 60_000),
    }),
  })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
})

test('quota_aware: a window past the full mark gates its account out', async () => {
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      'codex/a1': windowUsage(50, 5 * 60 * 60_000),
      'codex/a2': windowUsage(96, 30 * 60_000),
    }),
  })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['a1'])
})

test('quota_aware: an account without telemetry sinks behind a measured one', async () => {
  const copilot = new FakeAdapter((_options, account) => serveOk(account))
  const family = new Map<string, PoolDefinition>([
    [poolKey('copilot', 'm'), {
      members: [
        { provider: 'copilot', account: 'a1', model: 'm' },
        { provider: 'copilot', account: 'a2', model: 'm' },
      ],
    }],
  ])
  const { pool } = makePool({ copilot }, {
    strategy: 'quota_aware',
    families: family,
    // a1 has no fetcher (urgency 0); a2 is measured — even 90% used wins.
    usage: usageFetchers({ 'copilot/a2': windowUsage(90, 60 * 60_000) }),
  })
  await collect(pool.stream({ ...OPTIONS, provider: 'copilot' }))
  assert.deepEqual(copilot.accounts, ['a2'])
})

test('quota_aware: hysteresis holds the sticky account until the margin is beaten', async () => {
  const data: Record<string, ProviderUsage> = {
    'codex/a1': windowUsage(0, 100 * 60_000),
    'codex/a2': windowUsage(0, 10 * 60_000),
  }
  const usage = usageFetchers(data)
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool, usage: tracker } = makePool({ codex }, { strategy: 'quota_aware', switchMargin: 2, usage })
  const options = { ...OPTIONS, sessionId: SessionId('s1') }

  await collect(pool.stream(options))
  assert.deepEqual(codex.accounts, ['a2'])

  data['codex/a2'] = windowUsage(0, 100 * 60_000)
  data['codex/a1'] = windowUsage(0, 60 * 60_000)
  tracker.invalidate('codex')
  const chunks = await collect(pool.stream(options))
  assert.equal((chunks[0] as { text: string }).text, 'a2')

  data['codex/a1'] = windowUsage(0, 30 * 60_000)
  tracker.invalidate('codex')
  const switched = await collect(pool.stream(options))
  assert.equal((switched[0] as { text: string }).text, 'a1')
})

test('stream: a pre-chunk quota failure cools the whole account and fails over', async () => {
  const usageCalls: string[] = []
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1'
      ? serveFail(new LlmError('limited', 'RATE_LIMIT', { providerRetryAfterMs: 42_000 }))
      : serveOk('a2'))
  const { pool, health, usage, warnings } = makePool({ codex }, {
    usage: (provider, account) => {
      if (provider !== 'codex' || account !== 'a1') return undefined
      return () => {
        usageCalls.push(account)
        return Promise.resolve(windowUsage(10, 60 * 60_000))
      }
    },
  })
  const member = { provider: 'codex' as const, account: 'a1', model: 'm' }
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
  assert.deepEqual(codex.accounts, ['a1', 'a2'])
  assert.equal(health.isMemberAvailable('codex', 'a1', 'm'), false)
  assert.equal(health.isMemberAvailable('codex', 'a1', 'other-model'), false)
  assert.equal(health.isMemberAvailable('codex', 'a2', 'm'), true)
  assert.equal(warnings.some(message => message.includes('trying the next member')), true)
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 2)
})

test('stream: a claude quota failure cools only the failing member', async () => {
  const claude = new FakeAdapter((_options, account) =>
    account === 'a1' ? serveFail(new LlmError('lane full', 'QUOTA')) : serveOk('a2'))
  const family = new Map<string, PoolDefinition>([
    [poolKey('claude', 'claude-opus-5'), {
      members: [
        { provider: 'claude', account: 'a1', model: 'claude-opus-5' },
        { provider: 'claude', account: 'a2', model: 'claude-opus-5' },
      ],
    }],
  ])
  const { pool, health } = makePool({ claude }, { families: family })
  await collect(pool.stream({ provider: 'claude', model: 'claude-opus-5', messages: [] }))
  assert.equal(health.isMemberAvailable('claude', 'a1', 'claude-opus-5'), false)
  assert.equal(health.isMemberAvailable('claude', 'a1', 'claude-sonnet-5'), true)
})

test('stream: a transient failure does not invalidate the usage snapshot', async () => {
  const usageCalls: string[] = []
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1' ? serveFail(new LlmError('boom', 'SERVER')) : serveOk('a2'))
  const { pool, usage } = makePool({ codex }, {
    usage: (provider, account) => {
      if (provider !== 'codex' || account !== 'a1') return undefined
      return () => {
        usageCalls.push(account)
        return Promise.resolve(windowUsage(10, 60 * 60_000))
      }
    },
  })
  const member = { provider: 'codex' as const, account: 'a1', model: 'm' }
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
  await collect(pool.stream(OPTIONS))
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
})

test('stream: quota_aware selection never re-hits a usage endpoint still cooling down from a 429 (issue #46)', async () => {
  // Every quota_aware stream() re-consults quotaFor for every usable member
  // (see select() above), so a real completion loop calls it once per
  // request. Anthropic's usage endpoint rate-limits progressively — each hit
  // inside the retry-after window pushes the next one further out — so
  // retrying it on every request permanently locks the account out.
  const usageCalls: string[] = []
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const codex = new FakeAdapter((_options, account) => serveOk(account))
  const { pool } = makePool({ codex }, {
    strategy: 'quota_aware',
    usage: (provider, account) => {
      if (provider !== 'codex' || account !== 'a1') return undefined
      return () => { usageCalls.push(account); return Promise.reject(error) }
    },
  })
  await collect(pool.stream(OPTIONS))
  await collect(pool.stream(OPTIONS))
  await collect(pool.stream(OPTIONS))
  assert.equal(usageCalls.length, 1, 'three requests in a row must cost at most one usage-endpoint hit')
})

test('stream: a caller abandoning the stream closes the member stream', async () => {
  let closed = false
  async function* longServe(): AsyncIterable<StreamChunk> {
    try {
      yield { type: 'text-delta', index: 0, text: 'a' }
      yield { type: 'text-delta', index: 0, text: 'b' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      closed = true
    }
  }
  const { pool } = makePool({ codex: new FakeAdapter(() => longServe()) })
  for await (const chunk of pool.stream(OPTIONS)) {
    void chunk
    break
  }
  assert.equal(closed, true)
})

test('stream: a post-chunk failure propagates without switching accounts', async () => {
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1' ? servePartial(new LlmError('boom', 'SERVER')) : serveOk('a2'))
  const { pool } = makePool({ codex })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER',
  )
  assert.deepEqual(codex.accounts, ['a1'])
})

test('stream: request-fault failures rethrow without trying other accounts', async () => {
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1'
      ? serveFail(new LlmError('too long', 'CONTEXT_WINDOW_EXCEEDED'))
      : serveOk('a2'))
  const { pool, health } = makePool({ codex })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.deepEqual(codex.accounts, ['a1'])
  assert.equal(health.isAvailable(memberKey('codex', 'a1', 'm')), true)
})

test('stream: an empty first stream counts as a transient failure', async () => {
  const codex = new FakeAdapter((_options, account) =>
    account === 'a1' ? serveEmpty() : serveOk('a2'))
  const { pool } = makePool({ codex })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'a2')
})

test('stream: an exhausted pool throws RATE_LIMIT with the earliest recovery hint', async () => {
  const codex = new FakeAdapter((_options, account) =>
    serveFail(new LlmError(account, 'RATE_LIMIT', {
      providerRetryAfterMs: account === 'a1' ? 42_000 : 90_000,
    })))
  const { pool } = makePool({ codex })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'RATE_LIMIT')
      const retryAfter = error.failure.providerRetryAfterMs
      assert.ok(retryAfter !== undefined && retryAfter > 0 && retryAfter <= 42_000)
      return true
    },
  )
})

test('resolveModel uses the pool display name', async () => {
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'm'), {
      members: [
        { provider: 'codex', account: 'a1', model: 'm' },
        { provider: 'codex', account: 'a2', model: 'm' },
      ],
      name: 'GPT-5.4',
      description: 'Latest frontier model.',
    }],
  ])
  const { pool } = makePool({ codex: new FakeAdapter(() => serveOk()) }, { families: family })
  const resolved = await pool.resolveModel('codex', 'm')
  assert.equal(resolved.name, 'GPT-5.4')
  assert.equal(resolved.description, 'Latest frontier model.')
})

test('resolveModel intersects member capabilities conservatively', async () => {
  const first = new FakeAdapter(() => serveOk(), {
    context: { contextWindow: 200_000 },
    defaultMaxTokens: 128_000,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    },
    inputModalities: ['text', 'image'],
  })
  const second = new FakeAdapter(() => serveOk(), {
    context: { contextWindow: 100_000 },
    defaultMaxTokens: 64_000,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('medium'),
    },
    inputModalities: ['text'],
  })
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'smart'), {
      members: [
        { provider: 'codex', account: 'a1', model: 'big' },
        { provider: 'claude', account: 'a1', model: 'small' },
      ],
      extra: true,
    }],
  ])
  const { pool } = makePool({ codex: first, claude: second }, { families: family })
  const resolved = await pool.resolveModel('codex', 'smart')
  assert.equal(resolved.context?.contextWindow, 100_000)
  assert.equal(resolved.defaultMaxTokens, 64_000)
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['medium', 'high'])
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  assert.deepEqual(resolved.inputModalities, ['text'])
})

/** A member whose resolveModel always fails (misconfigured id, logged out). */
class FailingResolveAdapter extends FakeAdapter {
  constructor() {
    super(() => serveOk())
  }

  override resolveOwnModel(): Promise<LlmResolvedModelInfo> {
    return Promise.reject(new LlmError('logged out', 'AUTH'))
  }
}

test('resolveModel skips a member that fails to resolve and warns once', async () => {
  const ok = new FakeAdapter(() => serveOk(), { context: { contextWindow: 200_000 } })
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'smart'), {
      members: [
        { provider: 'codex', account: 'a1', model: 'm' },
        { provider: 'claude', account: 'a1', model: 'm' },
      ],
    }],
  ])
  const { pool, warnings } = makePool({ codex: ok, claude: new FailingResolveAdapter() }, { families: family })
  const resolved = await pool.resolveModel('codex', 'smart')
  assert.equal(resolved.context?.contextWindow, 200_000)
  await pool.resolveModel('codex', 'smart')
  assert.equal(warnings.filter(message => message.includes('failed to resolve')).length, 1)
})

test('resolveModel throws NO_ADAPTER only when every member fails to resolve', async () => {
  const { pool } = makePool({
    codex: new FailingResolveAdapter(),
  })
  await assert.rejects(
    pool.resolveModel('codex', 'm'),
    (error: unknown) => error instanceof LlmError && error.code === 'NO_ADAPTER',
  )
})

test('resolveModel reports unknown modalities when members share none', async () => {
  const family = new Map<string, PoolDefinition>([
    [poolKey('codex', 'smart'), {
      members: [
        { provider: 'codex', account: 'a1', model: 'vision' },
        { provider: 'claude', account: 'a1', model: 'text' },
      ],
    }],
  ])
  const { pool } = makePool({
    codex: new FakeAdapter(() => serveOk(), { inputModalities: ['image'] }),
    claude: new FakeAdapter(() => serveOk(), { inputModalities: ['text'] }),
  }, { families: family })
  const resolved = await pool.resolveModel('codex', 'smart')
  assert.equal(resolved.inputModalities, undefined)
})

test('resolveModel: a pool id equal to the catalog wire id cannot recurse', async () => {
  const codex = new FakeAdapter(() => serveOk(), { context: { contextWindow: 100_000 } })
  const { pool } = makePool({ codex })
  const resolved = await pool.resolveModel('codex', 'm')
  assert.equal(resolved.context?.contextWindow, 100_000)
  assert.equal(codex.directResolves, 0, 'member resolution went through resolveOwnModel')
})
