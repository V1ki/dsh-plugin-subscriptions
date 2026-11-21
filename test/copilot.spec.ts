/**
 * Copilot provider unit tests beyond the catalog (models.spec.ts): the VS
 * Code version resolution behind the Editor-Version header, and the
 * GitHub-token → Copilot-token exchange. All fetches are injected; no network.
 *
 * Test order matters within this file: the version cache is module-level, so
 * the empty-cache fallback test runs first.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  completeCopilotLogin,
  COPILOT_API_URL,
  COPILOT_MODELS_URL,
  COPILOT_RESPONSES_URL,
  COPILOT_TOKEN_URL,
  COPILOT_UNKNOWN_TOOL_OUTCOME,
  CopilotAdapter,
  CopilotResponsesItemNormalizer,
  copilotChatRequestBody,
  copilotResponsesRequestBody,
  copilotRequestWire,
  copilotWireFor,
  exchangeCopilotToken,
  FALLBACK_VSCODE_VERSION,
  GITHUB_USER_URL,
  isCopilotPermanentRefreshError,
  latestVsCodeVersion,
  refreshCopilot,
  sanitizeCopilotChatMessages,
  sanitizeCopilotResponsesInput,
  VSCODE_RELEASES_URL,
} from '../src/providers/copilot.js'
import { toChatMessages } from '../src/translate/chat-completions.js'
import { OAuthEndpointError, validateModels } from '../src/providers/common.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { DiscoveredModel, FetchFn, ModelEntry } from '../src/providers/common.js'
import type { CopilotSession } from '../src/auth/store.js'
import { streamResponses } from '../src/translate/responses.js'
import type { ReasoningReplayItem, ResponsesStreamEvent } from '../src/translate/responses.js'

/** A fetch implementation routing canned responses by URL; records request headers. */
function fakeFetch(routes: Record<string, { payload: unknown; status?: number } | Error>): {
  fetchFn: FetchFn
  headers: (url: string) => Record<string, string>[]
} {
  const seen = new Map<string, Record<string, string>[]>()
  const fetchFn: FetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    if (route === undefined) return Promise.reject(new Error(`unexpected fetch to ${url}`))
    const list = seen.get(url) ?? []
    list.push((init?.headers ?? {}) as Record<string, string>)
    seen.set(url, list)
    if (route instanceof Error) return Promise.reject(route)
    return Promise.resolve(new Response(JSON.stringify(route.payload), { status: route.status ?? 200 }))
  }) as FetchFn
  return { fetchFn, headers: url => seen.get(url) ?? [] }
}

test('latestVsCodeVersion falls back to the pinned version when the feed fails (empty cache)', async () => {
  const failing: FetchFn = () => Promise.reject(new Error('offline'))
  assert.equal(await latestVsCodeVersion(failing, true), FALLBACK_VSCODE_VERSION)
})

test('latestVsCodeVersion serves the latest stable from the feed, then the cache', async () => {
  const { fetchFn } = fakeFetch({ [VSCODE_RELEASES_URL]: { payload: ['3.1.4', '3.1.3'] } })
  assert.equal(await latestVsCodeVersion(fetchFn, true), '3.1.4')
  // A throwing fetch must not be consulted while the cache is fresh.
  const offline: FetchFn = () => Promise.reject(new Error('must not be called'))
  assert.equal(await latestVsCodeVersion(offline), '3.1.4')
})

test('latestVsCodeVersion serves the stale cache when a forced refresh fails', async () => {
  const offline: FetchFn = () => Promise.reject(new Error('offline'))
  assert.equal(await latestVsCodeVersion(offline, true), '3.1.4')
})

test('exchangeCopilotToken maps the wire response and presents the editor identity', async () => {
  const { fetchFn, headers } = fakeFetch({
    [VSCODE_RELEASES_URL]: { payload: ['1.2.3'] },
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
  })
  const pair = await exchangeCopilotToken('gh-token', fetchFn)
  assert.equal(pair.accessToken, 'copilot-token')
  assert.equal(pair.expiresAt, 2_000_000_000_000)
  const [sent] = headers(COPILOT_TOKEN_URL)
  assert.equal(sent.authorization, 'Bearer gh-token')
  // The exact version depends on the module-level cache (see the version
  // tests above); only the shape is asserted here.
  assert.match(sent['editor-version'], /^vscode\/\d+\.\d+\.\d+$/)
  assert.equal(sent['copilot-integration-id'], 'vscode-chat')
})

test('exchangeCopilotToken falls back to ~25 minutes when expires_at is absent', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token' } },
  })
  const before = Date.now()
  const pair = await exchangeCopilotToken('gh-token', fetchFn)
  assert.ok(pair.expiresAt >= before + 24 * 60_000 && pair.expiresAt <= Date.now() + 25 * 60_000)
})

test('exchangeCopilotToken: a 401 is a permanent login loss', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { error: 'unauthorized' }, status: 401 },
  })
  await assert.rejects(
    exchangeCopilotToken('gh-token', fetchFn),
    (error: unknown) => error instanceof OAuthEndpointError && isCopilotPermanentRefreshError(error),
  )
})

test('completeCopilotLogin stores the GitHub token as the refresh token and reads the account', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
    [GITHUB_USER_URL]: { payload: { login: 'octocat' } },
  })
  const session = await completeCopilotLogin('gh-token', fetchFn)
  assert.deepEqual(session, {
    accessToken: 'copilot-token',
    refreshToken: 'gh-token',
    expiresAt: 2_000_000_000_000,
    account: 'octocat',
  })
})

test('completeCopilotLogin tolerates a profile lookup failure', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
    [GITHUB_USER_URL]: new Error('offline'),
  })
  const session = await completeCopilotLogin('gh-token', fetchFn)
  assert.equal(session.account, undefined)
  assert.equal(session.accessToken, 'copilot-token')
})

test('refreshCopilot re-exchanges and preserves the account', async () => {
  const stored: CopilotSession = {
    accessToken: 'old',
    refreshToken: 'gh-token',
    expiresAt: Date.now() - 1000,
    account: 'octocat',
  }
  const { fetchFn, headers } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'fresh-token', expires_at: 2_000_000_000 } },
  })
  const next = await refreshCopilot(stored, fetchFn)
  assert.deepEqual(next, {
    accessToken: 'fresh-token',
    refreshToken: 'gh-token',
    expiresAt: 2_000_000_000_000,
    account: 'octocat',
  })
  // The refresh exchanges with the GITHUB token, never the stale Copilot one.
  assert.equal(headers(COPILOT_TOKEN_URL)[0].authorization, 'Bearer gh-token')
})

