/**
 * Claude thinking replay: the SSE translator keeps each thinking block's
 * signature (and each redacted_thinking payload) in the finish envelope, and
 * the request translator sends them back as signed `thinking` /
 * `redacted_thinking` blocks to the same route and model. No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmAdapter, LlmRuntime, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ReplayEnvelope, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import {
  AnthropicStreamTranslator,
  REDACTED_THINKING_TEXT,
  markMessageCache,
  toAnthropicMessages,
} from '../src/translate/anthropic.js'
import type { AnthropicMessage, AnthropicStreamEvent } from '../src/translate/anthropic.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'
import { claudeRequestBody } from '../src/providers/claude.js'
import { AccountPreferencesAdapter, accountModelId } from '../src/providers/account-preferences.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { poolKey } from '../src/providers/pool-family.js'

const MODEL = 'claude-opus-5-5'
const TARGET = { provider: 'claude', model: MODEL }

function drain(translator: AnthropicStreamTranslator, events: AnthropicStreamEvent[]): StreamChunk[] {
  return events.flatMap(event => translator.push(event))
}

/** One assistant response: signed thinking, a sentence, then a tool call. */
function thinkingThenTool(signature: string, thinking = 'I should list the files first.'): AnthropicStreamEvent[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 40 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinking.slice(0, 10) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinking.slice(10) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: signature.slice(0, 4) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: signature.slice(4) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Listing.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ]
}

/** Assemble a streamed response the way the harness stores it. */
function assemble(chunks: readonly StreamChunk[], model = MODEL, provider = 'claude'): Message {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const replayState = assembler.replayState
  return {
    id: MessageId(`a-${Math.random()}`),
    role: 'assistant',
    content: assembler.blocks(),
    source: { kind: 'model', provider, model, ...replayState === undefined ? {} : { replayState } },
  }
}

