/**
 * Deferred tool loading on the Claude route (`claudeDeferTools`): the wire
 * shape of `tools`, the guarantee that the default request is unchanged, and
 * the stream the endpoint answers with when the search tool runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ClaudeAdapter, claudeRequestBody } from '../src/providers/claude.js'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'
import { claudeToolSearchStream } from './fixtures/claude-tool-search-stream.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'
import {
  AnthropicStreamTranslator,
  TOOL_SEARCH_TOOL_NAME,
  TOOL_SEARCH_TOOL_TYPE,
  matchesDeferPattern,
  toAnthropicTools,
  toAnthropicToolsDeferred,
} from '../src/translate/anthropic.js'
import type { AnthropicStreamEvent } from '../src/translate/anthropic.js'

const schema = (name: string, extra: Partial<ToolSchema> = {}): ToolSchema =>
  ({ name, description: `${name} tool`, parameters: { type: 'object' }, ...extra })

const search = { type: TOOL_SEARCH_TOOL_TYPE, name: TOOL_SEARCH_TOOL_NAME }

test('matchesDeferPattern: literal names and one trailing star, nothing else is a wildcard', () => {
  assert.equal(matchesDeferPattern('mcp__navegador__click', 'mcp__*'), true)
  assert.equal(matchesDeferPattern('mcp__navegador__click', 'mcp__navegador__click'), true)
  assert.equal(matchesDeferPattern('bash', 'mcp__*'), false)
  assert.equal(matchesDeferPattern('bash', '*'), true)
  assert.equal(matchesDeferPattern('bash', ''), false)
  // A pattern is not a regular expression.
  assert.equal(matchesDeferPattern('bash', 'ba.h'), false)
  assert.equal(matchesDeferPattern('bash', 'ba*h'), false)
  assert.equal(matchesDeferPattern('a*', 'a*'), true, 'a trailing star is the wildcard, so the literal name "a*" also matches')
})

test('with no patterns and no marked tool the tools array equals toAnthropicTools byte for byte', () => {
  const tools = [schema('write'), schema('bash'), schema('mcp__x__one')]
  assert.deepEqual(toAnthropicToolsDeferred(tools, { deferPatterns: [] }), toAnthropicTools(tools))
  assert.equal(
    JSON.stringify(toAnthropicToolsDeferred(tools, { deferPatterns: [] })),
    JSON.stringify(toAnthropicTools(tools)),
  )
})

test('a pattern defers the matching tools and adds the search tool first; loaded tools are untouched', () => {
  const out = toAnthropicToolsDeferred(
    [schema('write'), schema('mcp__b__two'), schema('bash'), schema('mcp__a__one')],
    { deferPatterns: ['mcp__*'] },
  )
  assert.deepEqual(out.map(entry => entry.name), [TOOL_SEARCH_TOOL_NAME, 'bash', 'mcp__a__one', 'mcp__b__two', 'write'])
  assert.deepEqual(out[0], search)
  assert.equal(out.filter(entry => entry.defer_loading === true).length, 2)
  assert.equal('defer_loading' in out[1], false)
  assert.equal('defer_loading' in out[4], false)
})

test('a tool DSH marked with deferLoading is deferred without any pattern', () => {
  const out = toAnthropicToolsDeferred([schema('bash'), schema('later', { deferLoading: true })], { deferPatterns: [] })
  assert.deepEqual(out.map(entry => entry.name), [TOOL_SEARCH_TOOL_NAME, 'bash', 'later'])
  assert.equal(out[2].defer_loading, true)
})

test('deferring every ordinary tool is valid: the search tool is the loaded one', () => {
  const out = toAnthropicToolsDeferred([schema('mcp__a__one'), schema('mcp__b__two')], { deferPatterns: ['mcp__*'] })
  assert.deepEqual(out[0], search)
  assert.deepEqual(out.slice(1).map(entry => entry.defer_loading), [true, true])
})

test('the wire order does not depend on the input order, and no deferred tool carries cache_control', () => {
  const tools = [schema('mcp__b__two'), schema('bash'), schema('mcp__a__one')]
  const forward = toAnthropicToolsDeferred(tools, { deferPatterns: ['mcp__*'] })
  const reversed = toAnthropicToolsDeferred([...tools].reverse(), { deferPatterns: ['mcp__*'] })
  assert.deepEqual(forward, reversed)
  for (const entry of forward) assert.equal('cache_control' in entry, false)
})

const body = (tools: ToolSchema[], patterns: readonly string[] = []): Record<string, unknown> => {
  const options: GenerateOptions<string> = {
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    system: 'be brief',
    messages: [{ id: MessageId('m'), role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
    tools,
  }
  return claudeRequestBody(options, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 1_000, undefined, undefined, undefined, patterns)
}

test('claudeRequestBody: default patterns leave the whole body identical to the pre-existing shape', () => {
  const tools = [schema('mcp__a__one'), schema('bash')]
  assert.equal(JSON.stringify(body(tools)), JSON.stringify(body(tools, [])))
  assert.deepEqual(body(tools).tools, toAnthropicTools(tools))
})

test('claudeRequestBody: the cache marks stay on system and messages, never on tools', () => {
  const sent = body([schema('mcp__a__one'), schema('bash')], ['mcp__*'])
  for (const entry of sent.tools as Record<string, unknown>[]) assert.equal('cache_control' in entry, false)
  const system = sent.system as Record<string, unknown>[]
  assert.notEqual(system[system.length - 1].cache_control, undefined)
})

const session: ClaudeSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scopes: 'scope' }

const tokens = (): AccountTokenManager<ClaudeSession> => new AccountTokenManager<ClaudeSession>({
  provider: 'claude',
  displayName: 'Test',
  makeOptions: () => ({ preemptMs: 0, refresh: s => Promise.resolve(s), isPermanent: () => false }),
  io: {
    list: () => Promise.resolve([{ key: 'acct', session }]),
    get: () => Promise.resolve(session),
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  },
})

async function sentTools(deferToolPatterns?: () => readonly string[]): Promise<Record<string, unknown>[]> {
  const original = globalThis.fetch
  let sent = ''
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent = String(init?.body)
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stop here' } }), { status: 400 })
  }) as typeof globalThis.fetch
  try {
    const adapter = new ClaudeAdapter({
      models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }],
      streamIdleTimeoutMs: 1000,
      tokens: tokens(),
      discovery: false,
      resolveCliVersion: async () => '2.1.999',
      ...deferToolPatterns === undefined ? {} : { deferToolPatterns },
    })
    const options: GenerateOptions = {
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      system: 'be brief',
      messages: [{ id: MessageId('m'), role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      tools: [schema('bash'), schema('mcp__a__one'), schema('mcp__a__two')],
      maxTokens: 1_000,
    }
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options)) { /* drain */ } })
    return (JSON.parse(sent) as { tools: Record<string, unknown>[] }).tools
  } finally {
    globalThis.fetch = original
  }
}

