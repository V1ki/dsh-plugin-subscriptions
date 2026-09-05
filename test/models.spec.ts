/**
 * Login-gated model catalogs and live discovery: `listModels` returns [] when
 * logged out, maps discovered catalogs when logged in (via an injected fetch,
 * no network), and falls back to the static catalog with a warning on
 * discovery failure.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { CODEX_CLIENT_VERSION, CODEX_MODELS_URL, CodexAdapter, codexRequestBody, fetchCodexModels } from '../src/providers/codex.js'
import { GrokAdapter } from '../src/providers/grok.js'
import { ClaudeAdapter, claudeRequestBody } from '../src/providers/claude.js'
import { CopilotAdapter, fetchCopilotModels } from '../src/providers/copilot.js'
import { ModelCatalogCache } from '../src/providers/common.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { CatalogPersistence, CatalogSnapshot, FetchFn } from '../src/providers/common.js'
import type { ClaudeSession, CodexSession, CopilotSession, GrokSession } from '../src/auth/store.js'
import { withTimeout } from '../src/providers/common.js'

const STATIC_CODEX = [{ id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }]
const STATIC_CLAUDE = [{ id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }]
const STATIC_GROK = [{ id: 'grok-4', name: 'Grok 4' }]

test('Codex discovery sends the current client version', async () => {
  let requestedUrl = ''
  const fetchFn: FetchFn = ((url: string) => {
    requestedUrl = url
    return Promise.resolve(new Response(JSON.stringify({ models: [{ slug: 'model' }] })))
  }) as FetchFn
  await fetchCodexModels(codexSession, fetchFn)
  assert.equal(requestedUrl, `${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`)
  assert.equal(CODEX_CLIENT_VERSION, '0.153.4')
})

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

/** An AccountTokenManager over several in-memory sessions (insertion order = default first). */
function memoryAccounts<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  accounts: Record<string, S>,
): AccountTokenManager<S> {
  const stored = new Map(Object.entries(accounts))
  return new AccountTokenManager<S>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: session => Promise.resolve(session),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, session]) => ({ key, session }))),
      get: account => Promise.resolve(
        account === undefined ? stored.values().next().value : stored.get(account),
      ),
      save: (account, session) => {
        stored.set(account, session)
        return Promise.resolve()
      },
      remove: account => {
        stored.delete(account)
        return Promise.resolve()
      },
    },
  })
}

/** An AccountTokenManager over an in-memory session; refresh never fires in these tests. */
function memoryTokens<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  initial: S | undefined,
): AccountTokenManager<S> {
  let stored = initial
  return new AccountTokenManager<S>({
    provider: 'codex',
    displayName: 'Test',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: session => Promise.resolve(session),
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve(stored === undefined ? [] : [{ key: 'acct', session: stored }]),
      get: () => Promise.resolve(stored),
      save: (_account, session) => {
        stored = session
        return Promise.resolve()
      },
      remove: () => {
        stored = undefined
        return Promise.resolve()
      },
    },
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
  defaultEffortOf?: (model: string) => string | undefined
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
    ...overrides.defaultEffortOf === undefined ? {} : { defaultEffortOf: overrides.defaultEffortOf },
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

test('a configured default effort wins over the discovered one (codex)', async () => {
  const { fetchFn } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({
    session: codexSession,
    fetchFn,
    defaultEffortOf: model => model === 'gpt-5.2-codex' ? 'low' : undefined,
  })
  await adapter.listModels('codex')
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.equal(resolved.reasoning?.defaultEffort, 'low')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'high'])
  // Unconfigured models keep the built-in default, untouched by the override.
  const other = await adapter.resolveModel('codex', 'gpt-5.1-codex')
  assert.equal(other.reasoning?.defaultEffort, 'high')
})