/** Minimal generate options for the request body builders. */
const BODY_OPTIONS: GenerateOptions = {
  provider: 'copilot',
  model: 'gpt-5.6-sol',
  messages: [{
    id: MessageId('m-1'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }],
  maxTokens: 16_000,
}

test('copilotChatRequestBody sends max_completion_tokens, never max_tokens', () => {
  // gpt-5.4-and-later on Copilot reject the legacy `max_tokens` outright
  // (HTTP 400 "Unsupported parameter"); the rest of the catalog accepts the
  // new spelling.
  const body = copilotChatRequestBody(BODY_OPTIONS, [{ role: 'user', content: 'hi' }])
  assert.equal(body.max_completion_tokens, 16_000)
  assert.equal('max_tokens' in body, false)
  assert.equal('reasoning_effort' in body, false)
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('copilotChatRequestBody maps the selected effort to reasoning_effort', () => {
  const options = { ...BODY_OPTIONS, reasoningEffort: ReasoningEffortId('high') }
  const body = copilotChatRequestBody(options, [{ role: 'user', content: 'hi' }])
  assert.equal(body.reasoning_effort, 'high')
})

test('copilotResponsesRequestBody maps the selected effort to reasoning.effort', () => {
  const options = { ...BODY_OPTIONS, reasoningEffort: ReasoningEffortId('xhigh') }
  const body = copilotResponsesRequestBody(options, { input: [] })
  assert.deepEqual(body.reasoning, { effort: 'xhigh' })
})

test('copilotResponsesRequestBody maps the Responses wire shape', () => {
  const body = copilotResponsesRequestBody(BODY_OPTIONS, {
    instructions: 'be terse',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  })
  assert.deepEqual(body, {
    model: 'gpt-5.6-sol',
    instructions: 'be terse',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    max_output_tokens: 16_000,
    include: ['reasoning.encrypted_content'],
    stream: true,
  })
  // The encrypted-reasoning include is unconditional: a reasoning model needs
  // its blobs back on the next request, and non-reasoning models ignore it.
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  // No system prompt → no instructions field; tools ride the Responses shape.
  const { maxTokens: omitted, ...bareOptions } = BODY_OPTIONS
  const bare = copilotResponsesRequestBody(
    { ...bareOptions, tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }] },
    { input: [] },
  )
  assert.equal('instructions' in bare, false)
  assert.equal('max_output_tokens' in bare, false)
  assert.deepEqual(bare.tools, [{ type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' }, strict: false }])
  assert.equal(bare.tool_choice, 'auto')
})

test('copilotWireFor defaults to chat completions unless the catalog says responses', () => {
  assert.equal(copilotWireFor(undefined), 'chat-completions')
  const chat: DiscoveredModel = { id: 'gpt-5-mini', name: 'GPT-5 mini', copilotWire: 'chat-completions' }
  assert.equal(copilotWireFor(chat), 'chat-completions')
  const responses: DiscoveredModel = { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', copilotWire: 'responses' }
  assert.equal(copilotWireFor(responses), 'responses')
  // An entry without the flag (static fallback path) stays on the chat wire.
  assert.equal(copilotWireFor({ id: 'gpt-4o', name: 'GPT-4o' }), 'chat-completions')
})

test('copilotRequestWire reroutes dual-protocol models to Responses for tools + effort', () => {
  // gpt-5.4 lists both endpoints: chat by default, but Copilot 400s there
  // once a request combines function tools with a reasoning effort
  // ("use /v1/responses or set reasoning_effort to 'none'").
  const dual: DiscoveredModel = {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    copilotWire: 'chat-completions',
    copilotResponses: true,
  }
  const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
  assert.equal(copilotRequestWire(dual, { tools, reasoningEffort: ReasoningEffortId('medium') }), 'responses')
  assert.equal(copilotRequestWire(dual, { tools, reasoningEffort: ReasoningEffortId('xhigh') }), 'responses')
  // 'none' is the one effort the chat wire accepts alongside tools.
  assert.equal(copilotRequestWire(dual, { tools, reasoningEffort: ReasoningEffortId('none') }), 'chat-completions')
  // Effort without tools, or tools without effort, keep the default wire.
  assert.equal(copilotRequestWire(dual, { reasoningEffort: ReasoningEffortId('medium') }), 'chat-completions')
  assert.equal(copilotRequestWire(dual, { tools }), 'chat-completions')
  assert.equal(copilotRequestWire(dual, {}), 'chat-completions')
  // A model listing no `/responses` (claude, kimi, …) never reroutes.
  const chatOnly: DiscoveredModel = { id: 'kimi-k3', name: 'Kimi K3', copilotWire: 'chat-completions' }
  assert.equal(
    copilotRequestWire(chatOnly, { tools, reasoningEffort: ReasoningEffortId('high') }),
    'chat-completions',
  )
  // Responses-only models and unknown entries keep their wire untouched.
  assert.equal(
    copilotRequestWire({ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', copilotWire: 'responses' }, {}),
    'responses',
  )
  assert.equal(copilotRequestWire(undefined, {}), 'chat-completions')
})

test('CopilotResponsesItemNormalizer folds per-event item ids into one stable key', () => {
  // Raw shape captured from api.githubcopilot.com/responses with gpt-5.6:
  // every event of one item carries a DIFFERENT opaque id. These captures
  // carry no output_index, so this test pins the last-added-key fallback and
  // must keep passing byte for byte.
  const normalizer = new CopilotResponsesItemNormalizer()
  const rewritten = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'added-id' } },
    { type: 'response.output_text.delta', item_id: 'delta-id-1', delta: 'Hi' },
    { type: 'response.output_text.delta', item_id: 'delta-id-2', delta: ' there' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'done-id', content: [{ type: 'output_text', text: 'Hi there' }] } },
  ].map(event => normalizer.push(event as ResponsesStreamEvent))
  assert.equal(rewritten[0]?.item?.id, 'copilot-item-1')
  assert.equal(rewritten[1]?.item_id, 'copilot-item-1')
  assert.equal(rewritten[2]?.item_id, 'copilot-item-1')
  assert.equal(rewritten[3]?.item?.id, 'copilot-item-1')
  // The next item gets the next ordinal.
  const next = normalizer.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'x', call_id: 'call-1', name: 'bash' } })
  assert.equal(next.item?.id, 'copilot-item-2')
})

test('normalized Copilot Responses events assemble text and whole-done tool arguments', async () => {
  // End-to-end through the shared translator with the normalizer: text
  // fragments join into one block, and a function call whose argument deltas
  // are empty (the gateway delivers the arguments whole on done) closes with
  // the full payload.
  const normalizer = new CopilotResponsesItemNormalizer()
  const events: ResponsesStreamEvent[] = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'a' } },
    { type: 'response.output_text.delta', item_id: 'd1', delta: 'Hi' },
    { type: 'response.output_text.delta', item_id: 'd2', delta: '!' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'b', content: [{ type: 'output_text', text: 'Hi!' }] } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'c', call_id: 'call-9', name: 'bash' } },
    { type: 'response.function_call_arguments.delta', item_id: 'd3', delta: '' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'e', call_id: 'call-9', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } },
  ]
  const frames = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
  const chunks: { type: string; block?: { type: string; name?: string; text?: string; arguments?: string } }[] = []
  for await (const chunk of streamResponses(stream, undefined, event => normalizer.push(event))) {
    chunks.push(chunk as { type: string; block?: { type: string; name?: string; text?: string; arguments?: string } })
  }
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { type: 'text', text: 'Hi!' })
  assert.equal(blocks[1]?.type, 'tool-call')
  assert.equal(blocks[1]?.name, 'bash')
  assert.equal(blocks[1]?.arguments, '{"cmd":"ls"}')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.type, 'finish')
})

test('CopilotResponsesItemNormalizer keys interleaved items by output_index, not arrival order', () => {
  // Two items interleaved on the wire (parallel tool calls): every event
  // carries a fresh gateway id, so output_index is the only correlator.
  const normalizer = new CopilotResponsesItemNormalizer()
  const itemKey = (event: ResponsesStreamEvent): string | undefined => {
    const rewritten = normalizer.push(event)
    return rewritten.item?.id ?? rewritten.item_id
  }
  assert.equal(
    itemKey({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'A1', call_id: 'call-A', name: 'bash' } }),
    'copilot-item-0',
  )
  assert.equal(
    itemKey({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'B1', call_id: 'call-B', name: 'grep' } }),
    'copilot-item-1',
  )
  // Interleaved deltas and dones land on their own item's key.
  assert.equal(
    itemKey({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'A2', delta: '' }),
    'copilot-item-0',
  )
  assert.equal(
    itemKey({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'B2', delta: '' }),
    'copilot-item-1',
  )
  assert.equal(
    itemKey({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'A3' } }),
    'copilot-item-0',
  )
  assert.equal(
    itemKey({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'B3' } }),
    'copilot-item-1',
  )
  // A no-index event falls back to the LAST added item's key.
  assert.equal(itemKey({ type: 'response.output_text.delta', item_id: 'late', delta: 'x' }), 'copilot-item-1')
})

