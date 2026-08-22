/**
 * Login-gated model catalogs and live discovery: `listModels` returns [] when
 * logged out, maps discovered catalogs when logged in (via an injected fetch,
 * no network), and falls back to the static catalog with a warning on
 * discovery failure.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { CodexAdapter, codexRequestBody, fetchCodexModels } from '../src/providers/codex.js'
import { GrokAdapter } from '../src/providers/grok.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { CopilotAdapter, fetchCopilotModels } from '../src/providers/copilot.js'
import { ModelCatalogCache, TokenManager } from '../src/providers/common.js'
import type { CatalogPersistence, CatalogSnapshot, FetchFn } from '../src/providers/common.js'
import type { ClaudeSession, CodexSession, CopilotSession, GrokSession } from '../src/auth/store.js'

const STATIC_CODEX = [{ id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }]
const STATIC_CLAUDE = [{ id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }]
const STATIC_GROK = [{ id: 'grok-4', name: 'Grok 4' }]

const codexSession: CodexSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}
const claudeSession: ClaudeSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'scope',
}
const grokSession: GrokSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  tokenEndpoint: 'https://auth.x.ai/token',
}
const copilotSession: CopilotSession = {
  accessToken: 'copilot-at',
  refreshToken: 'gh-token',
  expiresAt: Date.now() + 3_600_000,
}

/** A TokenManager over an in-memory session; refresh never fires in these tests. */
function memoryTokens<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  initial: S | undefined,
): TokenManager<S> {
  let stored = initial
  return new TokenManager<S>({
    displayName: 'Test',
    preemptMs: 0,
    load: () => Promise.resolve(stored),
    save: (session) => {
      stored = session
      return Promise.resolve()
    },
    remove: () => {
      stored = undefined
      return Promise.resolve()
    },
    refresh: session => Promise.resolve(session),
    isPermanent: () => false,
  })
}

/** A fetch implementation answering one JSON payload; records invocation count. */
function fakeFetch(payload: unknown, status = 200): { fetchFn: FetchFn; calls: () => number } {
  let calls = 0
  const fetchFn: FetchFn = (() => {
    calls += 1
    return Promise.resolve(new Response(JSON.stringify(payload), { status }))
  }) as FetchFn
  return { fetchFn, calls: () => calls }
}

function codexAdapter(overrides: {
  session?: CodexSession
  discovery?: boolean
  fetchFn?: FetchFn
  warnings?: string[]
}): CodexAdapter {
  return new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(overrides.session),
    discovery: overrides.discovery ?? true,
    ...overrides.fetchFn === undefined ? {} : { fetchFn: overrides.fetchFn },
    ...overrides.warnings === undefined
      ? {}
      : { onWarn: (message: string) => { overrides.warnings?.push(message) } },
  })
}

const CODEX_MODELS_PAYLOAD = {
  models: [
    {
      slug: 'gpt-5.2-codex',
      display_name: 'GPT-5.2 Codex',
      description: 'newest',
      context_window: 500_000,
      supported_reasoning_levels: [
        { effort: 'low', description: 'fast' },
        { effort: 'high', description: 'thorough' },
      ],
      default_reasoning_level: 'high',
      visibility: 'list',
      priority: 2,
    },
    {
      slug: 'gpt-5.1-codex',
      display_name: 'GPT-5.1 Codex',
      visibility: 'list',
      priority: 1,
    },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
    { slug: 'gpt-none', display_name: 'None', visibility: 'none', priority: 0 },
  ],
}

test('listModels returns [] when logged out (codex, claude, grok)', async () => {
  const codex = codexAdapter({})
  assert.deepEqual(await codex.listModels('codex'), [])
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens<ClaudeSession>(undefined),
    discovery: false,
  })
  assert.deepEqual(await claude.listModels('claude'), [])
  const grok = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens<GrokSession>(undefined),
    discovery: true,
    fetchFn: fakeFetch({ data: [{ id: 'grok-9' }] }).fetchFn,
  })
  assert.deepEqual(await grok.listModels('grok'), [])
})

test('codex discovery maps, filters hidden entries, and sorts by priority', async () => {
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex', 'gpt-5.2-codex'])
  assert.equal(models[1].name, 'GPT-5.2 Codex')
  assert.equal(models[1].description, 'newest')
  // The TTL cache serves the second call without another fetch.
  await adapter.listModels('codex')
  assert.equal(calls(), 1)
})