test('a configured default the discovered catalog dropped does not reach the wire (codex)', async () => {
  // The discovered catalog is the truth about what the model accepts, so a
  // stale override (a level the backend stopped advertising) must fall back to
  // the provider's own default instead of riding on every request.
  const { fetchFn } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({
    session: codexSession,
    fetchFn,
    defaultEffortOf: () => 'max',
  })
  await adapter.listModels('codex')
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'high'],
    'an unadvertised level is not invented into the capability set')
  assert.equal(resolved.reasoning?.defaultEffort, 'high', 'the discovered default stands')
})

test('a configured default extends only the built-in fallback list (codex)', async () => {
  // With no discovered catalog the static list is a known-stale fallback, so a
  // configured level it omits still has to be selectable — otherwise a newly
  // shipped tier could never be chosen.
  const adapter = codexAdapter({
    session: codexSession,
    fetchFn: fakeFetch(CODEX_MODELS_PAYLOAD).fetchFn,
    discovery: false,
    defaultEffortOf: () => 'ultra',
  })
  const resolved = await adapter.resolveModel('codex', 'gpt-5.2-codex')
  const ids: string[] = (resolved.reasoning?.efforts ?? []).map(effort => String(effort.id))
  assert.ok(ids.includes('ultra'), 'the configured level joins the fallback set')
  assert.equal(resolved.reasoning?.defaultEffort, 'ultra')
  assert.ok(ids.includes('high'), 'the fallback levels survive alongside it')
})

test('a configured default cannot invent a reasoning block for claude', async () => {
  // Claude advertises efforts only through its live catalog; a model it does
  // not cover exposes none, so the harness rejects an explicit effort before
  // provider I/O rather than letting the API 400. A configured default must
  // not manufacture the capability.
  const claude = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
    defaultEffortOf: () => 'high',
  })
  assert.equal((await claude.resolveModel('claude', 'claude-opus-4-5')).reasoning, undefined)
  // Same with no configured default at all: unchanged from before the feature.
  const plain = new ClaudeAdapter({
    models: STATIC_CLAUDE,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
  })
  assert.equal((await plain.resolveModel('claude', 'claude-opus-4-5')).reasoning, undefined)
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

test('codexRequestBody bounds tool-call ids without losing their pairings', () => {
  const short = 'call-short'
  const sharedPrefix = `call_${'x'.repeat(60)}`
  const longA = `${sharedPrefix}-a`
  const longB = `${sharedPrefix}-b`
  const resolved = {
    input: [
      { type: 'function_call', call_id: short, name: 'short', arguments: '{}' },
      { type: 'function_call_output', call_id: short, output: 'short result' },
      { type: 'function_call', call_id: longA, name: 'long_a', arguments: '{}' },
      { type: 'function_call_output', call_id: longA, output: 'long A result' },
      { type: 'function_call', call_id: longB, name: 'long_b', arguments: '{}' },
      { type: 'function_call_output', call_id: longB, output: 'long B result' },
    ],
  }
  const options = { provider: 'codex', model: 'gpt-5.1-codex', messages: [] }
  const first = codexRequestBody(options, resolved, false)
  const second = codexRequestBody(options, resolved, false)
  const ids = (first.input as Record<string, unknown>[]).map(item => String(item.call_id))

  assert.equal(ids[0], short)
  assert.equal(ids[1], short)
  assert.ok(ids.every(id => id.length <= 64))
  assert.equal(ids[2], ids[3])
  assert.equal(ids[4], ids[5])
  assert.notEqual(ids[2], ids[4])
  assert.deepEqual(second.input, first.input)

  const reserved = ids[2]
  const collision = codexRequestBody(options, {
    input: [
      { type: 'function_call', call_id: reserved, name: 'reserved', arguments: '{}' },
      { type: 'function_call', call_id: longA, name: 'long_a', arguments: '{}' },
      { type: 'function_call_output', call_id: longA, output: 'long A result' },
    ],
  }, false)
  const collisionIds = (collision.input as Record<string, unknown>[]).map(item => String(item.call_id))
  assert.equal(collisionIds[0], reserved)
  assert.equal(collisionIds[1], collisionIds[2])
  assert.notEqual(collisionIds[1], reserved)
})