/** Encode Responses events as one SSE payload string. */
function sseBody(events: ResponsesStreamEvent[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/** Encode Responses events as the SSE byte stream the adapter consumes. */
function sseStream(events: ResponsesStreamEvent[]): ReadableStream<Uint8Array> {
  const frames = sseBody(events)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
}

test('normalized interleaved Copilot tool calls assemble into separate blocks', async () => {
  // End-to-end through the shared translator: two function calls interleaved
  // per-event (fresh ids everywhere, output_index the only correlator), each
  // call's arguments delivered whole only on its done event.
  const normalizer = new CopilotResponsesItemNormalizer()
  const events: ResponsesStreamEvent[] = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'a1', call_id: 'call-A', name: 'bash' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'b1', call_id: 'call-B', name: 'grep' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'a2', delta: '' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'b2', delta: '' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'a3', call_id: 'call-A', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'b3', call_id: 'call-B', name: 'grep', arguments: '{"q":"x"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } },
  ]
  const chunks: { type: string; block?: { type: string; id?: string; name?: string; arguments?: string } }[] = []
  for await (const chunk of streamResponses(sseStream(events), undefined, event => normalizer.push(event))) {
    chunks.push(chunk as { type: string; block?: { type: string; id?: string; name?: string; arguments?: string } })
  }
  // Each call closes as its own tool-call block with its own arguments.
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(blocks, [
    { type: 'tool-call', id: 'call-A', name: 'bash', arguments: '{"cmd":"ls"}' },
    { type: 'tool-call', id: 'call-B', name: 'grep', arguments: '{"q":"x"}' },
  ])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'finish'), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('validateModels passes a configured wire through and rejects unknown values', () => {
  assert.deepEqual(
    validateModels([{ id: 'gpt-5.6-sol', wire: 'responses' }], 'test: copilot'),
    [{ id: 'gpt-5.6-sol', wire: 'responses' }],
  )
  const bogus: unknown = { id: 'm', wire: 'bogus' }
  assert.throws(
    () => validateModels([bogus as ModelEntry], 'test: copilot'),
    /test: copilot: catalog model "m" wire must be "chat-completions" or "responses"/,
  )
})

const copilotSession: CopilotSession = {
  accessToken: 'copilot-at',
  refreshToken: 'gh-token',
  expiresAt: Date.now() + 3_600_000,
}

/** An AccountTokenManager over an in-memory session; refresh never fires here. */
function memoryTokens(initial: CopilotSession): AccountTokenManager<CopilotSession> {
  let stored: CopilotSession | undefined = initial
  return new AccountTokenManager<CopilotSession>({
    provider: 'copilot',
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

/**
 * Record-and-replay stub for the AMBIENT generation fetch: the adapter sends
 * provider traffic through global fetch (the repo-wide adapter pattern; only
 * discovery takes an injected fetchFn), so adapter-level stream tests patch
 * the global and restore it in a finally. node:test runs one file's tests
 * sequentially, so the patch window is race-free. Each queued SSE payload
 * answers one request in call order; request url + parsed body are recorded.
 */
function recordingSseFetch(queuedResponses: string[]): {
  calls: { url: string; body: Record<string, unknown> }[]
  restore(): void
} {
  const original = globalThis.fetch
  const calls: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === VSCODE_RELEASES_URL) {
      return Promise.resolve(new Response(JSON.stringify(['1.9.9']), { status: 200 }))
    }
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const payload = queuedResponses.shift()
    if (payload === undefined) return Promise.reject(new Error(`unexpected fetch to ${url}`))
    return Promise.resolve(new Response(payload))
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** A minimal completed Responses SSE payload (one text item, then finish). */
const COMPLETED_SSE = sseBody([
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm2', content: [{ type: 'output_text', text: 'ok' }] } },
  { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
])

/** Minimal generate options for adapter.stream() calls. */
const STREAM_OPTIONS: GenerateOptions = {
  provider: 'copilot',
  model: 'gpt-5.6-sol',
  messages: [{
    id: MessageId('m-stream'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }],
  maxTokens: 1_000,
}

test('a configured wire routes the request even without discovery', async () => {
  // Review finding on #26: a manually configured responses-only model with
  // discovery:false left discovered() undefined, so the request silently
  // defaulted to /chat/completions and the gateway rejected it.
  const { calls, restore } = recordingSseFetch([COMPLETED_SSE])
  try {
    const adapter = new CopilotAdapter({
      models: [{ id: 'gpt-5.6-sol', wire: 'responses' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(copilotSession),
      discovery: false,
    })
    const chunks: { type: string }[] = []
    for await (const chunk of adapter.stream(STREAM_OPTIONS)) {
      chunks.push(chunk as { type: string })
    }
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, COPILOT_RESPONSES_URL)
    assert.equal(calls[0]?.body.model, 'gpt-5.6-sol')
  } finally {
    restore()
  }
})

test('a configured wire outranks a discovered chat-wire catalog entry', async () => {
  // Discovery (were it consulted) reports gpt-4.1 as /chat/completions, but
  // the config pins it to responses: the explicit config wins, and the
  // discovery fetch is never needed for the routing decision.
  const discovery: FetchFn = ((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === VSCODE_RELEASES_URL) return Promise.resolve(new Response(JSON.stringify(['1.9.9'])))
    if (url === COPILOT_MODELS_URL) {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: 'gpt-4.1',
          name: 'GPT-4.1',
          model_picker_enabled: true,
          policy: { state: 'enabled' },
          supported_endpoints: ['/chat/completions'],
        }],
      })))
    }
    return Promise.reject(new Error(`unexpected discovery fetch to ${url}`))
  }) as FetchFn
  const { calls, restore } = recordingSseFetch([COMPLETED_SSE])
  try {
    const adapter = new CopilotAdapter({
      models: [{ id: 'gpt-4.1', wire: 'responses' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(copilotSession),
      discovery: true,
      fetchFn: discovery,
    })
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, model: 'gpt-4.1' })) {
      void chunk
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, COPILOT_RESPONSES_URL)
  } finally {
    restore()
  }
})

test('CopilotResponsesItemNormalizer captures call ids and COMPLETED reasoning items', () => {
  const captures: { callIds: string[]; items: ReasoningReplayItem[] }[] = []
  const normalizer = new CopilotResponsesItemNormalizer((callIds, items) => {
    captures.push({ callIds: [...callIds], items: [...items] })
  })
  normalizer.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1' } })
  normalizer.push({
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'reasoning',
      id: 'rs_done_1',
      summary: [{ type: 'summary_text', text: 'listed the directory first' }],
      status: 'completed',
      encrypted_content: 'ENC1',
    },
  })
  normalizer.push({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'f1', call_id: 'call-7', name: 'bash' } })
  normalizer.push({ type: 'response.completed', response: {} })
  // The capture keeps the COMPLETE done item — original gateway id (not the
  // stable-key rewrite), summary parts, status, and the encrypted payload —
  // because the Responses input schema requires id and summary on a
  // replayed reasoning item, not a bare encrypted blob.
  assert.deepEqual(captures, [{
    callIds: ['call-7'],
    items: [{
      type: 'reasoning',
      id: 'rs_done_1',
      summary: [{ type: 'summary_text', text: 'listed the directory first' }],
      status: 'completed',
      encrypted_content: 'ENC1',
    }],
  }])
  // Cleared after the fire: a second completed event in the same stream must
  // not re-report the first response's pair.
  normalizer.push({ type: 'response.completed', response: {} })
  assert.equal(captures.length, 1)
})

