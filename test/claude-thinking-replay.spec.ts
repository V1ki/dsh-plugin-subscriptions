/**
 * Claude thinking replay. The SSE translator keeps each thinking block's
 * signature (and each redacted_thinking payload) plus the binding of the
 * request it answered; the request builder sends them back as signed
 * `thinking` / `redacted_thinking` blocks to the same route and model, but
 * only while the block's prefix (system, tools, earlier messages) is
 * unchanged and the run of thinking blocks stays unbroken. No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmAdapter, LlmError, LlmRuntime, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ReplayEnvelope, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import {
  AnthropicStreamTranslator,
  REDACTED_THINKING_TEXT,
  isRefusedThinkingError,
  markMessageCache,
  toAnthropicMessages,
} from '../src/translate/anthropic.js'
import type { AnthropicMessage, AnthropicStreamEvent, ThinkingBinding } from '../src/translate/anthropic.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'
import { checksThinkingPrefix, claudeRequest, claudeRequestBody, withThinkingBinding } from '../src/providers/claude.js'
import { AccountPreferencesAdapter, accountModelId } from '../src/providers/account-preferences.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { poolKey } from '../src/providers/pool-family.js'

const MODEL = 'claude-opus-5-5'
const ADAPTIVE = { type: 'adaptive', display: 'summarized' }
const TOOLS: ToolSchema[] = [
  { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
  { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]

/** One step of a conversation: the system prompt and tools it was sent with. */
interface Shape { system?: string; tools?: ToolSchema[]; model?: string; provider?: string }

function options(messages: Message[], shape: Shape = {}): GenerateOptions {
  return {
    provider: shape.provider ?? 'claude',
    model: shape.model ?? MODEL,
    messages,
    system: shape.system ?? 'You are a coding agent.',
    tools: shape.tools ?? TOOLS,
  }
}

/** The request the plugin sends for this history, plus its binding. */
function build(messages: Message[], shape: Shape = {}, replayThinking = true) {
  return claudeRequest(options(messages, shape), messages as TranslatableMessage[], 32_000, ADAPTIVE, undefined, undefined, replayThinking)
}

let signatureCounter = 0

/** The SSE events of one response: optional signed thinking, then text or a tool call. */
function responseEvents(opts: { thinking?: string[]; text?: string; tool?: { id: string; input: string }; redacted?: string }): {
  events: AnthropicStreamEvent[]
  signatures: string[]
} {
  const events: AnthropicStreamEvent[] = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }]
  const signatures: string[] = []
  let index = 0
  if (opts.redacted !== undefined) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: opts.redacted } })
    events.push({ type: 'content_block_stop', index: index++ })
  }
  for (const thought of opts.thinking ?? []) {
    const signature = `sig-${++signatureCounter}-${'x'.repeat(8)}`
    signatures.push(signature)
    events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: thought.slice(0, 3) } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: thought.slice(3) } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: signature.slice(0, 4) } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: signature.slice(4) } })
    events.push({ type: 'content_block_stop', index: index++ })
  }
  if (opts.text !== undefined) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text' } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: opts.text } })
    events.push({ type: 'content_block_stop', index: index++ })
  }
  if (opts.tool !== undefined) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: opts.tool.id, name: 'bash' } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: opts.tool.input } })
    events.push({ type: 'content_block_stop', index: index++ })
  }
  events.push({ type: 'message_delta', delta: { stop_reason: opts.tool === undefined ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 5 } })
  events.push({ type: 'message_stop' })
  return { events, signatures }
}