/** One text-only message of any role, for request-body assembly. */
function claudeMessage(id: string, role: Message['role'], text: string): Message {
  return {
    id: MessageId(id),
    role,
    content: [{ type: 'text', text }],
    source: role === 'assistant'
      ? { kind: 'model', provider: 'claude', model: 'claude-opus-5' }
      : { kind: 'user' },
  }
}

test('claudeRequestBody ships the cache breakpoints and never exceeds four', () => {
  const history: Message[] = [claudeMessage('s0', 'system', 'opening')]
  for (let turn = 0; turn < 16; turn++) {
    history.push(claudeMessage(`u${turn}`, 'user', `q${turn}`))
    history.push(claudeMessage(`a${turn}`, 'assistant', `r${turn}`))
  }
  const body = claudeRequestBody(
    {
      provider: 'claude',
      model: 'claude-opus-5',
      messages: history,
      system: 'explicit',
      tools: [
        { name: 'write', description: 'write a file', parameters: { type: 'object' } },
        { name: 'bash', description: 'run', parameters: { type: 'object' } },
      ],
    },
    history,
    32_000,
    { type: 'adaptive', display: 'summarized' },
    'high',
  )
  const system = body.system as Record<string, unknown>[]
  const messages = body.messages as { content: Record<string, unknown>[] }[]
  const marked = [...system, ...messages.flatMap(entry => entry.content)]
    .filter(block => block.cache_control !== undefined)
  assert.equal(marked.length, 4, 'one on system plus three across the history is Anthropic\'s maximum')
  assert.deepEqual(system[system.length - 1].cache_control, { type: 'ephemeral' }, 'the tools+system prefix is cached')
  assert.deepEqual(
    (body.tools as { name: string }[]).map(tool => tool.name),
    ['bash', 'write'],
    'tools ride in name order',
  )
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(body.output_config, { effort: 'high' })
  assert.equal(body.stream, true)
})