test('CopilotResponsesItemNormalizer does not capture without both sides of the pair', () => {
  const captures: unknown[][] = []
  const normalizer = new CopilotResponsesItemNormalizer((callIds, items) => {
    captures.push([callIds, items])
  })
  // A function call with no completed reasoning in its response.
  normalizer.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'f1', call_id: 'call-7' } })
  normalizer.push({ type: 'response.completed', response: {} })
  // Completed reasoning with no function call in its response.
  normalizer.push({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'r1', encrypted_content: 'ENC1' } })
  normalizer.push({ type: 'response.completed', response: {} })
  // Malformed shapes (empty call_id, empty encrypted_content, missing id)
  // never collect: an item without its id or blob is not a valid replayable
  // Responses input item, so it degrades to no replay.
  normalizer.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'f2', call_id: '' } })
  normalizer.push({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'r2', encrypted_content: '' } })
  normalizer.push({ type: 'response.output_item.done', item: { type: 'reasoning', encrypted_content: 'ENC_NO_ID' } })
  normalizer.push({ type: 'response.completed', response: {} })
  assert.equal(captures.length, 0)
})

/**
 * SSE payload for the adapter-level capture tests: the model reasons (the
 * reasoning done carries the COMPLETE item — id, summary, status, and the
 * encrypted blob — when `encrypted` is given) and issues one tool call whose
 * arguments arrive whole on done.
 */
function reasoningToolCallSse(encrypted: string | undefined, callId = 'call_A'): string {
  return sseBody([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1' } },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: encrypted === undefined
        ? { type: 'reasoning', id: 'r2' }
        : {
            type: 'reasoning',
            id: 'rs_done_1',
            summary: [{ type: 'summary_text', text: 'planned the ls call' }],
            status: 'completed',
            encrypted_content: encrypted,
          },
    },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'f1', call_id: callId, name: 'bash' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'f2', delta: '' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'f3', call_id: callId, name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } },
  ])
}

/** A second response's SSE: reasoning (ENC2) followed by a call to `call_B`. */
function secondReasoningToolCallSse(): string {
  return sseBody([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r3' } },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_done_2',
        summary: [{ type: 'summary_text', text: 'read the listing' }],
        status: 'completed',
        encrypted_content: 'ENC2',
      },
    },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'g1', call_id: 'call_B', name: 'grep' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'g2', delta: '' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'g3', call_id: 'call_B', name: 'grep', arguments: '{"q":"x"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } },
  ])
}

/** The conversation handed back for the second request after the call ran. */
function toolRoundTripHistory(callId = 'call_A'): GenerateOptions['messages'] {
  return [
    {
      id: MessageId('m-a'),
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: '{"cmd":"ls"}' },
      ],
      source: { kind: 'model', provider: 'copilot', model: 'gpt-5.6-sol' },
    },
    {
      id: MessageId('m-b'),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text: 'file-a' }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  ]
}

/** A two-round tool-chain history: call_A and its result, then call_B and its result. */
function twoRoundHistory(): GenerateOptions['messages'] {
  return [
    ...toolRoundTripHistory('call_A'),
    {
      id: MessageId('m-c'),
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking more' },
        { type: 'tool-call', id: ToolCallId('call_B'), name: 'grep', arguments: '{"q":"x"}' },
      ],
      source: { kind: 'model', provider: 'copilot', model: 'gpt-5.6-sol' },
    },
    {
      id: MessageId('m-d'),
      role: 'tool',
      toolCallId: ToolCallId('call_B'),
      content: [{ type: 'text', text: 'match' }],
      source: { kind: 'tool', callId: ToolCallId('call_B') },
    },
  ]
}

/** A wire-forced responses adapter with no discovery, over the global fetch stub. */
function responsesAdapter(tokens: AccountTokenManager<CopilotSession> = memoryTokens(copilotSession)): CopilotAdapter {
  return new CopilotAdapter({
    models: [{ id: 'gpt-5.6-sol', wire: 'responses' }],
    streamIdleTimeoutMs: 1000,
    tokens,
    discovery: false,
  })
}

/** An AccountTokenManager over a session the test can swap (the relogin path). */
function swappableTokens(initial: CopilotSession): {
  tokens: AccountTokenManager<CopilotSession>
  swap(next: CopilotSession): void
} {
  let stored: CopilotSession | undefined = initial
  const tokens = new AccountTokenManager<CopilotSession>({
    provider: 'copilot',
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
  return { tokens, swap: next => { stored = next } }
}

/** Brand a string as a GenerateOptions sessionId (the loop-stamped session identity). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

/** The input items of one recorded request body. */
function inputOf(calls: { url: string; body: Record<string, unknown> }[], index: number): Record<string, unknown>[] {
  return calls[index]?.body.input as Record<string, unknown>[]
}

/** The encrypted payloads of the reasoning items inside one request input. */
function replayedEncrypted(input: Record<string, unknown>[]): string[] {
  return input.filter(item => item.type === 'reasoning').map(item => String(item.encrypted_content))
}

/**
 * STRICT Responses-input item validation for the round-trip tests: every
 * item must satisfy its wire schema — in particular a replayed reasoning
 * item REQUIRES a non-empty id and encrypted_content (the pre-fix bare
 * `{ type, encrypted_content }` shape is invalid input), a function_call
 * requires call_id/name/JSON-parsable arguments, and a function_call_output
 * requires call_id/output. Mock fetches cannot catch this; the validator
 * stands in for the real gateway's schema check.
 * @returns the violation message, or undefined when the item is valid.
 */
function responsesInputViolation(item: Record<string, unknown>): string | undefined {
  switch (item.type) {
    case 'message': {
      if (typeof item.role !== 'string' || item.role.length === 0) return 'message: role required'
      if (!Array.isArray(item.content) || item.content.length === 0) return 'message: content array required'
      for (const part of item.content) {
        const typed = part as { type?: unknown; text?: unknown }
        if (typed.type !== 'input_text' && typed.type !== 'output_text') return 'message: content part type'
        if (typeof typed.text !== 'string') return 'message: content part text'
      }
      return undefined
    }
    case 'reasoning': {
      if (typeof item.id !== 'string' || item.id.length === 0) return 'reasoning: id required'
      if (typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0) {
        return 'reasoning: encrypted_content required'
      }
      if (item.summary !== undefined && !Array.isArray(item.summary)) return 'reasoning: summary must be an array'
      return undefined
    }
    case 'function_call': {
      if (typeof item.call_id !== 'string' || item.call_id.length === 0) return 'function_call: call_id required'
      if (typeof item.name !== 'string' || item.name.length === 0) return 'function_call: name required'
      if (typeof item.arguments !== 'string') return 'function_call: arguments string required'
      try {
        JSON.parse(item.arguments)
      } catch {
        return 'function_call: arguments must parse as JSON'
      }
      return undefined
    }
    case 'function_call_output': {
      if (typeof item.call_id !== 'string' || item.call_id.length === 0) return 'function_call_output: call_id required'
      if (typeof item.output !== 'string') return 'function_call_output: output required'
      return undefined
    }
    default:
      return `unknown item type ${String(item.type)}`
  }
}

test('the strict input validator rejects an id-less reasoning item (validator sanity)', () => {
  // The pre-fix replay shape — a bare encrypted blob — must FAIL validation,
  // proving the round-trip assertions below actually enforce the schema.
  assert.equal(
    responsesInputViolation({ type: 'reasoning', encrypted_content: 'ENC' }),
    'reasoning: id required',
  )
  assert.equal(
    responsesInputViolation({ type: 'reasoning', id: 'rs_1' }),
    'reasoning: encrypted_content required',
  )
  assert.equal(responsesInputViolation({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' }), undefined)
})

test('adapter replays the COMPLETE reasoning item immediately before its tool call', async () => {
  // Two phases through ONE adapter: the first response reasons and calls
  // call_A; the second request (tool result in hand) must replay the captured
  // COMPLETED reasoning item — original id, summary, status, and the
  // encrypted payload — directly ahead of the replayed function_call, and
  // every assembled input item must pass the strict Responses input schema.
  const { calls, restore } = recordingSseFetch([reasoningToolCallSse('ENC1'), COMPLETED_SSE])
  try {
    const adapter = responsesAdapter()
    const first: { type: string; block?: { type?: string; id?: string } }[] = []
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      first.push(chunk as { type: string; block?: { type?: string; id?: string } })
    }
    const toolBlocks = first.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
    assert.equal(toolBlocks.length, 1)
    assert.equal(toolBlocks[0]?.block?.id, 'call_A')

    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      sessionId: SessionId('sess-1'),
      messages: toolRoundTripHistory(),
    })) {
      void chunk
    }
    const input = inputOf(calls, 1)
    for (const item of input) {
      assert.equal(
        responsesInputViolation(item),
        undefined,
        `input item failed the Responses input schema: ${JSON.stringify(item)}`,
      )
    }
    const reasoningIndex = input.findIndex(item => item.type === 'reasoning')
    assert.ok(reasoningIndex >= 0, 'the completed reasoning item is replayed')
    const callIndex = input.findIndex(item => item.type === 'function_call' && item.call_id === 'call_A')
    assert.equal(callIndex, reasoningIndex + 1)
    assert.deepEqual(input[reasoningIndex], {
      type: 'reasoning',
      id: 'rs_done_1',
      summary: [{ type: 'summary_text', text: 'planned the ls call' }],
      status: 'completed',
      encrypted_content: 'ENC1',
    })
  } finally {
    restore()
  }
})

test('a response without encrypted reasoning captures nothing to replay', async () => {
  // Degradation: the reasoning item arrives without encrypted_content (model
  // not reasoning, or the gateway strips the blob) — the follow-up request's
  // input carries no reasoning items, exactly the pre-capture behavior.
  const { calls, restore } = recordingSseFetch([reasoningToolCallSse(undefined), COMPLETED_SSE])
  try {
    const adapter = responsesAdapter()
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      void chunk
    }
    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      sessionId: SessionId('sess-1'),
      messages: toolRoundTripHistory(),
    })) {
      void chunk
    }
    assert.equal(inputOf(calls, 1).some(item => item.type === 'reasoning'), false)
  } finally {
    restore()
  }
})