test('resolveModel prefers discovered context window and reasoning efforts', async () => {
  const { fetchFn } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  await adapter.listModels('codex')
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.equal(resolved.context?.contextWindow, 500_000)
  assert.deepEqual(
    resolved.reasoning?.efforts.map(effort => effort.id),
    ['low', 'high'],
  )
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  // A model the catalog did not advertise falls back to static defaults.
  const fallback = await adapter.resolveModel('codex', 'gpt-unknown')
  assert.equal(fallback.context?.contextWindow, 400_000)
  assert.equal(fallback.reasoning?.efforts.length, 5)
})

test('codex discovery failure falls back to the static catalog with a warning', async () => {
  const warnings: string[] = []
  const { fetchFn } = fakeFetch({ error: 'boom' }, 500)
  const adapter = codexAdapter({ session: codexSession, fetchFn, warnings })
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /codex model discovery failed/)
})

test('codex config override wins over discovery entirely', async () => {
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn, discovery: false })
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex'])
  assert.equal(calls(), 0)
})

test('grok discovery maps the data array', async () => {
  const { fetchFn } = fakeFetch({ data: [{ id: 'grok-4-1' }, { id: 'grok-code-2' }, { nope: true }] })
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn,
  })
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4-1', 'grok-code-2'])
})

test('claude logged in returns the static catalog', async () => {
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  const models = await claude.listModels('claude')
  assert.deepEqual(models.map(model => model.id), ['claude-opus-4-5'])
})

test('fetchCodexModels tolerates entries without visibility or priority', async () => {
  const models = await fetchCodexModels(codexSession, fakeFetch({
    models: [{ slug: 'bare', display_name: 'Bare' }],
  }).fetchFn)
  assert.deepEqual(models, [{ id: 'bare', name: 'Bare' }])
})

test('codex discovery flags models whose catalog advertises a fast service tier', async () => {
  const models = await fetchCodexModels(codexSession, fakeFetch({
    models: [
      {
        slug: 'gpt-5.2-codex',
        display_name: 'GPT-5.2 Codex',
        service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing.' }],
        priority: 1,
      },
      // The legacy catalog spelling (codex-rs additional_speed_tiers).
      { slug: 'gpt-5.2-codex-spark', display_name: 'Spark', additional_speed_tiers: ['fast'], priority: 2 },
      // A model without a fast tier gets no flag.
      { slug: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex', priority: 3 },
    ],
  }).fetchFn)
  assert.deepEqual(models.map(model => model.id), ['gpt-5.2-codex', 'gpt-5.2-codex-spark', 'gpt-5.1-codex'])
  assert.deepEqual(models.map(model => model.fastTier ?? false), [true, true, false])

  const { fetchFn } = fakeFetch({
    models: [
      { slug: 'gpt-5.2-codex', service_tiers: [{ id: 'priority' }], priority: 1 },
      { slug: 'gpt-5.1-codex', priority: 2 },
    ],
  })
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  assert.deepEqual(await adapter.fastCapableModels(), ['gpt-5.2-codex'])
  assert.equal(await adapter.supportsFastTier('gpt-5.2-codex'), true)
  assert.equal(await adapter.supportsFastTier('gpt-5.1-codex'), false)
  // Discovery off (config override): no fast capability is claimed.
  const staticAdapter = codexAdapter({ session: codexSession, discovery: false })
  assert.deepEqual(await staticAdapter.fastCapableModels(), [])
  assert.equal(await staticAdapter.supportsFastTier('gpt-5.1-codex'), false)
  // Logged out: no fast models, so the Speed toggle hides after logout.
  const loggedOut = codexAdapter({ fetchFn })
  assert.deepEqual(await loggedOut.fastCapableModels(), [])
})

test('codexRequestBody sends service_tier priority only on the fast tier', () => {
  const base = codexRequestBody(
    { provider: 'codex', model: 'gpt-5.1-codex', messages: [] },
    { input: [] },
    false,
  )
  assert.equal(base.model, 'gpt-5.1-codex')
  assert.equal('service_tier' in base, false)

  const fast = codexRequestBody(
    {
      provider: 'codex',
      model: 'gpt-5.1-codex',
      messages: [],
      reasoningEffort: ReasoningEffortId('high'),
    },
    { input: [] },
    true,
  )
  assert.equal(fast.model, 'gpt-5.1-codex')
  assert.equal(fast.service_tier, 'priority')
  assert.deepEqual(fast.reasoning, { effort: 'high', summary: 'auto' })
})

test('modalities: codex and claude declare image input; grok gates text-only models', async () => {
  const codex = codexAdapter({ session: codexSession, discovery: false })
  const codexModels = await codex.listModels('codex')
  assert.deepEqual(codexModels[0].inputModalities, ['text', 'image'])
  const codexResolved = await codex.resolveModel('codex', 'gpt-5.1-codex')
  assert.deepEqual(codexResolved.inputModalities, ['text', 'image'])

  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  assert.deepEqual((await claude.listModels('claude'))[0].inputModalities, ['text', 'image'])

  const grok = new GrokAdapter({
    models: [{ id: 'grok-4' }, { id: 'grok-code-fast-1' }, { id: 'grok-embedding-1' }],
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: false,
  })
  const grokModels = await grok.listModels('grok')
  assert.deepEqual(grokModels[0].inputModalities, ['text', 'image'])
  assert.deepEqual(grokModels[1].inputModalities, ['text'])
  assert.deepEqual(grokModels[2].inputModalities, ['text'])
  assert.deepEqual((await grok.resolveModel('grok', 'grok-4.6')).inputModalities, ['text', 'image'])
  assert.deepEqual((await grok.resolveModel('grok', 'grok-code-fast-1')).inputModalities, ['text'])
})

test('modalities: config entry inputModalities win over the provider default', async () => {
  const adapter = new CodexAdapter({
    models: [{ id: 'gpt-5.1-codex', inputModalities: ['text'] }],
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(codexSession),
    discovery: false,
  })
  assert.deepEqual((await adapter.listModels('codex'))[0].inputModalities, ['text'])
  assert.deepEqual((await adapter.resolveModel('codex', 'gpt-5.1-codex')).inputModalities, ['text'])
})

test('grok discovery drops generation and embedding models', async () => {
  const { fetchFn } = fakeFetch({
    data: [
      { id: 'grok-4.6' },
      { id: 'grok-build-0.1' },
      { id: 'grok-imagine-image' },
      { id: 'grok-imagine-image-2.0' },
      { id: 'grok-imagine-video-1.5' },
      { id: 'grok-embedding-1' },
    ],
  })
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn,
  })
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4.6', 'grok-build-0.1'])
})

