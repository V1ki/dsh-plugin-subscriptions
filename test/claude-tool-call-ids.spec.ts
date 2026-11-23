/**
 * Tool-call ids on the Claude wire. A session can switch providers mid-way,
 * so a Claude request may carry calls another route produced: the OpenAI
 * Codex route records ids as `call_…|fc_…`, which the Messages API refuses
 * (HTTP 400, "tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'").
 * The request builder must send such ids in an accepted form, keep every
 * tool_result paired with its tool_use, never let two ids collide, leave
 * accepted ids untouched, and send the same form on every request so the
 * cached prefix and Claude's thinking replay keep working. No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import { AnthropicStreamTranslator, toAnthropicMessages } from '../src/translate/anthropic.js'
import type { AnthropicMessage, AnthropicStreamEvent, ThinkingBinding } from '../src/translate/anthropic.js'
import type { TranslatableBlock, TranslatableMessage } from '../src/translate/resolved.js'
import { claudeRequest } from '../src/providers/claude.js'

/** What the Messages API accepts in `tool_use.id` and `tool_result.tool_use_id`, as its 400 states. */
const ACCEPTED_ID = /^[a-zA-Z0-9_-]+$/
const MODEL = 'claude-opus-5-5'
const ADAPTIVE = { type: 'adaptive', display: 'summarized' }
const TOOLS: ToolSchema[] = [
  { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
]
const CODEX = { kind: 'model' as const, provider: 'openai-codex', model: 'gpt-6.1-sol' }

/** An id in the shape the OpenAI Codex route records: `call_<32>|fc_<50>`, 91 characters. */
function codexCallId(n: number): string {
  return `call_${`Ab${n}`.padEnd(32, 'x')}|fc_${`68ac${n}`.padEnd(50, '0')}`
}

function user(text: string): TranslatableMessage {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function codexTurn(content: TranslatableBlock[]): TranslatableMessage {
  return { role: 'assistant', content, source: CODEX }
}

function call(id: string, args = '{"cmd":"ls"}'): TranslatableBlock {
  return { type: 'tool-call', id: ToolCallId(id), name: 'bash', arguments: args }
}

/** A tool result as current DSH stores it: a tool-role message naming its call in both places. */
function toolMessage(id: string, text: string): TranslatableMessage {
  return { role: 'tool', toolCallId: id, content: [{ type: 'text', text }], source: { kind: 'tool', callId: ToolCallId(id) } }
}

function options(messages: readonly TranslatableMessage[]): GenerateOptions {
  return { provider: 'claude', model: MODEL, messages: messages as unknown as Message[], system: 'You are a coding agent.', tools: TOOLS }
}

/** The request the Claude (Subscription) route sends for this history, plus its thinking binding. */
function claude(messages: readonly TranslatableMessage[]) {
  return claudeRequest(options(messages), messages, 32_000, ADAPTIVE)
}

function wire(body: Record<string, unknown>): AnthropicMessage[] {
  return body.messages as AnthropicMessage[]
}

/** Every tool_use id and tool_result reference of a request, in wire order. */
function toolIds(messages: readonly AnthropicMessage[]): { uses: string[]; results: string[] } {
  const uses: string[] = []
  const results: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.push(String(block.id))
      if (block.type === 'tool_result') results.push(String(block.tool_use_id))
    }
  }
  return { uses, results }
}

function assertAccepted(messages: readonly AnthropicMessage[]): void {
  const { uses, results } = toolIds(messages)
  for (const id of [...uses, ...results]) {
    assert.match(id, ACCEPTED_ID)
    assert.ok(id.length <= 64, `${id} is longer than 64 characters`)
  }
}

/** The pairing the API enforces: a user message's tool_result answers a tool_use of the assistant message before it. */
function assertPaired(messages: readonly AnthropicMessage[]): void {
  for (const [index, message] of messages.entries()) {
    const answered = message.content.filter(block => block.type === 'tool_result').map(block => String(block.tool_use_id))
    if (answered.length === 0) continue
    const previous = messages[index - 1]
    assert.equal(previous?.role, 'assistant', `messages.${index} answers tool calls without an assistant message before it`)
    const calls = previous.content.filter(block => block.type === 'tool_use').map(block => String(block.id))
    for (const id of answered) assert.ok(calls.includes(id), `messages.${index}: tool_result ${id} answers no tool_use of messages.${index - 1}`)
  }
}