test('the adapter sends deferred tools only when the pattern option is set, and reads it per request', async () => {
  assert.deepEqual((await sentTools()).map(entry => entry.name), ['bash', 'mcp__a__one', 'mcp__a__two'])
  assert.deepEqual((await sentTools(() => [])).map(entry => entry.name), ['bash', 'mcp__a__one', 'mcp__a__two'])
  let current: readonly string[] = []
  const live = () => current
  assert.equal((await sentTools(live)).some(entry => entry.defer_loading === true), false)
  current = ['mcp__*']
  const deferred = await sentTools(live)
  assert.deepEqual(deferred.map(entry => entry.name), [TOOL_SEARCH_TOOL_NAME, 'bash', 'mcp__a__one', 'mcp__a__two'])
  assert.deepEqual(deferred.map(entry => entry.defer_loading), [undefined, undefined, true, true])
})

const feed = (events: readonly Record<string, unknown>[]): { chunks: StreamChunk[], translator: AnthropicStreamTranslator } => {
  const translator = new AnthropicStreamTranslator()
  const chunks: StreamChunk[] = []
  for (const event of events) chunks.push(...translator.push(event as unknown as AnthropicStreamEvent))
  return { chunks, translator }
}

test('the stream the endpoint sends when the search tool runs: server blocks are ignored, the client tool call survives', () => {
  const { chunks, translator } = feed(claudeToolSearchStream)
  const ended = chunks.flatMap(chunk => (chunk.type === 'block-end' ? [chunk.block] : []))
  assert.deepEqual(ended.map(block => block.type), ['tool-call'], 'server_tool_use and tool_search_tool_result produce no harness block')
  const call = ended[0]
  assert.equal(call.type === 'tool-call' && call.name, 'hora_atual')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.equal(translator.terminated, true)
})

test('usage with a search inside the turn is the cumulative total from message_delta, not the first iteration from message_start', () => {
  const { chunks } = feed(claudeToolSearchStream)
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.deepEqual(usage, { type: 'usage', usage: { inputTokens: 1638, outputTokens: 124, cacheReadTokens: 0, cacheWriteTokens: 0 } })
})

test('usage of an ordinary reply is unchanged: message_delta repeats the message_start figures', () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 422, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 422, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 4 } },
    { type: 'message_stop' },
  ]
  const usage = feed(events).chunks.find(chunk => chunk.type === 'usage')
  assert.deepEqual(usage, { type: 'usage', usage: { inputTokens: 422, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 5 } })
  // A delta with only output_tokens (the shape used before) leaves the start figures alone.
  const legacy = [events[0], events[1], events[2], events[3], { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, events[5]]
  assert.deepEqual(feed(legacy).chunks.find(chunk => chunk.type === 'usage'),
    { type: 'usage', usage: { inputTokens: 422, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 5 } })
})

test('claudeRequestBody: a tool DSH marked with deferLoading is deferred when core passes it through', () => {
  const sent = body([schema('bash'), schema('later', { deferLoading: true })])
  assert.deepEqual((sent.tools as Record<string, unknown>[]).map(entry => entry.name), [TOOL_SEARCH_TOOL_NAME, 'bash', 'later'])
  assert.equal((sent.tools as Record<string, unknown>[])[2].defer_loading, true)
})

test('the plugin Config defaults claudeDeferTools to an empty list and rejects non-arrays and non-strings', () => {
  const parse = plugin.Config as unknown as (value: unknown) => { claudeDeferTools?: unknown }
  assert.deepEqual(parse({}).claudeDeferTools, [])
  assert.deepEqual(parse({ claudeDeferTools: ['mcp__*', 'bash'] }).claudeDeferTools, ['mcp__*', 'bash'])
  for (const invalid of ['mcp__*', [1], {}, true]) {
    assert.throws(() => parse({ claudeDeferTools: invalid }), /claudeDeferTools/, `rejects ${JSON.stringify(invalid)}`)
  }
})

test('apply rejects empty patterns and patterns with surrounding whitespace, which would match nothing', () => {
  const message = /claudeDeferTools must be an array of non-empty strings without surrounding whitespace/
  for (const invalid of [[''], ['  '], [' mcp__*'], ['mcp__* '], ['mcp__*', ''], [null]]) {
    assert.throws(
      () => plugin.apply(new Context(), { providers: ['claude'], claudeDeferTools: invalid } as never),
      message,
      `rejects ${JSON.stringify(invalid)}`,
    )
  }
})