function user(text: string): Message {
  return { id: MessageId(`u-${Math.random()}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function toolResult(callId: string, text: string): Message {
  return {
    id: MessageId(`t-${Math.random()}`),
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId: ToolCallId(callId) },
  } as unknown as Message
}

function assistantContent(messages: AnthropicMessage[]): Record<string, unknown>[] {
  return messages.filter(message => message.role === 'assistant').flatMap(message => message.content)
}

test('translator: a signed thinking block keeps its signature in the finish envelope', () => {
  const chunks = drain(new AnthropicStreamTranslator(), thinkingThenTool('sig-ABCDEFGH'))
  // The signature is not harness content: no delta carries it.
  assert.equal(chunks.some(chunk => JSON.stringify(chunk).includes('sig-ABCDEFGH') && chunk.type !== 'finish'), false)
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  assert.deepEqual(finish?.type === 'finish' ? finish.reason : undefined, { kind: 'tool-calls' })
  assert.deepEqual(finish?.type === 'finish' ? finish.replayState : undefined, {
    response: { kind: 'anthropic', version: 1 },
    blocks: [{ signature: 'sig-ABCDEFGH' }, {}, {}],
  })
  const reasoning = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.deepEqual(reasoning?.type === 'block-end' ? reasoning.block : undefined, {
    type: 'reasoning', text: 'I should list the files first.',
  })
})

test('translator: a response without signed thinking carries no envelope, as before', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('translator: redacted_thinking keeps its payload and shows a placeholder', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
  const reasoning = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.deepEqual(reasoning?.type === 'block-end' ? reasoning.block : undefined, { type: 'reasoning', text: REDACTED_THINKING_TEXT })
  const finish = chunks.at(-1)
  assert.deepEqual(finish?.type === 'finish' ? finish.replayState?.blocks : undefined, [{ redactedData: 'ENCRYPTED' }, {}])
})

test('translator: a thinking block closed by message_stop still records its signature', () => {
  const events = thinkingThenTool('sig-late').filter(event => !(event.type === 'content_block_stop' && event.index === 0))
  const finish = drain(new AnthropicStreamTranslator(), events).at(-1)
  assert.equal(finish?.type, 'finish')
  const blocks = finish?.type === 'finish' ? finish.replayState?.blocks : undefined
  assert.ok(blocks?.some(entry => (entry as { signature?: string }).signature === 'sig-late'))
})

test('replay: a tool-loop continuation sends the signed thinking back first, in place', () => {
  const assistant = assemble(drain(new AnthropicStreamTranslator(), thinkingThenTool('sig-1')))
  const history = [user('list the files'), assistant, toolResult('toolu_1', 'a.py\nb.py')]
  const wire = toAnthropicMessages(history as TranslatableMessage[], TARGET)
  assert.deepEqual(wire, [
    { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'I should list the files first.', signature: 'sig-1' },
      { type: 'text', text: 'Listing.' },
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { cmd: 'ls' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.py\nb.py' }] },
  ])
})

test('replay: without a target (the previous behavior) reasoning is still dropped', () => {
  const assistant = assemble(drain(new AnthropicStreamTranslator(), thinkingThenTool('sig-1')))
  const wire = toAnthropicMessages([user('x'), assistant, toolResult('toolu_1', 'ok')] as TranslatableMessage[])
  assert.equal(assistantContent(wire).some(block => block.type === 'thinking'), false)
})

test('replay: thinking from another model or route is never sent', () => {
  const chunks = drain(new AnthropicStreamTranslator(), thinkingThenTool('sig-1'))
  for (const [provider, model] of [['claude', 'claude-sonnet-5-5'], ['antigravity', MODEL], ['codex', 'gpt-6.1-sol']] as const) {
    const assistant = assemble(chunks, model, provider)
    const wire = toAnthropicMessages([user('x'), assistant, toolResult('toolu_1', 'ok')] as TranslatableMessage[], TARGET)
    assert.equal(assistantContent(wire).some(block => block.type === 'thinking'), false, `${provider}/${model} must not replay`)
    assert.ok(assistantContent(wire).some(block => block.type === 'tool_use'), 'the tool call itself still replays')
  }
})

test('replay: reasoning without a stored signature (older history) is dropped on its own', () => {
  const legacy: Message = {
    id: MessageId('legacy'),
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'old' }, { type: 'text', text: 'answer' }],
    source: { kind: 'model', provider: 'claude', model: MODEL },
  }
  const mixed: Message = {
    id: MessageId('mixed'),
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'signed' },
      { type: 'tool-call', id: ToolCallId('toolu_2'), name: 'bash', arguments: '{}' },
      { type: 'reasoning', text: 'unsigned' },
      { type: 'tool-call', id: ToolCallId('toolu_3'), name: 'bash', arguments: '{}' },
    ],
    source: { kind: 'model', provider: 'claude', model: MODEL, replayState: {
      response: { kind: 'anthropic', version: 1 },
      blocks: [{ signature: 'sig-2' }, {}, {}, {}],
    } },
  }
  const wire = toAnthropicMessages([user('q'), legacy, user('again'), mixed, toolResult('toolu_2', 'a'), toolResult('toolu_3', 'b')] as TranslatableMessage[], TARGET)
  const thinking = assistantContent(wire).filter(block => block.type === 'thinking')
  assert.deepEqual(thinking, [{ type: 'thinking', thinking: 'signed', signature: 'sig-2' }])
})

test('replay: a foreign or misaligned envelope replays nothing', () => {
  const foreign: Message = {
    id: MessageId('foreign'),
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 't' }],
    source: { kind: 'model', provider: 'claude', model: MODEL, replayState: {
      response: { kind: 'antigravity', version: 1 }, blocks: [{ signature: 'x' }, {}],
    } },
  }
  const misaligned: Message = {
    ...foreign,
    id: MessageId('misaligned'),
    source: { kind: 'model', provider: 'claude', model: MODEL, replayState: {
      response: { kind: 'anthropic', version: 1 }, blocks: [{ signature: 'x' }],
    } },
  }
  for (const message of [foreign, misaligned]) {
    const wire = toAnthropicMessages([user('q'), message] as TranslatableMessage[], TARGET)
    assert.equal(assistantContent(wire).some(block => block.type === 'thinking'), false)
  }
})

test('replay: redacted thinking goes back verbatim', () => {
  const chunks = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'bash' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
  const wire = toAnthropicMessages([user('q'), assemble(chunks), toolResult('toolu_9', 'ok')] as TranslatableMessage[], TARGET)
  assert.deepEqual(assistantContent(wire)[0], { type: 'redacted_thinking', data: 'ENCRYPTED' })
})

test('cache marks never land on a thinking block', () => {
  // A history whose last assistant blocks are thinking: the stride would hit them.
  const messages: AnthropicMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 't', signature: 's' },
      { type: 'redacted_thinking', data: 'd' },
    ] },
  ]
  markMessageCache(messages)
  assert.equal(messages[1].content.some(block => block.cache_control !== undefined), false)
  assert.deepEqual(messages[0].content[0].cache_control, { type: 'ephemeral' })

  // Across a long tool loop every thinking block stays unmarked and the
  // breakpoints still number three.
  const long: AnthropicMessage[] = []
  for (let step = 0; step < 30; step++) {
    long.push({ role: 'assistant', content: [
      { type: 'thinking', thinking: `t${step}`, signature: `s${step}` },
      { type: 'tool_use', id: `toolu_${step}`, name: 'bash', input: {} },
    ] })
    long.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${step}`, content: 'ok' }] })
  }
  markMessageCache(long)
  const marked = long.flatMap(message => message.content).filter(block => block.cache_control !== undefined)
  assert.equal(marked.length, 3)
  assert.equal(marked.some(block => block.type === 'thinking' || block.type === 'redacted_thinking'), false)
})