/** Cache markers move as the conversation grows; the prefix check and the cache read compare everything else. */
function withoutCacheMarks(messages: readonly AnthropicMessage[]): AnthropicMessage[] {
  return messages.map(message => ({
    role: message.role,
    content: message.content.map(({ cache_control: _mark, ...block }) => block),
  }))
}

/** Stream one Claude answer (signed thinking, then a call of its own) and store it as the harness does. */
function claudeAnswer(binding: ThinkingBinding, callId: string): TranslatableMessage {
  const events: AnthropicStreamEvent[] = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check where we are' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-tool-call-ids-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: callId, name: 'bash' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"pwd"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  const translator = new AnthropicStreamTranslator(binding)
  const assembler = new BlockAssembler()
  for (const event of events) for (const chunk of translator.push(event)) assembler.push(chunk)
  const replayState = assembler.replayState
  assert.ok(replayState !== undefined, 'the answer records its signed thinking')
  return {
    role: 'assistant',
    content: assembler.blocks() as TranslatableBlock[],
    source: { kind: 'model', provider: 'claude', model: MODEL, replayState: structuredClone(replayState) },
  }
}

test('switching from OpenAI Codex to Claude: a "|" tool-call id goes out as a valid tool_use id, still paired', () => {
  const id = codexCallId(1)
  const history = [
    user('list files'),
    codexTurn([{ type: 'text', text: 'running ls' }, call(id)]),
    toolMessage(id, 'a\nb'),
    codexTurn([{ type: 'text', text: 'two files' }]),
    user('continue with Claude'),
  ]
  const stored = structuredClone(history)
  const messages = wire(claude(history).body)

  // The block the API refused: messages.1.content.1.tool_use.id.
  const use = messages[1].content[1]
  assert.equal(use.type, 'tool_use')
  assert.match(String(use.id), ACCEPTED_ID)
  assert.ok(String(use.id).length <= 64)
  // Pinned: sessions that already switched were sent exactly this id. Any other
  // form (a new rule, a per-process salt) rewrites their cached prefix and
  // drops their recorded thinking, so it must be a deliberate change.
  assert.equal(use.id, 'call_Ab1xxxxxxxxxxxxxxxxxxxxxxxxxxxxx_fc_68ac10_cWHdAeHUGHonL-O0')
  assert.deepEqual(withoutCacheMarks(messages)[2].content[0], { type: 'tool_result', tool_use_id: use.id, content: 'a\nb' })
  assertAccepted(messages)
  assertPaired(messages)

  // Only the request changes: the stored history keeps its original ids.
  assert.deepEqual(history, stored)
  // The same history always produces the same request.
  assert.deepEqual(claude(history).body, claude(history).body)
})

test('every tool-result history format answers its normalized tool_use', () => {
  const ids = [1, 2, 3, 4, 5].map(codexCallId)
  const history: TranslatableMessage[] = [
    user('go'),
    // Parallel calls whose results arrive as separate messages.
    codexTurn([call(ids[0]), call(ids[1])]),
    // Current DSH: a tool-role message with toolCallId and the same source.callId.
    toolMessage(ids[0], 'first'),
    // Imported Chat Completions history: only tool_call_id.
    { role: 'tool', tool_call_id: ids[1], content: [{ type: 'text', text: 'second' }] },
    codexTurn([call(ids[2])]),
    // Only the message source names the call.
    { role: 'tool', content: [{ type: 'text', text: 'third' }], source: { kind: 'tool', callId: ToolCallId(ids[2]) } },
    codexTurn([call(ids[3])]),
    // Older hosts: a tool-result block nested in a user message.
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: ToolCallId(ids[3]), content: [{ type: 'text', text: 'fourth' }], isError: true }],
      source: { kind: 'tool', callId: ToolCallId(ids[3]) },
    },
    codexTurn([call(ids[4])]),
    toolMessage(ids[4], 'fifth'),
    user('summarize'),
  ]
  const messages = withoutCacheMarks(wire(claude(history).body))
  assertAccepted(messages)
  assertPaired(messages)
  const { uses, results } = toolIds(messages)
  assert.equal(new Set(uses).size, ids.length, 'every call keeps an id of its own')
  assert.deepEqual(results, uses, 'each call is answered once, in call order')
  // Each result still answers the call it answered in the history.
  const answers = new Map(messages.flatMap(message => message.content)
    .filter(block => block.type === 'tool_result')
    .map(block => [String(block.tool_use_id), block.content]))
  assert.deepEqual(uses.map(id => answers.get(id)), ['first', 'second', 'third', 'fourth', 'fifth'])
  assert.equal(messages.flatMap(message => message.content).find(block => block.content === 'fourth')?.is_error, true)
})