test('consumed replay entries persist for later rounds of the same conversation', async () => {
  // Retention policy: consumption does NOT evict. Round 3 of a tool chain
  // replays the reasoning of BOTH earlier responses, each ahead of its own
  // function_call, because every later request re-sends every earlier call.
  const { calls, restore } = recordingSseFetch([
    reasoningToolCallSse('ENC1', 'call_A'),
    secondReasoningToolCallSse(),
    COMPLETED_SSE,
  ])
  try {
    const adapter = responsesAdapter()
    // Request 1 (plain prompt) → response 1 reasons (ENC1) and calls call_A.
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      void chunk
    }
    const round = async (messages: GenerateOptions['messages']): Promise<void> => {
      for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1'), messages })) {
        void chunk
      }
    }
    // Request 2 (call_A result) → response 2 reasons (ENC2) and calls call_B.
    await round(toolRoundTripHistory())
    // Request 3 (both results): replays BOTH responses' reasoning.
    await round(twoRoundHistory())
    const input = inputOf(calls, 2)
    assert.deepEqual(replayedEncrypted(input), ['ENC1', 'ENC2'])
    const enc1 = input.findIndex(item => item.type === 'reasoning' && item.encrypted_content === 'ENC1')
    const callA = input.findIndex(item => item.type === 'function_call' && item.call_id === 'call_A')
    const enc2 = input.findIndex(item => item.type === 'reasoning' && item.encrypted_content === 'ENC2')
    const callB = input.findIndex(item => item.type === 'function_call' && item.call_id === 'call_B')
    assert.equal(callA, enc1 + 1, 'round 1 reasoning replays ahead of call_A')
    assert.equal(callB, enc2 + 1, 'round 2 reasoning replays ahead of call_B')
    assert.ok(callA < callB)
  } finally {
    restore()
  }
})

test('replay state is isolated per conversation (the loop-stamped session id)', async () => {
  // Conversation 1 captures `call-shared`; a DIFFERENT conversation reusing
  // the same call id (same account, same model) must not see its reasoning.
  const { calls, restore } = recordingSseFetch([
    reasoningToolCallSse('ENC_SESSION_1', 'call-shared'),
    COMPLETED_SSE,
  ])
  try {
    const adapter = responsesAdapter()
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      void chunk
    }
    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      sessionId: SessionId('sess-2'),
      messages: toolRoundTripHistory('call-shared'),
    })) {
      void chunk
    }
    assert.equal(inputOf(calls, 1).some(item => item.type === 'reasoning'), false)
  } finally {
    restore()
  }
})

test('replay state is isolated per model', async () => {
  const { calls, restore } = recordingSseFetch([
    reasoningToolCallSse('ENC_SOL', 'call-shared'),
    COMPLETED_SSE,
  ])
  try {
    const adapter = new CopilotAdapter({
      models: [{ id: 'gpt-5.6-sol', wire: 'responses' }, { id: 'gpt-5.6-luna', wire: 'responses' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(copilotSession),
      discovery: false,
    })
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      void chunk
    }
    // Same session, same call id, different model: no replay.
    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      model: 'gpt-5.6-luna',
      sessionId: SessionId('sess-1'),
      messages: toolRoundTripHistory('call-shared'),
    })) {
      void chunk
    }
    assert.equal(inputOf(calls, 1).some(item => item.type === 'reasoning'), false)
  } finally {
    restore()
  }
})

test('replay state never crosses accounts (logout → relogin as another account)', async () => {
  // The review's reproduction: account A captures call-shared →
  // ENC_ACCOUNT_A; without rebuilding the adapter the store switches to
  // account B, whose continuation reusing the id must NOT inject A's
  // reasoning. The account identity rides the stable GitHub token, which
  // survives every Copilot-token refresh and differs per login.
  const accountA: CopilotSession = { ...copilotSession, refreshToken: 'gh-account-a' }
  const accountB: CopilotSession = { ...copilotSession, refreshToken: 'gh-account-b' }
  const { tokens, swap } = swappableTokens(accountA)
  const { calls, restore } = recordingSseFetch([
    reasoningToolCallSse('ENC_ACCOUNT_A', 'call-shared'),
    COMPLETED_SSE,
  ])
  try {
    const adapter = responsesAdapter(tokens)
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      void chunk
    }
    swap(accountB)
    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      sessionId: SessionId('sess-1'),
      messages: toolRoundTripHistory('call-shared'),
    })) {
      void chunk
    }
    assert.equal(
      inputOf(calls, 1).some(item => item.type === 'reasoning'),
      false,
      "account B's request must not carry account A's reasoning",
    )
  } finally {
    restore()
  }
})

test('clearReplayState drops captured entries (the auth-transition hook)', async () => {
  // index.ts invokes this on every copilot auth transition; even with the
  // SAME account re-logging-in (identical scope), memory holds no replay
  // entries afterwards.
  const { calls, restore } = recordingSseFetch([reasoningToolCallSse('ENC1'), COMPLETED_SSE])
  try {
    const adapter = responsesAdapter()
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      void chunk
    }
    adapter.clearReplayState()
    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      sessionId: SessionId('sess-1'),
      messages: toolRoundTripHistory(),
    })) {
      void chunk
    }
    assert.equal(inputOf(calls, 1).some(item => item.type === 'reasoning'), false)
  } finally {
    restore()
  }
})

test('captured replay entries idle out after the TTL', async () => {
  const { calls, restore } = recordingSseFetch([reasoningToolCallSse('ENC1'), COMPLETED_SSE])
  const realNow = Date.now
  try {
    const adapter = responsesAdapter()
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      void chunk
    }
    // Fast-forward past the 30-minute TTL with no intervening use: the same
    // scope's entry answers as a miss, degrading to the no-replay behavior.
    const capturedAt = realNow()
    Date.now = () => capturedAt + 31 * 60_000
    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      sessionId: SessionId('sess-1'),
      messages: toolRoundTripHistory(),
    })) {
      void chunk
    }
    assert.equal(inputOf(calls, 1).some(item => item.type === 'reasoning'), false)
  } finally {
    Date.now = realNow
    restore()
  }
})