/** The api.x.ai model list: authoritative for which models exist. */
const GROK_API_PAYLOAD = { data: [{ id: 'grok-4.6' }, { id: 'grok-4.5' }, { id: 'grok-build-0.1' }] }
/**
 * The CLI catalog: contributes reasoning/name/context per model. grok-4.6
 * marks two levels `default: true` like the live payload does, so the test
 * proves the top-level `reasoning_effort` field wins.
 */
const GROK_CLI_PAYLOAD = {
  data: [
    {
      id: 'grok-4.6',
      name: 'Grok 4.6',
      description: 'frontier',
      context_window: 500_000,
      supports_reasoning_effort: true,
      reasoning_effort: 'high',
      reasoning_efforts: [
        { value: 'xhigh', label: 'Extra High Effort', default: true },
        { value: 'high', label: 'High Effort', description: 'extensive reasoning', default: true },
        { value: 'medium', label: 'Medium Effort' },
        { value: 'low', label: 'Low Effort' },
      ],
    },
    {
      id: 'grok-4.5',
      name: 'Grok 4.5',
      context_window: 500_000,
      supports_reasoning_effort: true,
      reasoning_effort: 'high',
      reasoning_efforts: [
        { value: 'high', label: 'High Effort', default: true },
        { value: 'medium', label: 'Medium Effort' },
        { value: 'low', label: 'Low Effort' },
      ],
    },
  ],
}

/** A fetch dispatching on URL: the CLI catalog host vs the api.x.ai list. */
function grokDualFetch(cliPayload: unknown = GROK_CLI_PAYLOAD, cliStatus = 200): FetchFn {
  return ((url: unknown) => {
    const isCliCatalog = String(url).includes('cli-chat-proxy')
    return Promise.resolve(new Response(
      JSON.stringify(isCliCatalog ? cliPayload : GROK_API_PAYLOAD),
      { status: isCliCatalog ? cliStatus : 200 },
    ))
  }) as FetchFn
}