test('tool-call ids the API accepts are sent verbatim next to normalized ones', () => {
  const plain = 'call_abc-123_DEF'
  const foreign = codexCallId(7)
  const claudeId = 'toolu_01A09q90qw90lq917835lq9'
  const history: TranslatableMessage[] = [
    user('go'),
    codexTurn([call(plain), call(foreign)]),
    toolMessage(plain, 'one'),
    toolMessage(foreign, 'two'),
    { role: 'assistant', content: [call(claudeId)], source: { kind: 'model', provider: 'claude', model: MODEL } },
    toolMessage(claudeId, 'three'),
    user('next'),
  ]
  const messages = wire(claude(history).body)
  const { uses, results } = toolIds(messages)
  assert.equal(uses[0], plain)
  assert.equal(uses[2], claudeId)
  assert.notEqual(uses[1], foreign)
  assert.deepEqual(results, uses)
  assertAccepted(messages)
  assertPaired(messages)
})

test('a normalized id never takes an id another call of the request already has', () => {
  const foreign = 'call_x|fc_y'
  // What the foreign id becomes on its own …
  const [alone] = toolIds(toAnthropicMessages([codexTurn([call(foreign)]), toolMessage(foreign, 'r')])).uses
  assert.equal(alone, 'call_x_fc_y_GBNlpy9_LWOX42zM')
  // … is a genuine call's id here: the genuine call keeps it and the foreign id moves elsewhere.
  const messages = toAnthropicMessages([
    codexTurn([call(alone), call(foreign)]),
    toolMessage(alone, 'genuine'),
    toolMessage(foreign, 'foreign'),
  ])
  const { uses } = toolIds(messages)
  assert.equal(uses[0], alone)
  assert.equal(uses[1], 'call_x_fc_y_0qg745CdcD-FHQCU', 'derived again, deterministically')
  assert.deepEqual(messages[1].content.map(block => [block.tool_use_id, block.content]), [[alone, 'genuine'], [uses[1], 'foreign']])
  assertAccepted(messages)
  assertPaired(messages)
})

test('ids that differ only in refused characters or past the length cut stay distinct', () => {
  const ids = ['a|b', 'a.b', 'a b', 'a_b', '|', '', `${'x'.repeat(100)}|1`, `${'x'.repeat(100)}|2`]
  const messages = toAnthropicMessages([
    codexTurn(ids.map(id => call(id))),
    ...ids.map((id, index) => toolMessage(id, `result ${index}`)),
  ])
  const { uses, results } = toolIds(messages)
  assert.equal(new Set(uses).size, ids.length)
  assert.equal(uses[3], 'a_b', 'an accepted id stays verbatim next to refused ids with the same sanitized stem')
  assert.deepEqual(results, uses)
  assertAccepted(messages)
  assertPaired(messages)
})

test('normalized ids repeat on every request, so the cached prefix and Claude thinking replay survive the switch', () => {
  const id = codexCallId(9)
  const history = [
    user('list files'),
    codexTurn([{ type: 'text', text: 'running ls' }, call(id)]),
    toolMessage(id, 'a\nb'),
    user('continue with Claude'),
  ]
  const first = claude(history)
  const next = [...history, claudeAnswer(first.binding, 'toolu_01NextCall'), toolMessage('toolu_01NextCall', '/tmp')]
  const second = claude(next)

  const before = withoutCacheMarks(wire(first.body))
  const after = withoutCacheMarks(wire(second.body))
  // The turns already sent go out byte-for-byte again, cache markers aside …
  assert.deepEqual(after.slice(0, before.length), before)
  // … so the thinking Claude produced against that prefix is replayed.
  assert.equal(second.replayedThinking, 1)
  assertAccepted(after)
  assertPaired(after)
})