test('the TTL is idle-based: a conversation still using its entries keeps them', async () => {
  // Sliding expiration: a read at T0+20min refreshes the entry, so a read at
  // T0+35min (only 15 min after the last use) still replays, where a fixed
  // TTL from capture would have dropped it.
  const { calls, restore } = recordingSseFetch([
    reasoningToolCallSse('ENC1'),
    COMPLETED_SSE,
    COMPLETED_SSE,
  ])
  const realNow = Date.now
  try {
    const adapter = responsesAdapter()
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('sess-1') })) {
      void chunk
    }
    const capturedAt = realNow()
    const continueRound = (): Promise<void> => {
      const run = async (): Promise<void> => {
        for await (const chunk of adapter.stream({
          ...STREAM_OPTIONS,
          sessionId: SessionId('sess-1'),
          messages: toolRoundTripHistory(),
        })) {
          void chunk
        }
      }
      return run()
    }
    Date.now = () => capturedAt + 20 * 60_000
    await continueRound()
    Date.now = () => capturedAt + 35 * 60_000
    await continueRound()
    assert.equal(
      inputOf(calls, 2).some(item => item.type === 'reasoning'),
      true,
      'the entry survived because the last use was 15 minutes ago',
    )
  } finally {
    Date.now = realNow
    restore()
  }
})

test('concurrent call-id collisions stay isolated per conversation', async () => {
  // Two live conversations reuse `call-X` and capture different reasoning;
  // each continuation replays its OWN payload, never the other's.
  const { calls, restore } = recordingSseFetch([
    reasoningToolCallSse('ENC_S1', 'call-X'),
    reasoningToolCallSse('ENC_S2', 'call-X'),
    COMPLETED_SSE,
    COMPLETED_SSE,
  ])
  try {
    const adapter = responsesAdapter()
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('s1') })) {
      void chunk
    }
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, sessionId: SessionId('s2') })) {
      void chunk
    }
    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      sessionId: SessionId('s1'),
      messages: toolRoundTripHistory('call-X'),
    })) {
      void chunk
    }
    for await (const chunk of adapter.stream({
      ...STREAM_OPTIONS,
      sessionId: SessionId('s2'),
      messages: toolRoundTripHistory('call-X'),
    })) {
      void chunk
    }
    assert.deepEqual(replayedEncrypted(inputOf(calls, 2)), ['ENC_S1'])
    assert.deepEqual(replayedEncrypted(inputOf(calls, 3)), ['ENC_S2'])
  } finally {
    restore()
  }
})

test('identity-free requests cannot replay reasoning from another request', async () => {
  const { calls, restore } = recordingSseFetch([reasoningToolCallSse('PRIVATE'), COMPLETED_SSE])
  try {
    const adapter = responsesAdapter()
    const { sessionId: omitted, ...bare } = STREAM_OPTIONS
    void omitted
    const request: GenerateOptions = { ...bare, messages: [{ role: 'user', content: [{ type: 'text', text: 'first request' }] }] }
    for await (const chunk of adapter.stream(request)) void chunk
    const other: GenerateOptions = { ...bare, messages: [
      { role: 'user', content: [{ type: 'text', text: 'independent request' }] },
      ...toolRoundTripHistory(),
    ] }
    for await (const chunk of adapter.stream(other)) void chunk
    assert.deepEqual(replayedEncrypted(inputOf(calls, 1)), [])
  } finally {
    restore()
  }
})

test('hand-built requests anchor replay on the first message id', async () => {
  // Without a loop-stamped sessionId, the conversation scope falls back to
  // the FIRST message's id: a continuation whose history still opens with
  // the capturing request's first message replays, while a different
  // hand-built conversation reusing the call id stays isolated.
  const { calls, restore } = recordingSseFetch([
    reasoningToolCallSse('ENC1'),
    COMPLETED_SSE,
    COMPLETED_SSE,
  ])
  try {
    const adapter = responsesAdapter()
    const { sessionId: omitted, ...bare } = STREAM_OPTIONS
    void omitted
    for await (const chunk of adapter.stream(bare)) {
      void chunk
    }
    const sameConversation = [STREAM_OPTIONS.messages[0], ...toolRoundTripHistory()]
    for await (const chunk of adapter.stream({ ...bare, messages: sameConversation })) {
      void chunk
    }
    assert.equal(
      inputOf(calls, 1).some(item => item.type === 'reasoning'),
      true,
      'the same first message anchors the same conversation scope',
    )
    const other: GenerateOptions['messages'] = [
      {
        id: MessageId('m-other'),
        role: 'user',
        content: [{ type: 'text', text: 'go' }],
        source: { kind: 'user' },
      },
      ...toolRoundTripHistory(),
    ]
    for await (const chunk of adapter.stream({ ...bare, messages: other })) {
      void chunk
    }
    assert.equal(
      inputOf(calls, 2).some(item => item.type === 'reasoning'),
      false,
      'a different first message is a different conversation scope',
    )
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Issue #224: Copilot request-body sanitization, tool-call reconciliation,
// adjacency regrouping, ID normalization, vision header & error diagnostics.
// ---------------------------------------------------------------------------

/** Encode chat-completions SSE frames as one stream body. */
function chatSseBody(text = 'ok'): string {
  const frames = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]
  return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/** Global fetch stub that captures URL, headers, and parsed JSON body per call. */
function recordingHeaderFetch(
  queued: Array<{ body: string; status?: number; headers?: Record<string, string> }>,
): {
  calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[]
  restore(): void
} {
  const original = globalThis.fetch
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === VSCODE_RELEASES_URL) {
      return Promise.resolve(new Response(JSON.stringify(['1.9.9']), { status: 200 }))
    }
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key.toLowerCase()] = value })
    calls.push({ url, headers, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const next = queued.shift()
    if (next === undefined) return Promise.reject(new Error(`unexpected fetch to ${url}`))
    return Promise.resolve(new Response(next.body, {
      status: next.status ?? 200,
      ...next.headers === undefined ? {} : { headers: next.headers },
    }))
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('sanitizeCopilotChatMessages preserves already-valid histories byte-identically', () => {
  const valid: Record<string, unknown>[] = [
    { role: 'system', content: 'be concise' },
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_abc-123', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_abc-123', content: 'file-a' },
    { role: 'assistant', content: 'Found file-a.' },
  ]
  const snapshot = structuredClone(valid)
  const sanitized = sanitizeCopilotChatMessages(valid)
  assert.deepEqual(sanitized, snapshot)
  assert.deepEqual(valid, snapshot, 'input history must not be mutated')
})

test('sanitizeCopilotChatMessages regroups spliced context injections after contiguous tool results', () => {
  const messages = toChatMessages([
    { role: 'user', content: [{ type: 'text', text: 'check repo' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{"path":"a"}' },
        { type: 'tool-call', id: ToolCallId('call-2'), name: 'read', arguments: '{"path":"b"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'contents-a' }] },
    { role: 'user', content: [{ type: 'text', text: 'Context injection goal' }] },
    { role: 'user', content: [{ type: 'text', text: 'Context injection model-selection gemini-4-hydrogen → claude-sonnet-5.5' }] },
    { role: 'tool', toolCallId: 'call-2', content: [{ type: 'text', text: 'contents-b' }] },
    // Legacy user message mixing text before tool-result.
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId('call-3'), name: 'bash', arguments: '{}' }],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'spliced notice before legacy tool result' },
        { type: 'tool-result', toolCallId: ToolCallId('call-3'), content: [{ type: 'text', text: 'ok' }] },
      ],
    },
  ])
  const sanitized = sanitizeCopilotChatMessages(messages)
  assert.deepEqual(
    sanitized.map(entry => `${String(entry.role)}${entry.tool_call_id ? `:${String(entry.tool_call_id)}` : ''}`),
    [
      'user',
      'assistant',
      'tool:call-1',
      'tool:call-2',
      'user',
      'user',
      'assistant',
      'tool:call-3',
      'user',
    ],
  )
  assert.equal(sanitized[4]?.content, 'Context injection goal')
  assert.equal(sanitized[5]?.content, 'Context injection model-selection gemini-4-hydrogen → claude-sonnet-5.5')
  assert.equal(sanitized[8]?.content, 'spliced notice before legacy tool result')
})