/** Stream a response the way the adapter does, and store it the way the harness does. */
function respond(binding: ThinkingBinding | undefined, events: AnthropicStreamEvent[], model = MODEL): Message {
  const translator = new AnthropicStreamTranslator(binding)
  const assembler = new BlockAssembler()
  for (const event of events) for (const chunk of translator.push(event)) assembler.push(chunk)
  const replayState = assembler.replayState
  return {
    id: MessageId(`a-${Math.random()}`),
    role: 'assistant',
    content: assembler.blocks(),
    source: { kind: 'model', provider: 'claude', model, ...replayState === undefined ? {} : { replayState: structuredClone(replayState) } },
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

function wireOf(body: Record<string, unknown>): AnthropicMessage[] {
  return body.messages as AnthropicMessage[]
}

/** Signatures (or redacted payloads) of the thinking a request replays, in wire order. */
function sentThinking(body: Record<string, unknown>): string[] {
  return wireOf(body).flatMap(message => message.content)
    .filter(block => block.type === 'thinking' || block.type === 'redacted_thinking')
    .map(block => String(block.type === 'thinking' ? block.signature : block.data))
}

/**
 * Run an append-only tool loop through the real request builder: each step's
 * response is produced with the binding of the request that asked for it.
 * @returns the history, every step's signatures, and the last request.
 */
function toolLoop(steps: number, shape: Shape = {}) {
  const history: Message[] = [user('fix the failing test')]
  const signatures: string[][] = []
  let request = build(history, shape)
  for (let step = 0; step < steps; step++) {
    const { events, signatures: produced } = responseEvents({
      thinking: [`step ${step}: I will run check ${step}`],
      text: `Running check ${step}.`,
      tool: { id: `toolu_${step}`, input: `{"cmd":"check ${step}"}` },
    })
    signatures.push(produced)
    history.push(respond(request.binding, events, shape.model ?? MODEL), toolResult(`toolu_${step}`, `ok ${step}`))
    request = build(history, shape)
  }
  return { history, signatures, request }
}

// --- capture -----------------------------------------------------------------

test('translator: a signed thinking block keeps its signature and the request binding in the envelope', () => {
  const binding: ThinkingBinding = { prefix: 'p', prev: null }
  const { events, signatures } = responseEvents({ thinking: ['I should list the files first.'], text: 'Listing.', tool: { id: 'toolu_1', input: '{"cmd":"ls"}' } })
  const chunks = events.flatMap(event => new AnthropicStreamTranslator(binding).push(event))
  const translator = new AnthropicStreamTranslator(binding)
  const all = events.flatMap(event => translator.push(event))
  assert.ok(chunks.length > 0)
  // The signature is not harness content: no delta carries it.
  assert.equal(all.some(chunk => chunk.type !== 'finish' && JSON.stringify(chunk).includes(signatures[0]!)), false)
  const finish = all.at(-1)
  assert.equal(finish?.type, 'finish')
  const envelope = finish?.type === 'finish' ? finish.replayState : undefined
  assert.deepEqual(envelope?.blocks, [{ signature: signatures[0] }, {}, {}])
  const response = envelope?.response as Record<string, unknown>
  assert.equal(response.kind, 'anthropic')
  assert.equal(response.version, 2)
  assert.equal(response.prefix, 'p')
  assert.equal(response.prev, null)
  assert.equal(typeof response.content, 'string')
})

test('translator: a response without signed thinking carries no envelope, as before', () => {
  const translator = new AnthropicStreamTranslator({ prefix: 'p', prev: null })
  const chunks = responseEvents({ text: 'hi' }).events.flatMap(event => translator.push(event))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('translator: redacted_thinking keeps its payload and shows a placeholder', () => {
  const translator = new AnthropicStreamTranslator({ prefix: 'p', prev: null })
  const chunks = responseEvents({ redacted: 'ENCRYPTED', text: 'done' }).events.flatMap(event => translator.push(event))
  const reasoning = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.deepEqual(reasoning?.type === 'block-end' ? reasoning.block : undefined, { type: 'reasoning', text: REDACTED_THINKING_TEXT })
  const finish = chunks.at(-1)
  assert.deepEqual(finish?.type === 'finish' ? finish.replayState?.blocks : undefined, [{ redactedData: 'ENCRYPTED' }, {}])
})

test('translator: a thinking block closed by message_stop still records its signature', () => {
  const { events, signatures } = responseEvents({ thinking: ['late'], text: 'x' })
  const withoutStop = events.filter((event, position) => !(event.type === 'content_block_stop' && events[position - 1]?.delta?.type === 'signature_delta'))
  const translator = new AnthropicStreamTranslator({ prefix: 'p', prev: null })
  const finish = withoutStop.flatMap(event => translator.push(event)).at(-1)
  const blocks = finish?.type === 'finish' ? finish.replayState?.blocks : undefined
  assert.ok(blocks?.some(entry => (entry as { signature?: string }).signature === signatures[0]))
})

// --- append-only replay ------------------------------------------------------

test('append-only tool loop: every step replays the whole unbroken run of signed thinking, in place', () => {
  const { signatures, request, history } = toolLoop(4)
  assert.deepEqual(sentThinking(request.body), signatures.flat())
  assert.equal(request.replayedThinking, 4)
  const assistant = wireOf(request.body)[1]!
  assert.deepEqual(assistant.content.map(block => block.type), ['thinking', 'text', 'tool_use'])
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'step 0: I will run check 0', signature: signatures[0]![0] })
  // A second user turn keeps everything.
  history.push(user('now also update the docs'))
  assert.deepEqual(sentThinking(build(history).body), signatures.flat())
})

test('cache marks never change what is replayed (they are not part of the prefix)', () => {
  const { history, signatures } = toolLoop(3)
  const fiveMinutes = claudeRequest(options(history), history as TranslatableMessage[], 32_000, ADAPTIVE, undefined, '5m')
  const oneHour = claudeRequest(options(history), history as TranslatableMessage[], 32_000, ADAPTIVE, undefined, '1h')
  assert.deepEqual(sentThinking(fiveMinutes.body), signatures.flat())
  assert.deepEqual(sentThinking(oneHour.body), signatures.flat())
})

test('reordering tools does not invalidate thinking (the API compares tools as a set)', () => {
  const { history, signatures } = toolLoop(2)
  assert.deepEqual(sentThinking(build(history, { tools: [...TOOLS].reverse() }).body), signatures.flat())
})

// --- prefix changes ----------------------------------------------------------

test('a changed system prompt drops all replayed thinking but keeps the history', () => {
  const { history } = toolLoop(3)
  const request = build(history, { system: 'You are a careful coding agent.' })
  assert.deepEqual(sentThinking(request.body), [])
  assert.equal(request.replayedThinking, 0)
  const blocks = wireOf(request.body).flatMap(message => message.content)
  assert.equal(blocks.filter(block => block.type === 'tool_use').length, 3, 'tool calls still replay')
  assert.equal(blocks.filter(block => block.type === 'tool_result').length, 3, 'tool results still replay')
})

test('adding, removing or editing a tool drops all replayed thinking', () => {
  const { history } = toolLoop(2)
  const added = [...TOOLS, { name: 'write', description: 'write a file', parameters: { type: 'object' } }]
  const edited = TOOLS.map(tool => tool.name === 'bash' ? { ...tool, description: 'run a shell command' } : tool)
  const schema = TOOLS.map(tool => tool.name === 'read' ? { ...tool, parameters: { type: 'object', properties: { file: { type: 'string' } } } } : tool)
  for (const tools of [added, TOOLS.slice(1), edited, schema]) {
    assert.deepEqual(sentThinking(build(history, { tools }).body), [])
  }
})

test('replacing an earlier user message drops every thinking block after it', () => {
  const { history } = toolLoop(3)
  const changed = structuredClone(history)
  changed[0] = user('replacement summary')
  assert.deepEqual(sentThinking(build(changed).body), [])
})

test('the reviewer reproduction: an edited first message no longer carries the old signature', () => {
  const first = build([user('original prompt')])
  const assistant = respond(first.binding, responseEvents({ thinking: ['summary'], text: 'answer' }).events)
  const history = [user('original prompt'), assistant]
  const body = claudeRequestBody(options(history), history as TranslatableMessage[], 32_000, ADAPTIVE)
  assert.equal(sentThinking(body).length, 1, 'unchanged history replays')
  const changed = structuredClone(history)
  ;(changed[0]!.content[0] as { text: string }).text = 'replacement summary'
  const edited = claudeRequestBody(options(changed), changed as TranslatableMessage[], 32_000, ADAPTIVE)
  assert.deepEqual(sentThinking(edited), [])
})

test('a shortened earlier tool result (pruning) keeps the thinking before it and drops the thinking after it', () => {
  const { history, signatures } = toolLoop(4)
  const pruned = structuredClone(history)
  // History: user, a0, t0, a1, t1, a2, t2, a3, t3. Prune t1 (index 4).
  pruned[4] = toolResult('toolu_1', 'ok [... tool result middle pruned ...]')
  assert.deepEqual(sentThinking(build(pruned).body), [signatures[0]![0], signatures[1]![0]])
})

test('compaction: a rewritten head drops the thinking of the retained tail', () => {
  const { history } = toolLoop(4)
  const compacted: Message[] = [user('<compacted-summary>ran checks 0-2</compacted-summary>'), ...history.slice(7)]
  assert.deepEqual(sentThinking(build(compacted).body), [])
  // New thinking produced after the compaction binds to the new prefix and replays.
  const request = build(compacted)
  const { events, signatures } = responseEvents({ thinking: ['after compaction'], text: 'Continuing.', tool: { id: 'toolu_9', input: '{}' } })
  compacted.push(respond(request.binding, events), toolResult('toolu_9', 'ok'))
  assert.deepEqual(sentThinking(build(compacted).body), signatures)
})

test('a stored response whose own content changed is not replayed', () => {
  const { history, signatures } = toolLoop(3)
  const edited = structuredClone(history)
  // Rewrite the text of the newest assistant response (index 5).
  const content = edited[5]!.content as { type: string; text?: string }[]
  const text = content.find(block => block.type === 'text')!
  text.text = 'Running something else.'
  // That response's thinking is dropped; the run before it is unaffected.
  assert.deepEqual(sentThinking(build(edited).body), [signatures[0]![0], signatures[1]![0]])
})

// --- the unbroken run --------------------------------------------------------

test('an unsigned block ends the run: only the blocks after it are replayed', () => {
  const { history, signatures } = toolLoop(4)
  // Strip the signature of step 1 (an interrupted or older entry).
  const gapped = structuredClone(history)
  const source = gapped[3]!.source as { replayState?: unknown }
  delete source.replayState
  // The newest valid run that ends at the newest block: steps 2 and 3 only.
  assert.deepEqual(sentThinking(build(gapped).body), [signatures[2]![0], signatures[3]![0]])
})

test('new thinking produced while an old block was left out is never followed by that old block again', () => {
  const { history, signatures } = toolLoop(2)
  // Leave out step 1's thinking for one request: drop its replay state.
  const withoutNewest = structuredClone(history)
  const kept = withoutNewest[3]!.source as { replayState?: unknown }
  const savedState = kept.replayState
  delete kept.replayState
  const request = build(withoutNewest)
  assert.deepEqual(sentThinking(request.body), [signatures[0]![0]])
  const { events, signatures: fresh } = responseEvents({ thinking: ['step 2 after a gap'], text: 'Next.', tool: { id: 'toolu_2', input: '{}' } })
  withoutNewest.push(respond(request.binding, events), toolResult('toolu_2', 'ok'))
  // Put the left-out block back: the new block follows step 0, not step 1.
  kept.replayState = savedState
  const restored = sentThinking(build(withoutNewest).body)
  assert.deepEqual(restored, [signatures[0]![0], fresh[0]], 'step 1 stays out; step 2 follows step 0')
})

test('several thinking blocks in one response replay together, in order', () => {
  const request = build([user('q')])
  const { events, signatures } = responseEvents({ thinking: ['first thought', 'second thought'], text: 'Done.', tool: { id: 'toolu_1', input: '{}' } })
  const history = [user('q'), respond(request.binding, events), toolResult('toolu_1', 'ok')]
  assert.deepEqual(sentThinking(build(history).body), signatures)
})

test('redacted thinking goes back verbatim and takes part in the run', () => {
  const request = build([user('q')])
  const { events } = responseEvents({ redacted: 'ENCRYPTED', text: 'Done.', tool: { id: 'toolu_9', input: '{}' } })
  const history = [user('q'), respond(request.binding, events), toolResult('toolu_9', 'ok')]
  const body = build(history).body
  assert.deepEqual(wireOf(body)[1]!.content[0], { type: 'redacted_thinking', data: 'ENCRYPTED' })
  // A changed prefix drops it like any other thinking block.
  assert.deepEqual(sentThinking(build(history, { system: 'changed' }).body), [])
})

// --- isolation and legacy ----------------------------------------------------

test('thinking from another model or route is never sent', () => {
  const { history } = toolLoop(2)
  for (const shape of [{ model: 'claude-sonnet-5-5' }, { provider: 'antigravity' }] satisfies Shape[]) {
    const body = build(history, shape).body
    assert.deepEqual(sentThinking(body), [], JSON.stringify(shape))
    assert.ok(wireOf(body).flatMap(message => message.content).some(block => block.type === 'tool_use'))
  }
})

test('history from earlier builds (no binding) and foreign envelopes replay nothing', () => {
  const legacy: Message = {
    id: MessageId('legacy'), role: 'assistant',
    content: [{ type: 'reasoning', text: 'old' }, { type: 'text', text: 'answer' }],
    source: { kind: 'model', provider: 'claude', model: MODEL, replayState: { response: { kind: 'anthropic', version: 1 }, blocks: [{ signature: 's' }, {}] } },
  }
  const foreign: Message = {
    ...legacy, id: MessageId('foreign'),
    source: { kind: 'model', provider: 'claude', model: MODEL, replayState: { response: { kind: 'antigravity', version: 1 }, blocks: [{ signature: 's' }, {}] } },
  }
  const misaligned: Message = {
    ...legacy, id: MessageId('misaligned'),
    source: { kind: 'model', provider: 'claude', model: MODEL, replayState: { response: { kind: 'anthropic', version: 2, prefix: 'x', prev: null }, blocks: [{ signature: 's' }] } },
  }
  for (const message of [legacy, foreign, misaligned]) {
    assert.deepEqual(sentThinking(build([user('q'), message, user('more')]).body), [])
  }
  // Without a replay context (direct translator use) nothing is replayed either.
  const { history } = toolLoop(1)
  assert.equal(toAnthropicMessages(history as TranslatableMessage[]).flatMap(message => message.content).some(block => block.type === 'thinking'), false)
})

// --- refusal fallback --------------------------------------------------------

test('after a refused replay, the response records the reset and older thinking is never resent', () => {
  const { history, signatures } = toolLoop(3)
  // The fallback request sends no thinking and binds its response as a reset.
  const fallback = build(history, {}, false)
  assert.deepEqual(sentThinking(fallback.body), [])
  assert.equal(fallback.binding.reset, true)
  const { events, signatures: fresh } = responseEvents({ thinking: ['after the refusal'], text: 'Next.', tool: { id: 'toolu_7', input: '{}' } })
  history.push(respond(fallback.binding, events), toolResult('toolu_7', 'ok'))
  // From now on only thinking produced after the refusal goes back.
  assert.deepEqual(sentThinking(build(history).body), fresh)
  assert.equal(signatures.length, 3)
  // A reset response without thinking of its own still records the reset.
  const quiet = toolLoop(2)
  const quietFallback = build(quiet.history, {}, false)
  quiet.history.push(respond(quietFallback.binding, responseEvents({ text: 'plain' }).events))
  const quietSource = quiet.history.at(-1)!.source
  assert.ok(quietSource.kind === 'model' && quietSource.replayState !== undefined, 'the reset is recorded')
  assert.deepEqual(sentThinking(build(quiet.history).body), [])
})

test('isRefusedThinkingError recognises signature and prefix refusals only', () => {
  const refusal = (message: string, status = 400) => new LlmError(message, `HTTP_${status}`, { status })
  assert.equal(isRefusedThinkingError(refusal('claude API error (HTTP 400): {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}')), true)
  assert.equal(isRefusedThinkingError(refusal('claude API error (HTTP 400): messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.')), true)
  assert.equal(isRefusedThinkingError(refusal('claude API error (HTTP 400): messages.1.content.0: Invalid `data` in `redacted_thinking` block')), true)
  assert.equal(isRefusedThinkingError(refusal('claude API error (HTTP 400): prompt is too long')), false)
  assert.equal(isRefusedThinkingError(refusal('Invalid `signature` in `thinking` block', 500)), false)
})

// --- block_binding -----------------------------------------------------------

test('block_binding drop_block rides only on adaptive thinking for models that run the prefix check', () => {
  assert.deepEqual(withThinkingBinding('claude-opus-5-5', ADAPTIVE), { ...ADAPTIVE, block_binding: { prefix_mismatch_behavior: 'drop_block' } })
  assert.deepEqual(withThinkingBinding('claude-fable-5-1', ADAPTIVE)?.block_binding, { prefix_mismatch_behavior: 'drop_block' })
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
    assert.equal(checksThinkingPrefix(model), false, model)
    assert.deepEqual(withThinkingBinding(model, ADAPTIVE), ADAPTIVE)
  }
  const enabled = { type: 'enabled', budget_tokens: 2048, display: 'summarized' }
  assert.deepEqual(withThinkingBinding('claude-opus-5-5', enabled), enabled)
  assert.equal(withThinkingBinding('claude-opus-5-5', undefined), undefined)
})

// --- cache marks -------------------------------------------------------------

test('cache marks never land on a thinking block', () => {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'redacted_thinking', data: 'd' }] },
  ]
  markMessageCache(messages)
  assert.equal(messages[1]!.content.some(block => block.cache_control !== undefined), false)
  assert.deepEqual(messages[0]!.content[0]!.cache_control, { type: 'ephemeral' })
  const long: AnthropicMessage[] = []
  for (let step = 0; step < 30; step++) {
    long.push({ role: 'assistant', content: [{ type: 'thinking', thinking: `t${step}`, signature: `s${step}` }, { type: 'tool_use', id: `toolu_${step}`, name: 'bash', input: {} }] })
    long.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${step}`, content: 'ok' }] })
  }
  markMessageCache(long)
  const marked = long.flatMap(message => message.content).filter(block => block.cache_control !== undefined)
  assert.equal(marked.length, 3)
  assert.equal(marked.some(block => block.type === 'thinking' || block.type === 'redacted_thinking'), false)
})

// --- through the real adapter and the host runtime ---------------------------

/**
 * End to end through LlmRuntime + AccountPreferencesAdapter (independent route
 * and pool): a step's signature reaches the next request for the same account
 * only, and a changed system prompt drops it.
 */
for (const mode of ['independent', 'pool'] as const) test(`${mode} route: signed thinking round-trips to the same account, model and prefix only`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-thinking-'))
  let wire: AnthropicMessage[] = []
  let produced: string[] = []
  class Raw extends LlmAdapter {
    listOwnModels = async (provider: string) => [{ provider, id: MODEL, name: MODEL }]
    resolveOwnModel = async (provider: string, id: string) => ({ provider, id, name: id })
    clearAccountCatalog() {}
    async *stream(): AsyncIterable<StreamChunk> { throw new Error('use account seam') }
    async *streamAccount(request: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
      const built = claudeRequest(request, request.messages as TranslatableMessage[], 32_000, ADAPTIVE)
      wire = built.body.messages as AnthropicMessage[]
      const { events, signatures } = responseEvents({ thinking: [`thought of ${account}`], text: 'Listing.', tool: { id: `toolu_${account}`, input: '{"cmd":"ls"}' } })
      produced = signatures
      const translator = new AnthropicStreamTranslator(built.binding)
      for (const event of events) yield* translator.push(event)
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
  const thinkingSent = () => wire.flatMap(message => message.content).filter(block => block.type === 'thinking').map(block => block.signature)
  try {
    const content: Message['content'][number][] = []
    let replayState: ReplayEnvelope | undefined
    for await (const chunk of llm.stream({ provider: 'claude', model: selected, messages: [user('list')], system: 'sys', tools: TOOLS })) {
      if (chunk.type === 'block-end') content.push(chunk.block)
      if (chunk.type === 'finish') replayState = chunk.replayState
    }
    assert.ok(replayState, 'the finish chunk carries the thinking envelope')
    const firstSignature = produced[0]
    const history: Message[] = [
      user('list'),
      { role: 'assistant', id: MessageId('signed'), source: { kind: 'model', provider: 'claude', model: selected, replayState: structuredClone(replayState) }, content },
      toolResult('toolu_a', 'a.py'),
    ]
    for await (const _ of llm.stream({ provider: 'claude', model: selected, messages: history, system: 'sys', tools: TOOLS })) { /* drain */ }
    assert.deepEqual(thinkingSent(), [firstSignature], 'same account, model and prefix: replayed')

    for await (const _ of llm.stream({ provider: 'claude', model: selected, messages: history, system: 'changed sys', tools: TOOLS })) { /* drain */ }
    assert.deepEqual(thinkingSent(), [], 'changed system prompt: not replayed')

    member = 'b'; pool.invalidate()
    const next = mode === 'pool' ? 'tier' : accountModelId('b', MODEL)
    for await (const _ of llm.stream({ provider: 'claude', model: next, messages: history, system: 'sys', tools: TOOLS })) { /* drain */ }
    assert.deepEqual(thinkingSent(), [], 'another account must not receive this signature')
    assert.ok(wire.flatMap(message => message.content).some(block => block.type === 'tool_use'), 'the rest of the turn still replays')
  } finally { dispose(); await rm(dir, { recursive: true, force: true }) }
})