test('grok discovery merges CLI-catalog reasoning metadata by model id', async () => {
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch(),
  })
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.name), ['Grok 4.6', 'Grok 4.5', 'grok-build-0.1'])
  assert.equal(models[0].description, 'frontier')

  const g46 = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(g46.reasoning?.efforts.map(effort => effort.id), ['xhigh', 'high', 'medium', 'low'])
  assert.equal(g46.reasoning?.efforts[1].name, 'High Effort')
  assert.equal(g46.reasoning?.efforts[1].description, 'extensive reasoning')
  // The top-level reasoning_effort wins over the double default flags.
  assert.equal(g46.reasoning?.defaultEffort, 'high')
  assert.equal(g46.context?.contextWindow, 500_000)

  const g45 = await adapter.resolveModel('grok', 'grok-4.5')
  assert.deepEqual(g45.reasoning?.efforts.map(effort => effort.id), ['high', 'medium', 'low'])

  // A model the CLI catalog does not cover exposes no efforts.
  const build = await adapter.resolveModel('grok', 'grok-build-0.1')
  assert.equal(build.reasoning, undefined)
  assert.equal(build.context?.contextWindow, 256_000)
})

test('grok discovery survives a CLI catalog failure with a warning', async () => {
  const warnings: string[] = []
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch({ error: 'boom' }, 500),
    onWarn: message => warnings.push(message),
  })
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4.6', 'grok-4.5', 'grok-build-0.1'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /CLI catalog fetch failed/)
  assert.equal((await adapter.resolveModel('grok', 'grok-4.6')).reasoning, undefined)
})

test('grok entries without reasoning support expose no efforts', async () => {
  const cliPayload = {
    data: [
      { id: 'grok-4.6', supports_reasoning_effort: false },
      { id: 'grok-4.5', supports_reasoning_effort: true, reasoning_efforts: [] },
    ],
  }
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch(cliPayload),
  })
  await adapter.listModels('grok')
  assert.equal((await adapter.resolveModel('grok', 'grok-4.6')).reasoning, undefined)
  assert.equal((await adapter.resolveModel('grok', 'grok-4.5')).reasoning, undefined)
})

test('empty discovery payload falls back to the static catalog with a warning', async () => {
  const warnings: string[] = []
  const { fetchFn } = fakeFetch({ models: [] })
  const adapter = codexAdapter({ session: codexSession, fetchFn, warnings })
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /empty catalog/)
})

/** An in-memory CatalogPersistence fake with a snapshot inspection hook. */
function memoryCatalogStore(initial?: CatalogSnapshot): CatalogPersistence & {
  saved: () => CatalogSnapshot | undefined
} {
  let stored = initial
  return {
    load: () => Promise.resolve(stored),
    save: (snapshot) => {
      stored = snapshot
      return Promise.resolve()
    },
    clear: () => {
      stored = undefined
      return Promise.resolve()
    },
    saved: () => stored,
  }
}