test('claudeRequestBody omits tools, thinking and effort when the request carries none', () => {
  const history: Message[] = [claudeMessage('u0', 'user', 'hi')]
  const body = claudeRequestBody({ provider: 'claude', model: 'claude-opus-5', messages: history }, history, 32_000)
  assert.equal('tools' in body, false)
  assert.equal('thinking' in body, false)
  assert.equal('output_config' in body, false)
  assert.equal('metadata' in body, false)
  assert.equal(body.max_tokens, 32_000)
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

test('grok discovery keeps last-known reasoning when the CLI catalog fails', async () => {
  const warnings: string[] = []
  const store = memoryCatalogStore({
    at: Date.now() - 3_600_000,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500_000,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('xhigh'), name: 'Extra High Effort' },
          { id: ReasoningEffortId('high'), name: 'High Effort' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch({ error: 'boom' }, 500),
    onWarn: message => warnings.push(message),
    catalogStore: store,
  })
  await adapter.listModels('grok')
  const resolved = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['xhigh', 'high'])
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  assert.equal(resolved.context?.contextWindow, 500_000)
  assert.match(warnings[0], /keeping last-known reasoning efforts/)
  await settle()
  assert.equal(store.saved()?.models.find(model => model.id === 'grok-4.6')?.reasoning?.defaultEffort, 'high')
})

test('grok discovery keeps last-known reasoning when the CLI catalog omits a model', async () => {
  const store = memoryCatalogStore({
    at: Date.now() - 3_600_000,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('xhigh'), name: 'Extra High Effort' },
          { id: ReasoningEffortId('high'), name: 'High Effort' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn: grokDualFetch({ data: GROK_CLI_PAYLOAD.data.filter(entry => entry.id === 'grok-4.5') }),
    catalogStore: store,
  })
  await adapter.listModels('grok')
  const g46 = await adapter.resolveModel('grok', 'grok-4.6')
  assert.deepEqual(g46.reasoning?.efforts.map(effort => effort.id), ['xhigh', 'high'])
  const g45 = await adapter.resolveModel('grok', 'grok-4.5')
  assert.deepEqual(g45.reasoning?.efforts.map(effort => effort.id), ['high', 'medium', 'low'])
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

test('ModelCatalogCache lastKnown ignores TTL', async () => {
  const cache = new ModelCatalogCache(undefined, 0)
  assert.equal(cache.lastKnown(), undefined)
  await cache.get(() => Promise.resolve([{ id: 'a', name: 'A' }]))
  assert.deepEqual(cache.lastKnown()?.map(model => model.id), ['a'])
  assert.equal(cache.cached(), undefined)
})

test('ModelCatalogCache invalidate drops in-flight work so it cannot write back', async () => {
  const cache = new ModelCatalogCache()
  let finishFirst!: (models: { id: string; name: string }[]) => void
  const first = cache.get(() => new Promise(resolve => {
    finishFirst = resolve
  }))
  await settle()
  cache.invalidate()
  const second = cache.get(() => Promise.resolve([{ id: 'good', name: 'Good' }]))
  finishFirst([{ id: 'expired', name: 'Expired' }])
  assert.deepEqual((await first).map(model => model.id), ['expired'])
  assert.deepEqual((await second).map(model => model.id), ['good'])
  assert.deepEqual(cache.lastKnown()?.map(model => model.id), ['good'])
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

test('grok listModels retries a 401 after a forced refresh before invalidating', async () => {
  const store = memoryCatalogStore({
    at: Date.now() - 3_600_000,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High Effort' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  let modelsCalls = 0
  const fetchFn: FetchFn = ((url: unknown) => {
    const isCli = String(url).includes('cli-chat-proxy')
    if (isCli) {
      return Promise.resolve(new Response(JSON.stringify(GROK_CLI_PAYLOAD), { status: 200 }))
    }
    modelsCalls += 1
    if (modelsCalls === 1) {
      return Promise.resolve(new Response('{}', { status: 401 }))
    }
    return Promise.resolve(new Response(JSON.stringify(GROK_API_PAYLOAD), { status: 200 }))
  }) as FetchFn
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn,
    catalogStore: store,
  })
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4.6', 'grok-4.5', 'grok-build-0.1'])
  assert.equal(modelsCalls, 2)
  await settle()
  assert.notEqual(store.saved(), undefined)
  assert.equal((await adapter.resolveModel('grok', 'grok-4.6')).reasoning?.defaultEffort, 'high')
})

test('grok listModels invalidates the catalog after a 401 that survives forced refresh', async () => {
  const store = memoryCatalogStore({
    at: Date.now() - 3_600_000,
    models: [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High Effort' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }],
  })
  const fetchFn: FetchFn = ((url: unknown) => {
    const isCli = String(url).includes('cli-chat-proxy')
    return Promise.resolve(new Response(
      JSON.stringify(isCli ? GROK_CLI_PAYLOAD : {}),
      { status: isCli ? 200 : 401 },
    ))
  }) as FetchFn
  const adapter = new GrokAdapter({
    models: STATIC_GROK,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(grokSession),
    discovery: true,
    fetchFn,
    catalogStore: store,
  })
  const models = await adapter.listModels('grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4'])
  await settle()
  assert.equal(store.saved(), undefined)
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

test('a member adapter keeps catalog rows and delegates pooled / extra ids', async () => {
  // Account pools reuse the catalog wire id; configured tiers append extra
  // picker rows. resolve/stream for an owned id go to the pool.
  const delegated: string[] = []
  const fakePool = {
    modelsForProvider: (provider: string) =>
      Promise.resolve([{ provider, id: 'smart', name: 'smart' }]),
    owns: (_provider: string, model: string) =>
      Promise.resolve(model === 'smart' || model === 'gpt-5.1-codex'),
    resolveModel: (provider: string, model: string) => {
      delegated.push(`resolve:${model}`)
      return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1000 } })
    },
    stream: (options: { model: string }) => {
      delegated.push(`stream:${options.model}`)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'pooled' } as const
      })()
    },
  }
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(codexSession),
    discovery: false,
    pool: () => fakePool as never,
  })
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex', 'smart'])
  const resolved = await adapter.resolveModel('codex', 'gpt-5.1-codex')
  assert.equal(resolved.context?.contextWindow, 1000)
  const chunks: { type: string }[] = []
  for await (const chunk of adapter.stream({
    provider: 'codex', model: 'smart', messages: [],
  })) chunks.push(chunk)
  assert.deepEqual(chunks, [{ type: 'text-delta', index: 0, text: 'pooled' }])
  assert.deepEqual(delegated, ['resolve:gpt-5.1-codex', 'stream:smart'])
})

