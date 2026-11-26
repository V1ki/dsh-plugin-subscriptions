/**
 * The generic Chat Completions subscription adapter: static/discovered
 * catalogs, the request shape (Bearer + reasoning replay), the 401 refresh
 * retry, and discovery fallback. Fetches are injected; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import './keep-alive.js'
import { ChatSubscriptionAdapter, withAssistantReasoning } from '../src/providers/chat-subscription.js'
import type {
  ChatSubscriptionDefinition,
  ChatSubscriptionDiscovered,
  ChatSubscriptionSession,
} from '../src/providers/chat-subscription.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { AccountEntry } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const ENDPOINT = 'https://api.kimi.com/coding/v1/chat/completions'

function session(accessToken = 'at-1'): ChatSubscriptionSession {
  return { accessToken, refreshToken: `${accessToken}-rt`, expiresAt: Date.now() + 3_600_000, account: 'dev' }
}

/** In-memory token store with a refresh counter. */
function harness(options: {
  accounts?: Record<string, ChatSubscriptionSession>
  refresh?: (current: ChatSubscriptionSession) => ChatSubscriptionSession
} = {}) {
  const stored = new Map(Object.entries(options.accounts ?? {}))
  const refreshes: string[] = []
  const tokens = new AccountTokenManager<ChatSubscriptionSession>({
    provider: 'kimi',
    displayName: 'Kimi Code',
    makeOptions: () => ({
      preemptMs: 60_000,
      refresh: async current => {
        refreshes.push(current.accessToken)
        return options.refresh?.(current) ?? current
      },
      isPermanent: () => false,
    }),
    io: {
      list: () => Promise.resolve([...stored.entries()]
        .map(([key, value]) => ({ key, session: value }) as AccountEntry<ChatSubscriptionSession>)),
      get: account => Promise.resolve(account === undefined ? stored.values().next().value : stored.get(account)),
      save: (account, value) => { stored.set(account, value); return Promise.resolve() },
      remove: account => { stored.delete(account); return Promise.resolve() },
    },
  })
  return { tokens, stored, refreshes }
}

function definition(overrides: Partial<ChatSubscriptionDefinition> = {}): ChatSubscriptionDefinition {
  return {
    id: 'kimi',
    name: 'Kimi Code',
    label: 'Kimi Code',
    endpoint: ENDPOINT,
    ...overrides,
  }
}

function sse(...events: unknown[]): Response {
  const frames = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function adapterFor(
  tokens: AccountTokenManager<ChatSubscriptionSession>,
  overrides: {
    definition?: ChatSubscriptionDefinition
    fetchFn?: typeof fetch
    onWarn?: (message: string) => void
  } = {},
): ChatSubscriptionAdapter {
  return new ChatSubscriptionAdapter({
    definition: overrides.definition ?? definition(),
    tokens,
    models: [
      { id: 'kimi-for-coding', name: 'Kimi for Coding', contextWindow: 262_144 },
      { id: 'k3', name: 'K3', contextWindow: 1_048_576 },
    ],
    streamIdleTimeoutMs: 30_000,
    resolveAttachments: () => undefined,
    ...overrides.fetchFn === undefined ? {} : { fetchFn: overrides.fetchFn },
    ...overrides.onWarn === undefined ? {} : { onWarn: overrides.onWarn },
  })
}

const STREAM_OPTIONS: GenerateOptions = {
  provider: 'kimi',
  model: 'kimi-for-coding',
  messages: [{
    id: MessageId('m-1'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }],
  maxTokens: 1_000,
}

test('chat subscription: logged out lists nothing; logged in lists the built-in catalog', async () => {
  const loggedOut = adapterFor(harness().tokens)
  assert.deepEqual(await loggedOut.listModels('kimi'), [])

  const loggedIn = adapterFor(harness({ accounts: { dev: session() } }).tokens)
  const models = await loggedIn.listModels('kimi')
  assert.deepEqual(models.map(model => model.id), ['kimi-for-coding', 'k3'])
})

test('chat subscription: menu reads use the cache while scheduled refreshes honor the TTL', async () => {
  let calls = 0
  const adapter = adapterFor(harness({ accounts: { dev: session() } }).tokens, {
    definition: definition({
      discover: async () => {
        calls += 1
        return [{ id: `model-${String(calls)}`, name: `Model ${String(calls)}` }]
      },
    }),
  })
  const ids = async (preferCached: boolean, at?: string): Promise<string[]> =>
    (await adapter.listOwnModels('kimi', 'dev', undefined, preferCached)).map(model => model.id)

  assert.deepEqual(await ids(true), ['model-1'])
  // A menu read never refetches, even before the TTL.
  assert.deepEqual(await ids(true), ['model-1'])
  assert.equal(calls, 1)
  // A scheduled refresh inside the TTL keeps the fresh cache.
  assert.deepEqual(await ids(false), ['model-1'])
  assert.equal(calls, 1)

  const realNow = Date.now
  Date.now = () => realNow() + 5 * 60_000 + 1
  try {
    // Menu reads still serve the last known catalog without touching the network.
    assert.deepEqual(await ids(true), ['model-1'])
    assert.equal(calls, 1)
    // The hourly job (preferCached=false) refetches once the TTL lapses.
    assert.deepEqual(await ids(false), ['model-2'])
    assert.equal(calls, 2)
  } finally {
    Date.now = realNow
  }
})

test('chat subscription: discovery replaces the static catalog, failure falls back to it', async () => {
  const discovered: ChatSubscriptionDiscovered[] = [{ id: 'k3.1-pro', name: 'K3.1 Pro', contextWindow: 1_048_576 }]
  const advertised = adapterFor(harness({ accounts: { dev: session() } }).tokens, {
    definition: definition({ discover: () => Promise.resolve(discovered) }),
  })
  assert.deepEqual((await advertised.listModels('kimi')).map(model => model.id), ['k3.1-pro'])
  assert.equal((await advertised.resolveModel('kimi', 'k3.1-pro')).context?.contextWindow, 1_048_576)

  const warnings: string[] = []
  const failing = adapterFor(harness({ accounts: { dev: session() } }).tokens, {
    definition: definition({ discover: () => Promise.reject(new Error('boom')) }),
    onWarn: message => { warnings.push(message) },
  })
  assert.deepEqual((await failing.listModels('kimi')).map(model => model.id), ['kimi-for-coding', 'k3'])
  assert.equal(warnings.length, 1)
})

test('chat subscription: stream posts the subscription endpoint with Bearer', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const { tokens } = harness({ accounts: { dev: session('at-9') } })
  const adapter = adapterFor(tokens, {
    fetchFn: ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init === undefined ? { url: String(input) } : { url: String(input), init })
      return Promise.resolve(sse(
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ))
    }) as typeof fetch,
  })
  const chunks = []
  for await (const chunk of adapter.stream(STREAM_OPTIONS)) chunks.push(chunk)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, ENDPOINT)
  const headers = calls[0]?.init?.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer at-9')
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    model: string
    stream: boolean
    stream_options: { include_usage: boolean }
  }
  assert.equal(body.model, 'kimi-for-coding')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta'))
})