test('sanitizeCopilotChatMessages reconciles missing tool outputs and drops orphans/duplicates', () => {
  const raw: Record<string, unknown>[] = [
    { role: 'tool', tool_call_id: 'leading-orphan', content: 'stale' },
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call-ok', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call-missing', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-ok', content: 'first' },
    { role: 'tool', tool_call_id: 'call-ok', content: 'duplicate' },
    { role: 'tool', tool_call_id: 'mid-orphan', content: 'wrong-id' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'done' },
    { role: 'tool', tool_call_id: 'trailing-orphan', content: 'stray' },
  ]
  const sanitized = sanitizeCopilotChatMessages(raw)
  assert.deepEqual(sanitized, [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call-ok', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call-missing', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-ok', content: 'first' },
    { role: 'tool', tool_call_id: 'call-missing', content: COPILOT_UNKNOWN_TOOL_OUTCOME },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'done' },
  ])
})

test('sanitizeCopilotChatMessages normalizes empty/malformed tool arguments to JSON objects', () => {
  const raw: Record<string, unknown>[] = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'ok', arguments: '{"a": 1}' } },
        { id: 'c2', type: 'function', function: { name: 'empty', arguments: '' } },
        { id: 'c3', type: 'function', function: { name: 'ws', arguments: '   ' } },
        { id: 'c4', type: 'function', function: { name: 'bad', arguments: '{not json' } },
        { id: 'c5', type: 'function', function: { name: 'arr', arguments: '[1,2]' } },
        { id: 'c6', type: 'function', function: { name: 'prim', arguments: '"hello"' } },
      ],
    },
    ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(id => ({ role: 'tool', tool_call_id: id, content: 'ok' })),
  ]
  const sanitized = sanitizeCopilotChatMessages(raw)
  const calls = sanitized[0]?.tool_calls as { function: { arguments: string } }[]
  assert.deepEqual(
    calls.map(call => call.function.arguments),
    ['{"a": 1}', '{}', '{}', '{}', '{}', '{}'],
  )
})

test('sanitizeCopilotChatMessages normalizes call IDs collision-safely and prefix-stably (<=40 chars)', () => {
  const overlongA = `call_${'x'.repeat(50)}-a`
  const overlongB = `call_${'x'.repeat(50)}-b`
  const ids = ['call.a', 'call:a', 'call_a', '', '.', ':', '_', overlongA, overlongB]
  const raw: Record<string, unknown>[] = [
    {
      role: 'assistant',
      content: '',
      tool_calls: ids.map((id, i) => ({
        id,
        type: 'function',
        function: { name: `tool_${String(i)}`, arguments: '{}' },
      })),
    },
    ...ids.map((id, i) => ({ role: 'tool', tool_call_id: id, content: `res-${String(i)}` })),
  ]
  const first = sanitizeCopilotChatMessages(raw)
  const wireIds = (first[0]?.tool_calls as { id: string }[]).map(call => call.id)
  const resultIds = first.slice(1).map(msg => String(msg.tool_call_id))

  assert.deepEqual(resultIds, wireIds, 'every tool result stays paired with its call')
  assert.equal(new Set(wireIds).size, ids.length, 'all distinct original IDs map to distinct wire IDs')
  for (const id of wireIds) {
    assert.ok(id.length > 0 && id.length <= 40, `length out of bounds: ${id}`)
    assert.match(id, /^[a-zA-Z0-9_-]+$/)
  }
  assert.equal(wireIds[2], 'call_a', 'valid IDs stay verbatim')
  assert.equal(wireIds[6], '_', 'valid IDs stay verbatim')

  // Prefix stability: appending a turn whose valid original ID collides with
  // an earlier generated wire ID keeps the earlier assignment intact and
  // remaps only the newcomer.
  const collidingValid = wireIds[0]!
  const extended = sanitizeCopilotChatMessages([
    ...raw,
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: collidingValid, type: 'function', function: { name: 'late', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: collidingValid, content: 'late-res' },
  ])
  const earlierCalls = (extended[0]?.tool_calls as { id: string }[]).map(call => call.id)
  assert.deepEqual(earlierCalls, wireIds, 'earlier prefix assignments never change')
  const lateAssistant = extended[1 + ids.length]
  const lateCallId = ((lateAssistant?.tool_calls as { id: string }[])[0])?.id
  const lateResultId = String(extended[2 + ids.length]?.tool_call_id)
  assert.notEqual(lateCallId, collidingValid, 'newcomer colliding with earlier generated ID is remapped')
  assert.equal(lateResultId, lateCallId, 'newcomer call and result stay paired')
})

test('sanitizeCopilotChatMessages drops empty-text messages, cleans multipart text, and maps developer to user', () => {
  const raw: Record<string, unknown>[] = [
    { role: 'user', content: '' },
    { role: 'user', content: '   \n\t ' },
    { role: 'user', content: [{ type: 'text', text: '' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '   ' },
    { role: 'developer', content: 'Tool inventory changed.' },
    { role: 'developer', content: '   ' },
    { role: 'assistant', content: 'real answer' },
  ]
  const sanitized = sanitizeCopilotChatMessages(raw)
  assert.deepEqual(sanitized, [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] },
    { role: 'user', content: 'Tool inventory changed.' },
    { role: 'assistant', content: 'real answer' },
  ])
})