/** A fetch that hangs until `init.signal` aborts, then rejects. */
function abortableHang(): { fetchFn: FetchFn; signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined
    if (signal !== undefined) signals.push(signal)
    return new Promise<Response>((_resolve, reject) => {
      if (signal === undefined) return
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }) as FetchFn
  return { fetchFn, signals }
}

test('listModels keeps a healthy account catalog when the default account is expired', async () => {
  const expired = { ...codexSession, accountId: 'expired', expiresAt: Date.now() - 1_000 }
  const good = { ...codexSession, accountId: 'good' }
  const solPayload = {
    models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1 }],
  }
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    if (accountId === 'expired') {
      return Promise.reject(new Error('refresh failed'))
    }
    return Promise.resolve(new Response(JSON.stringify(solPayload), { status: 200 }))
  }) as FetchFn
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ expired, good }),
    discovery: true,
    fetchFn,
    discoveryTimeoutMs: 50,
  })
  const models = await adapter.listModels('codex')
  assert.ok(models.some(model => model.id === 'gpt-5.6-sol'), models.map(model => model.id).join(','))
})

test('listModels orders the account union by catalog priority', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const pro = { ...codexSession, accountId: 'pro' }
  const plusPayload = {
    models: [
      { slug: 'gpt-5.6-terra', display_name: 'Terra', visibility: 'list', priority: 2 },
      { slug: 'gpt-5.6-luna', display_name: 'Luna', visibility: 'list', priority: 3 },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 7 },
      { slug: 'gpt-5.4-mini', display_name: 'Mini', visibility: 'list', priority: 23 },
    ],
  }
  const proPayload = {
    models: [
      { slug: 'gpt-5.6-sol', display_name: 'Sol', visibility: 'list', priority: 1 },
      { slug: 'gpt-5.6-terra', display_name: 'Terra', visibility: 'list', priority: 2 },
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 8 },
    ],
  }
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    const payload = accountId === 'pro' ? proPayload : plusPayload
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  }) as FetchFn
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, pro }),
    discovery: true,
    fetchFn,
  })
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
  ])
})

test('resolveModel and Speed use a non-default account catalog for a model only that account lists', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const pro = { ...codexSession, accountId: 'pro' }
  const plusPayload = {
    models: [
      {
        slug: 'gpt-5.6-terra',
        display_name: 'Terra',
        visibility: 'list',
        priority: 2,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        default_reasoning_level: 'high',
      },
    ],
  }
  const proPayload = {
    models: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'Sol',
        visibility: 'list',
        priority: 1,
        supported_reasoning_levels: [
          { effort: 'low' },
          { effort: 'medium' },
          { effort: 'high' },
          { effort: 'xhigh' },
          { effort: 'max' },
        ],
        default_reasoning_level: 'medium',
        service_tiers: [{ id: 'priority' }],
      },
    ],
  }
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    const payload = accountId === 'pro' ? proPayload : plusPayload
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  }) as FetchFn
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, pro }),
    discovery: true,
    fetchFn,
  })
  const resolved = await adapter.resolveModel('codex', 'gpt-5.6-sol')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  assert.equal(await adapter.supportsFastTier('gpt-5.6-sol'), true)
  assert.deepEqual(await adapter.fastCapableModels(), ['gpt-5.6-sol'])
})