test('claudeRequestBody replays signed thinking only for the requested model', () => {
  const assistant = assemble(drain(new AnthropicStreamTranslator(), thinkingThenTool('sig-body')))
  const history = [user('list'), assistant, toolResult('toolu_1', 'ok')]
  const same = claudeRequestBody({ provider: 'claude', model: MODEL, messages: history }, history as TranslatableMessage[], 32_000, { type: 'adaptive', display: 'summarized' })
  const other = claudeRequestBody({ provider: 'claude', model: 'claude-sonnet-5-5', messages: history }, history as TranslatableMessage[], 32_000, { type: 'adaptive', display: 'summarized' })
  const blocks = (body: Record<string, unknown>) => (body.messages as AnthropicMessage[]).flatMap(message => message.content)
  assert.ok(blocks(same).some(block => block.type === 'thinking' && block.signature === 'sig-body'))
  assert.equal(blocks(other).some(block => block.type === 'thinking'), false)
})

/**
 * End to end through the host runtime: a first request's thinking signature
 * survives assembly, the account-replay wrapper and the history round trip,
 * then reaches the next request's wire body — for the same account only.
 */
for (const mode of ['independent', 'pool'] as const) test(`${mode} route: signed thinking round-trips to the same account and model only`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-thinking-'))
  let wire: AnthropicMessage[] = []
  class Raw extends LlmAdapter {
    listOwnModels = async (provider: string) => [{ provider, id: MODEL, name: MODEL }]
    resolveOwnModel = async (provider: string, id: string) => ({ provider, id, name: id })
    clearAccountCatalog() {}
    async *stream(): AsyncIterable<StreamChunk> { throw new Error('use account seam') }
    async *streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
      wire = toAnthropicMessages(options.messages as TranslatableMessage[], { provider: options.provider, model: options.model })
      yield* drain(new AnthropicStreamTranslator(), thinkingThenTool(`signature-${account}`))
    }
  }
  const raw = new Raw()
  const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
  await settings.set('claude', { accounts: { a: { independentEntry: true }, b: { independentEntry: true } } })
  let member = 'a'
  const pool = new PoolAdapter({ adapters: { claude: raw }, health: new PoolHealthRegistry(), usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
    defaultAccount: async () => 'a', families: async () => new Map([[poolKey('claude', 'tier'), { members: [{ provider: 'claude', account: member, model: MODEL }] }]]), tiers: {}, onWarn: () => {} })
  const route = new AccountPreferencesAdapter({ provider: 'claude', adapter: raw, settings, accounts: async () => ['a', 'b'].map(key => ({ key, label: key })), pool: () => mode === 'pool' ? pool : undefined })
  const llm = new LlmRuntime(new Context())
  const dispose = llm.registerAdapter(['claude'], route)
  const selected = mode === 'pool' ? 'tier' : accountModelId('a', MODEL)
  try {
    const content: Message['content'][number][] = []
    let replayState: ReplayEnvelope | undefined
    for await (const chunk of llm.stream({ provider: 'claude', model: selected, messages: [user('list')] })) {
      if (chunk.type === 'block-end') content.push(chunk.block)
      if (chunk.type === 'finish') replayState = chunk.replayState
    }
    assert.ok(replayState, 'the finish chunk carries the thinking envelope')
    const history: Message[] = [
      user('list'),
      { role: 'assistant', id: MessageId('signed'), source: { kind: 'model', provider: 'claude', model: selected, replayState: structuredClone(replayState) }, content },
      toolResult('toolu_1', 'a.py'),
    ]
    for await (const _ of llm.stream({ provider: 'claude', model: selected, messages: history })) { /* drain */ }
    assert.deepEqual(assistantContent(wire)[0], { type: 'thinking', thinking: 'I should list the files first.', signature: 'signature-a' })

    member = 'b'; pool.invalidate()
    const next = mode === 'pool' ? 'tier' : accountModelId('b', MODEL)
    for await (const _ of llm.stream({ provider: 'claude', model: next, messages: history })) { /* drain */ }
    assert.equal(assistantContent(wire).some(block => block.type === 'thinking'), false, 'another account must not receive this signature')
    assert.ok(assistantContent(wire).some(block => block.type === 'tool_use'), 'the rest of the turn still replays')
  } finally { dispose(); await rm(dir, { recursive: true, force: true }) }
})