/** Let fire-and-forget promise chains (background refresh, write-through) settle. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

test('ModelCatalogCache serves the last-known catalog while a refresh runs or fails', async () => {
  // ttlMs 0 makes every entry instantly stale, so each resolve exercises the
  // stale-while-revalidate path.
  const cache = new ModelCatalogCache(undefined, 0)
  const first = await cache.resolve(() => Promise.resolve([{ id: 'a', name: 'A' }]))
  assert.deepEqual(first?.map(model => model.id), ['a'])
  // A stale entry answers immediately even when the background refresh fails.
  const second = await cache.resolve(() => Promise.reject(new Error('offline')))
  assert.deepEqual(second?.map(model => model.id), ['a'])
  await settle()
  // A successful background refresh serves the NEXT resolve.
  const third = await cache.resolve(() => Promise.resolve([{ id: 'b', name: 'B' }]))
  assert.deepEqual(third?.map(model => model.id), ['a'])
  await settle()
  const fourth = await cache.resolve(() => Promise.reject(new Error('unused')))
  assert.deepEqual(fourth?.map(model => model.id), ['b'])
})

test('ModelCatalogCache resolve on a cold cache without persistence awaits one fetch', async () => {
  const cache = new ModelCatalogCache()
  assert.equal(await cache.resolve(() => Promise.reject(new Error('offline'))), undefined)
  const models = await cache.resolve(() => Promise.resolve([{ id: 'a', name: 'A' }]))
  assert.deepEqual(models?.map(model => model.id), ['a'])
})

test('grok resolveModel on a cold cache fetches the catalog itself', async () => {
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch(),
  })
  // No listModels first: after a restart, a resumed session's prepareCall can
  // be the first caller.
  const resolved = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['xhigh', 'high', 'medium', 'low'])
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
})

test('grok resolveModel falls back to the persisted catalog when discovery fails', async () => {
  const store = memoryCatalogStore({
    // One hour old: well past the TTL, so only the fallback path can serve it.
    at: Date.now() - 3_600_000,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500_000,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('high'), name: 'High Effort' },
          { id: ReasoningEffortId('low'), name: 'Low Effort' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  const failing: FetchFn = () => Promise.reject(new Error('offline'))
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: failing,
    catalogStore: store,
  })
  const resolved = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['high', 'low'])
  assert.equal(resolved.context?.contextWindow, 500_000)
})

test('grok resolveModel survives discovery failure with no persisted catalog', async () => {
  const failing: FetchFn = () => Promise.reject(new Error('offline'))
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: failing,
  })
  const resolved = await adapter.resolveModel('grok', 'grok-4.6')
  assert.equal(resolved.reasoning, undefined)
  assert.equal(resolved.context?.contextWindow, 256_000)
})

test('grok discovery writes the fetched catalog through to the store', async () => {
  const store = memoryCatalogStore()
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch(),
    catalogStore: store,
  })
  await adapter.listModels('grok')
  await settle()
  const snapshot = store.saved()
  assert.notEqual(snapshot, undefined)
  const g46 = snapshot?.models.find(model => model.id === 'grok-4.6')
  assert.equal(g46?.reasoning?.defaultEffort, 'high')
})

test('codex resolveModel on a cold cache fetches the catalog itself', async () => {
  const { fetchFn } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(resolved.context?.contextWindow, 500_000)
})

const STATIC_COPILOT = [{
  id: 'gpt-4o',
  name: 'GPT-4o',
  inputModalities: ['text', 'image'] as ('text' | 'image')[],
}]

function copilotAdapter(overrides: {
  session?: CopilotSession
  discovery?: boolean
  fetchFn?: FetchFn
  warnings?: string[]
}): CopilotAdapter {
  return new CopilotAdapter({
    models: STATIC_COPILOT,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(overrides.session),
    discovery: overrides.discovery ?? true,
    ...overrides.fetchFn === undefined ? {} : { fetchFn: overrides.fetchFn },
    ...overrides.warnings === undefined
      ? {}
      : { onWarn: (message: string) => { overrides.warnings?.push(message) } },
  })
}

const COPILOT_MODELS_PAYLOAD = {
  data: [
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      supported_endpoints: ['/chat/completions'],
      capabilities: {
        supports: { vision: true, tool_calls: true },
        limits: { max_context_window_tokens: 1_000_000 },
      },
    },
    {
      id: 'o4-mini',
      name: 'o4 Mini',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      supported_endpoints: ['/chat/completions', '/responses'],
      capabilities: {
        supports: { vision: false, reasoning_effort: ['low', 'medium', 'high'] },
      },
    },
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      // The newer GPT families only list the Responses endpoint.
      supported_endpoints: ['/responses', 'ws:/responses'],
      capabilities: {
        supports: { vision: true, reasoning_effort: ['low', 'medium', 'high', 'xhigh'] },
        limits: { max_context_window_tokens: 1_050_000 },
      },
    },
    { id: 'picker-hidden', model_picker_enabled: false, policy: { state: 'enabled' } },
    { id: 'policy-disabled', model_picker_enabled: true, policy: { state: 'disabled' } },
    {
      id: 'ws-only',
      model_picker_enabled: true,
      policy: { state: 'enabled' },
      supported_endpoints: ['ws:/responses'],
    },
  ],
}

test('copilot listModels returns [] when logged out', async () => {
  const adapter = copilotAdapter({})
  assert.deepEqual(await adapter.listModels('copilot'), [])
})

test('copilot listModels maps the discovered catalog and filters unusable entries', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const adapter = copilotAdapter({ session: copilotSession, fetchFn })
  const models = await adapter.listModels('copilot')
  assert.deepEqual(models.map(model => model.id), ['gpt-4.1', 'o4-mini', 'gpt-5.6-sol'])
  // Vision support from the catalog becomes the model's input modalities.
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(models[1].inputModalities, ['text'])
  assert.deepEqual(models[2].inputModalities, ['text', 'image'])
  assert.equal(models[0].name, 'GPT-4.1')
})

test('copilot discovery records the wire protocol per model', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const discovered = await fetchCopilotModels(copilotSession, fetchFn)
  assert.deepEqual(discovered.map(model => [model.id, model.copilotWire ?? 'chat-completions']), [
    ['gpt-4.1', 'chat-completions'],
    // Both endpoints listed → the chat wire (models listing both accept it),
    // with /responses availability recorded for the tools+effort reroute.
    ['o4-mini', 'chat-completions'],
    ['gpt-5.6-sol', 'responses'],
  ])
  // The dual-protocol flag rides only entries listing /responses.
  assert.equal(discovered[0]?.copilotResponses, undefined)
  assert.equal(discovered[1]?.copilotResponses, true)
  assert.equal(discovered[2]?.copilotResponses, true)
  assert.equal(discovered[2]?.contextWindow, 1_050_000)
})

test('copilot discovery maps the supports.reasoning_effort array into efforts', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const discovered = await fetchCopilotModels(copilotSession, fetchFn)
  // A model without the array (or with null/empty) exposes no efforts.
  assert.equal(discovered[0]?.reasoning, undefined)
  const o4 = discovered[1]?.reasoning
  assert.deepEqual(o4?.efforts.map(effort => [effort.id, effort.name]), [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ])
  assert.equal(o4?.defaultEffort, undefined)
  const sol = discovered[2]?.reasoning
  assert.equal(sol?.efforts[3]?.name, 'Extra High')
})

test('copilot discovery tolerates duplicate, empty, and null effort entries', async () => {
  const models = await fetchCopilotModels(copilotSession, fakeFetch({
    data: [
      {
        id: 'gpt-5.1',
        name: 'GPT-5.1',
        model_picker_enabled: true,
        policy: { state: 'enabled' },
        supported_endpoints: ['/chat/completions'],
        capabilities: { supports: { reasoning_effort: ['high', 'high', '', 'max'] } },
      },
      {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        model_picker_enabled: true,
        policy: { state: 'enabled' },
        supported_endpoints: ['/chat/completions'],
        capabilities: { supports: { reasoning_effort: null } },
      },
    ],
  }).fetchFn)
  // Duplicates collapse and empty strings drop (the harness rejects duplicate
  // effort ids); "max" survives with a display name.
  assert.deepEqual(models[0]?.reasoning?.efforts.map(effort => [effort.id, effort.name]), [
    ['high', 'High'],
    ['max', 'Max'],
  ])
  assert.equal(models[1]?.reasoning, undefined)
})

test('copilot resolveModel serves discovered reasoning efforts', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const adapter = copilotAdapter({ session: copilotSession, fetchFn })
  await adapter.listModels('copilot')
  const resolved = await adapter.resolveModel('copilot', 'o4-mini')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  const sol = await adapter.resolveModel('copilot', 'gpt-5.6-sol')
  assert.deepEqual(sol.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
  // A model the catalog listed without efforts (and one it filtered out,
  // falling back to static metadata) claims no reasoning at all: the harness
  // then rejects explicit efforts before the API can 400.
  assert.equal((await adapter.resolveModel('copilot', 'gpt-4.1')).reasoning, undefined)
  assert.equal((await adapter.resolveModel('copilot', 'policy-disabled')).reasoning, undefined)
})

test('copilot resolveModel serves discovered context windows and modalities', async () => {
  const { fetchFn } = fakeFetch(COPILOT_MODELS_PAYLOAD)
  const adapter = copilotAdapter({ session: copilotSession, fetchFn })
  const resolved = await adapter.resolveModel('copilot', 'gpt-4.1')
  assert.equal(resolved.context?.contextWindow, 1_000_000)
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  // A model the catalog filtered out falls back to static/defaults.
  const missing = await adapter.resolveModel('copilot', 'policy-disabled')
  assert.equal(missing.context?.contextWindow, 128_000)
  assert.deepEqual(missing.inputModalities, ['text'])
})

test('copilot listModels falls back to the static catalog on discovery failure', async () => {
  const { fetchFn } = fakeFetch({ message: 'boom' }, 500)
  const warnings: string[] = []
  const adapter = copilotAdapter({ session: copilotSession, fetchFn, warnings })
  const models = await adapter.listModels('copilot')
  assert.deepEqual(models.map(model => model.id), ['gpt-4o'])
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.equal(warnings.length, 1)
})

test('copilot listModels treats an empty discovered catalog as a failure', async () => {
  const { fetchFn } = fakeFetch({ data: [] })
  const warnings: string[] = []
  const adapter = copilotAdapter({ session: copilotSession, fetchFn, warnings })
  const models = await adapter.listModels('copilot')
  assert.deepEqual(models.map(model => model.id), ['gpt-4o'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /empty catalog/)
})

test('copilot listModels without discovery serves the static catalog', async () => {
  const adapter = copilotAdapter({ session: copilotSession, discovery: false })
  const models = await adapter.listModels('copilot')
  assert.deepEqual(models.map(model => model.id), ['gpt-4o'])
})