test('sanitizeCopilotResponsesInput reconciles orphaned tool calls and normalizes call_ids (<=64 chars)', () => {
  const overlong = `call_${'z'.repeat(70)}`
  const body = copilotResponsesRequestBody(
    { ...BODY_OPTIONS, model: 'gpt-5.6-sol' },
    {
      input: [
        { type: 'function_call', call_id: 'call.missing', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-orphan', output: 'stale' },
        { type: 'function_call', call_id: overlong, name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: overlong, output: 'done' },
        { type: 'function_call_output', call_id: overlong, output: 'dup' },
      ],
    },
  )
  const input = body.input as Record<string, unknown>[]
  assert.equal(input.length, 4)
  assert.equal(input[0]?.type, 'function_call')
  assert.equal(input[1]?.type, 'function_call_output')
  assert.equal(input[1]?.call_id, input[0]?.call_id)
  assert.equal(input[1]?.output, COPILOT_UNKNOWN_TOOL_OUTCOME)
  assert.equal(input[2]?.type, 'function_call')
  assert.equal(input[3]?.type, 'function_call_output')
  assert.equal(input[3]?.call_id, input[2]?.call_id)
  assert.equal(input[3]?.output, 'done')
  for (const item of input) {
    const id = String(item.call_id)
    assert.ok(id.length > 0 && id.length <= 64)
    assert.match(id, /^[a-zA-Z0-9_-]+$/)
  }
  assert.notEqual(input[0]?.call_id, input[2]?.call_id)
  assert.equal(sanitizeCopilotResponsesInput([]).length, 0)
})

test('CopilotAdapter.stream (/chat/completions) sanitizes Codex→Copilot switched sessions for gemini-4-hydrogen and claude-sonnet-5.5', async () => {
  const discovery: FetchFn = ((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === VSCODE_RELEASES_URL) return Promise.resolve(new Response(JSON.stringify(['1.9.9'])))
    if (url === COPILOT_MODELS_URL) {
      return Promise.resolve(new Response(JSON.stringify({
        data: [
          {
            id: 'gemini-4-hydrogen',
            name: 'Gemini 4 Hydrogen',
            model_picker_enabled: true,
            policy: { state: 'enabled' },
            supported_endpoints: ['/chat/completions'],
            capabilities: {
              supports: { vision: true, tool_calls: true },
              limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 8_192 },
            },
          },
          {
            id: 'claude-sonnet-5.5',
            name: 'Claude Sonnet 5.5',
            model_picker_enabled: true,
            policy: { state: 'enabled' },
            supported_endpoints: ['/chat/completions'],
            capabilities: {
              supports: { vision: true, tool_calls: true },
              limits: { max_context_window_tokens: 200_000, max_output_tokens: 16_384 },
            },
          },
        ],
      })))
    }
    return Promise.reject(new Error(`unexpected discovery fetch to ${url}`))
  }) as FetchFn

  const longCodexId = `call_${'a'.repeat(48)}`
  const history: GenerateOptions['messages'] = [
    {
      id: MessageId('m-u1'),
      role: 'user',
      content: [{ type: 'text', text: 'inspect the project' }],
      source: { kind: 'user' },
    },
    {
      id: MessageId('m-a1'),
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'codex reasoning' },
        { type: 'tool-call', id: ToolCallId(longCodexId), name: 'read', arguments: '' },
        { type: 'tool-call', id: ToolCallId('call.orphan:missing'), name: 'search', arguments: '{broken' },
      ],
      source: { kind: 'model', provider: 'codex', model: 'gpt-5.6-sol' },
    },
    {
      id: MessageId('m-t1'),
      role: 'tool',
      toolCallId: ToolCallId(longCodexId),
      content: [{ type: 'text', text: 'README contents' }],
      source: { kind: 'tool', callId: ToolCallId(longCodexId) },
    },
    // Spliced context injections during model switch.
    {
      id: MessageId('m-ctx1'),
      role: 'user',
      content: [{ type: 'text', text: 'Context injection goal' }],
      source: { kind: 'user' },
    },
    {
      id: MessageId('m-ctx2'),
      role: 'user',
      content: [{ type: 'text', text: 'Context injection model-selection gemini-4-hydrogen → claude-sonnet-5.5' }],
      source: { kind: 'user' },
    },
    // PR #207 explicit silent assistant text block from Codex Responses.
    {
      id: MessageId('m-a2'),
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      source: { kind: 'model', provider: 'codex', model: 'gpt-5.6-sol' },
    },
    {
      id: MessageId('m-u2'),
      role: 'user',
      content: [{ type: 'text', text: 'now summarize' }],
      source: { kind: 'user' },
    },
  ]
  const historyBefore = structuredClone(history)
  const tools = [
    {
      name: 'read',
      description: 'read file',
      parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { path: { type: 'string' } } },
    },
    { name: 'ping', description: 'ping', parameters: {} },
  ]

  const { calls, restore } = recordingHeaderFetch([
    { body: chatSseBody('gemini ok') },
    { body: chatSseBody('claude ok') },
  ])
  try {
    const adapter = new CopilotAdapter({
      models: [],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(copilotSession),
      discovery: true,
      fetchFn: discovery,
    })

    for (const [callIndex, model, expectedCap] of [
      [0, 'gemini-4-hydrogen', 8_192],
      [1, 'claude-sonnet-5.5', 16_384],
    ] as const) {
      const texts: string[] = []
      for await (const chunk of adapter.stream({
        provider: 'copilot',
        model,
        messages: history,
        tools,
        maxTokens: 32_000,
      })) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
      }
      assert.ok(texts.join('').includes('ok'))
      const sent = calls[callIndex]!
      assert.equal(sent.url, COPILOT_API_URL)
      assert.equal(sent.body.model, model)
      assert.equal(sent.body.max_completion_tokens, expectedCap, `${model} clamps max_completion_tokens to catalog cap`)

      const sentMessages = sent.body.messages as Record<string, unknown>[]
      assert.deepEqual(
        sentMessages.map(m => m.role),
        ['user', 'assistant', 'tool', 'tool', 'user', 'user', 'user'],
        'tool results are adjacent to assistant tool_calls, spliced context follows, and empty assistant turn is dropped',
      )
      const assistantCalls = sentMessages[1]?.tool_calls as { id: string; function: { arguments: string } }[]
      assert.equal(assistantCalls.length, 2)
      for (const tc of assistantCalls) {
        assert.ok(tc.id.length > 0 && tc.id.length <= 40)
        assert.match(tc.id, /^[a-zA-Z0-9_-]+$/)
        assert.equal(tc.function.arguments, '{}')
      }
      assert.equal(sentMessages[2]?.tool_call_id, assistantCalls[0]?.id)
      assert.equal(sentMessages[2]?.content, 'README contents')
      assert.equal(sentMessages[3]?.tool_call_id, assistantCalls[1]?.id)
      assert.equal(sentMessages[3]?.content, COPILOT_UNKNOWN_TOOL_OUTCOME)

      const sentTools = sent.body.tools as { function: { parameters: Record<string, unknown> } }[]
      assert.equal('$schema' in sentTools[0]!.function.parameters, false)
      assert.equal(sentTools[1]!.function.parameters.type, 'object')
    }
    assert.deepEqual(history, historyBefore, 'durable history must remain completely untouched')
  } finally {
    restore()
  }
})

test('CopilotAdapter.stream sets copilot-vision-request header for images nested inside legacy tool-result blocks', async () => {
  const ref = { attachmentId: 'img-nested', mediaType: 'image/png', bytes: 2, width: 1, height: 1 }
  const { calls, restore } = recordingHeaderFetch([{ body: chatSseBody('saw image') }])
  try {
    const adapter = new CopilotAdapter({
      models: [{ id: 'gemini-4-hydrogen' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(copilotSession),
      discovery: false,
      resolveAttachments: () => ({
        readImage: async () => ({ ref, data: new Uint8Array([104, 105]) }),
      }) as never,
    })
    for await (const chunk of adapter.stream({
      provider: 'copilot',
      model: 'gemini-4-hydrogen',
      messages: [
        {
          id: MessageId('m-a'),
          role: 'assistant',
          content: [{ type: 'tool-call', id: ToolCallId('call-img'), name: 'read_image', arguments: '{}' }],
          source: { kind: 'model', provider: 'codex', model: 'gpt-5.6-sol' },
        },
        {
          id: MessageId('m-tr'),
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: ToolCallId('call-img'),
            content: [{ type: 'image', attachment: ref }],
          }] as never,
          source: { kind: 'tool', callId: ToolCallId('call-img') },
        },
      ],
    })) {
      void chunk
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.headers['copilot-vision-request'], 'true')
  } finally {
    restore()
  }
})

test('CopilotAdapter.stream includes x-github-request-id on HTTP errors for diagnostics', async () => {
  const { restore } = recordingHeaderFetch([
    {
      status: 400,
      headers: { 'x-github-request-id': 'GH-REQ-4242' },
      body: '{"error":{"message":"invalid request body","code":"invalid_request_body"}}',
    },
    {
      status: 400,
      body: '{"error":{"message":"invalid request body","code":"invalid_request_body"}}',
    },
  ])
  try {
    const adapter = new CopilotAdapter({
      models: [{ id: 'gemini-4-hydrogen' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(copilotSession),
      discovery: false,
    })
    await assert.rejects(
      async () => {
        for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, model: 'gemini-4-hydrogen' })) void chunk
      },
      (error: unknown) => error instanceof LlmError
        && error.code === 'HTTP_400'
        && error.failure.requestId === 'GH-REQ-4242'
        && error.message.includes('x-github-request-id: GH-REQ-4242')
        && error.message.includes('invalid_request_body'),
    )
    await assert.rejects(
      async () => {
        for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, model: 'gemini-4-hydrogen' })) void chunk
      },
      (error: unknown) => error instanceof LlmError
        && error.code === 'HTTP_400'
        && error.failure.requestId === undefined
        && !error.message.includes('x-github-request-id'),
    )
  } finally {
    restore()
  }
})