test('chat subscription: reasoning is replayed on assistant tool rounds', () => {
  const messages = [
    { id: MessageId('u'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
    {
      id: MessageId('a'),
      role: 'assistant',
      source: { kind: 'model', provider: 'kimi', model: 'kimi-for-coding' },
      content: [
        { type: 'reasoning', text: 'think first' },
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: ToolCallId('c-1'), name: 'bash', arguments: '{"cmd":"ls"}' },
      ],
    },
    {
      id: MessageId('t'),
      role: 'user',
      source: { kind: 'tool', callId: ToolCallId('c-1') },
      content: [{ type: 'tool-result', toolCallId: ToolCallId('c-1'), content: [{ type: 'text', text: 'ok' }] }],
    },
  ] as unknown as TranslatableMessage[]
  const wire = withAssistantReasoning(messages)
  const assistant = wire.find(message => message.role === 'assistant')
  assert.equal(assistant?.reasoning_content, 'think first')
  assert.deepEqual((assistant?.tool_calls as { id: string }[]).map(call => call.id), ['c-1'])
})

test('chat subscription: a 401 refreshes once and replays the request with the new token', async () => {
  const calls: RequestInit[] = []
  const { tokens, refreshes } = harness({
    accounts: { dev: session('old') },
    refresh: current => ({ ...current, accessToken: 'new' }),
  })
  const adapter = adapterFor(tokens, {
    fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      if (calls.length === 1) return Promise.resolve(new Response('{"error":"expired"}', { status: 401 }))
      return Promise.resolve(sse(
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ))
    }) as typeof fetch,
  })
  for await (const _chunk of adapter.stream(STREAM_OPTIONS)) { /* drain */ }
  assert.equal(calls.length, 2)
  assert.equal((calls[1]?.headers as Record<string, string>).authorization, 'Bearer new')
  assert.deepEqual(refreshes, ['old'])
})

test('chat subscription: an unknown model fails instead of silently calling the endpoint', async () => {
  const adapter = adapterFor(harness({ accounts: { dev: session() } }).tokens)
  await assert.rejects(() => adapter.resolveModel('kimi', 'nope'), /no model "nope"/)
})

test('chat subscription: a non-chat route is rejected', async () => {
  const adapter = adapterFor(harness({ accounts: { dev: session() } }).tokens)
  await assert.rejects(() => adapter.listModels('glm'), /route mismatch/)
})

test('chat subscription: a reasoning config advertises efforts and maps the selected one', async () => {
  const calls: { init?: RequestInit }[] = []
  const reasoned = definition({
    reasoning: model => model === 'kimi-for-coding'
      ? {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'high',
        body: effort => ({ reasoning_effort: effort }),
      }
      : undefined,
  })
  const adapter = adapterFor(harness({ accounts: { dev: session() } }).tokens, {
    definition: reasoned,
    fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init === undefined ? {} : { init })
      return Promise.resolve(sse(
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ))
    }) as typeof fetch,
  })

  const info = await adapter.resolveModel('kimi', 'kimi-for-coding')
  assert.deepEqual(info.reasoning?.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(info.reasoning?.defaultEffort, 'high')
  assert.equal(await adapter.resolveModel('kimi', 'k3').then(resolved => resolved.reasoning), undefined)

  for await (const _chunk of adapter.stream({ ...STREAM_OPTIONS, reasoningEffort: ReasoningEffortId('low') })) { /* drain */ }
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
  assert.equal(body.reasoning_effort, 'low')

  // No explicit choice: the advertised/default effort is still applied.
  for await (const _chunk of adapter.stream(STREAM_OPTIONS)) { /* drain */ }
  const defaulted = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>
  assert.equal(defaulted.reasoning_effort, 'high')

  await assert.rejects(
    () => (async () => { for await (const _chunk of adapter.stream({
      ...STREAM_OPTIONS, reasoningEffort: ReasoningEffortId('max'),
    })) { /* drain */ } })(),
    /does not support reasoning effort max/,
  )
  await assert.rejects(
    () => (async () => { for await (const _chunk of adapter.stream({
      ...STREAM_OPTIONS, model: 'k3', reasoningEffort: ReasoningEffortId('low'),
    })) { /* drain */ } })(),
    /does not support reasoning effort low/,
  )
})
