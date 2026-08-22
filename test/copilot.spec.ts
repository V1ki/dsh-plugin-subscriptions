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
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  completeCopilotLogin,
  COPILOT_TOKEN_URL,
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
  VSCODE_RELEASES_URL,
} from '../src/providers/copilot.js'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { DiscoveredModel, FetchFn } from '../src/providers/common.js'
import type { CopilotSession } from '../src/auth/store.js'
import { streamResponses } from '../src/translate/responses.js'
import type { ResponsesStreamEvent } from '../src/translate/responses.js'

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
    stream: true,
  })
  // No system prompt → no instructions field; tools ride the Responses shape.
  const { maxTokens: omitted, ...bareOptions } = BODY_OPTIONS
  const bare = copilotResponsesRequestBody(
    { ...bareOptions, tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }] },
    { input: [] },
  )
  assert.equal('instructions' in bare, false)
  assert.equal('max_output_tokens' in bare, false)
  assert.deepEqual(bare.tools, [{ type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' } }])
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
  // every event of one item carries a DIFFERENT opaque id.
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