test('listModels sits out a hanging non-default account instead of blocking the picker', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const max = { ...codexSession, accountId: 'max' }
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    if (accountId === 'max') {
      const signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        if (signal === undefined) return
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    }
    return Promise.resolve(new Response(JSON.stringify(CODEX_MODELS_PAYLOAD), { status: 200 }))
  }) as FetchFn
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, max }),
    discovery: true,
    fetchFn,
    discoveryTimeoutMs: 20,
  })
  const started = Date.now()
  const models = await adapter.listModels('codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-5.1-codex', 'gpt-5.2-codex'])
  assert.ok(Date.now() - started < 500)
})

test('clearAccountCatalog drops a non-default account cache so the next list refetches', async () => {
  const plus = { ...codexSession, accountId: 'plus' }
  const max = { ...codexSession, accountId: 'max' }
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = new CodexAdapter({
    models: STATIC_CODEX,
    streamIdleTimeoutMs: 1000,
    tokens: memoryAccounts({ plus, max }),
    discovery: true,
    fetchFn,
  })
  const first = await adapter.listOwnModels('codex', 'max')
  assert.deepEqual(first.map(model => model.id), ['gpt-5.1-codex', 'gpt-5.2-codex'])
  await adapter.listOwnModels('codex', 'max')
  assert.equal(calls(), 1)
  adapter.clearAccountCatalog('max')
  await adapter.listOwnModels('codex', 'max')
  assert.equal(calls(), 2)
})

test('clearAccountCatalog invalidates the default persisted catalog', async () => {
  const { fetchFn, calls } = fakeFetch(CODEX_MODELS_PAYLOAD)
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  await adapter.listOwnModels('codex', 'acct')
  await adapter.listOwnModels('codex', 'acct')
  assert.equal(calls(), 1)
  adapter.clearAccountCatalog('acct')
  await adapter.listOwnModels('codex', 'acct')
  assert.equal(calls(), 2)
})

test('fetchCodexModels forwards the abort signal and rejects when it fires', async () => {
  const { fetchFn, signals } = abortableHang()
  const controller = new AbortController()
  const pending = fetchCodexModels(codexSession, fetchFn, controller.signal)
  controller.abort()
  await assert.rejects(pending)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true)
})

test('listOwnModels rethrows abort instead of falling back to the static catalog', async () => {
  const warnings: string[] = []
  const { fetchFn } = abortableHang()
  const adapter = codexAdapter({ session: codexSession, fetchFn, warnings })
  const controller = new AbortController()
  const pending = adapter.listOwnModels('codex', 'acct', controller.signal)
  controller.abort()
  await assert.rejects(pending)
  assert.deepEqual(warnings, [])
})

test('withTimeout returns undefined and aborts a hanging catalog fetch', async () => {
  const { fetchFn, signals } = abortableHang()
  const adapter = codexAdapter({ session: codexSession, fetchFn })
  const models = await withTimeout(
    signal => adapter.listOwnModels('codex', 'acct', signal),
    20,
  )
  assert.equal(models, undefined)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true)
})

test('withTimeout still settles when work ignores the abort signal', async () => {
  const models = await withTimeout(() => new Promise<string>(() => undefined), 20)
  assert.equal(models, undefined)
})

test('withTimeout returns the value when work finishes in time', async () => {
  const models = await withTimeout(async () => ['ok'], 50)
  assert.deepEqual(models, ['ok'])
})
