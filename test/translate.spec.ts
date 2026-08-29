/**
 * Pure-function tests for the wire translators: request assembly (harness
 * messages → Responses input / Anthropic messages) and the push-model SSE
 * state machines (parsed events → StreamChunk sequences). No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallId, LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ResponsesStreamTranslator,
  toResponsesInput,
  toResponsesTools,
} from '../src/translate/responses.js'
import type { ReasoningReplayItem, ResponsesStreamEvent } from '../src/translate/responses.js'
import {
  AnthropicStreamTranslator,
  CLAUDE_CODE_IDENTITY,
  markMessageCache,
  toAnthropicMessages,
  toAnthropicSystem,
  toAnthropicTools,
} from '../src/translate/anthropic.js'
import type { AnthropicMessage, AnthropicStreamEvent } from '../src/translate/anthropic.js'
import { resolveImages } from '../src/translate/resolved.js'

let messageCounter = 0

/** Build a bare message without touching the frozen constructors. */
function message(
  role: Message['role'],
  content: ContentBlock[],
  source?: MessageSource,
): Message {
  const resolvedSource = source ?? (role === 'assistant'
    ? { kind: 'model' as const, provider: 'codex', model: 'gpt-5.1-codex' }
    : { kind: 'user' as const })
  return { id: MessageId(`m-${++messageCounter}`), role, content, source: resolvedSource }
}

function toolCall(id: string, name: string, args: string): ContentBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: args }
}

function toolResult(callId: string, text: string, isError?: boolean): ContentBlock {
  return {
    type: 'tool-result',
    toolCallId: ToolCallId(callId),
    content: [{ type: 'text', text }],
    ...isError === undefined ? {} : { isError },
  }
}

/** Feed every event through a translator and flatten the chunks. */
function drain<T>(translator: { push(event: T): StreamChunk[] }, events: T[]): StreamChunk[] {
  return events.flatMap(event => translator.push(event))
}

test('toResponsesInput: text, tool call, and tool result round trip', () => {
  const { instructions, input } = toResponsesInput([
    message('user', [{ type: 'text', text: 'list files' }]),
    message('assistant', [
      { type: 'text', text: 'running ls' },
      toolCall('call-1', 'bash', '{"cmd":"ls"}'),
    ]),
    message('user', [toolResult('call-1', 'file-a\nfile-b')], { kind: 'tool', callId: ToolCallId('call-1') }),
  ], 'be helpful')

  assert.equal(instructions, 'be helpful')
  assert.deepEqual(input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'running ls' }] },
    { type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'file-a\nfile-b' },
  ])
})

test('toResponsesInput: system-role messages become instructions unless options.system wins', () => {
  const systemMessage = message('system', [{ type: 'text', text: 'from history' }])
  const fromMessages = toResponsesInput([systemMessage])
  assert.equal(fromMessages.instructions, 'from history')
  assert.deepEqual(fromMessages.input, [])
  const explicit = toResponsesInput([systemMessage], 'explicit system')
  assert.equal(explicit.instructions, 'explicit system')
})

test('toResponsesInput: reasoningFor replays completed reasoning items ahead of the tool call', () => {
  const messages = () => [
    message('user', [{ type: 'text', text: 'go' }]),
    message('assistant', [
      toolCall('call-1', 'bash', '{}'),
      toolCall('call-2', 'grep', '{}'),
    ]),
  ]
  // The replay shape is the COMPLETE reasoning item: the Responses input
  // schema does not treat a reasoning item's id or summary as optional.
  const item = (id: string, enc: string): ReasoningReplayItem => ({
    type: 'reasoning',
    id,
    summary: [{ type: 'summary_text', text: 'thought' }],
    status: 'completed',
    encrypted_content: enc,
  })
  // Parallel calls of one response share ONE array instance → replay once,
  // before the first call.
  const shared = [item('rs_1', 'ENC1'), item('rs_2', 'ENC2')]
  assert.deepEqual(toResponsesInput(messages(), undefined, () => shared).input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought' }], status: 'completed', encrypted_content: 'ENC1' },
    { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'thought' }], status: 'completed', encrypted_content: 'ENC2' },
    { type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '{}' },
    { type: 'function_call', call_id: 'call-2', name: 'grep', arguments: '{}' },
  ])
  // Distinct arrays per call → each replays ahead of its own call.
  const byCall: Record<string, ReasoningReplayItem[]> = {
    'call-1': [item('rs_1', 'E1')],
    'call-2': [item('rs_2', 'E2')],
  }
  assert.deepEqual(toResponsesInput(messages(), undefined, callId => byCall[callId]).input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought' }], status: 'completed', encrypted_content: 'E1' },
    { type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '{}' },
    { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'thought' }], status: 'completed', encrypted_content: 'E2' },
    { type: 'function_call', call_id: 'call-2', name: 'grep', arguments: '{}' },
  ])
  // Items captured without optional fields replay with just the required ones.
  const minimal: ReasoningReplayItem[] = [{ type: 'reasoning', id: 'rs_3', encrypted_content: 'E3' }]
  assert.deepEqual(
    toResponsesInput(
      [message('assistant', [toolCall('call-x', 'bash', '{}')])],
      undefined,
      () => minimal,
    ).input,
    [
      { type: 'reasoning', id: 'rs_3', encrypted_content: 'E3' },
      { type: 'function_call', call_id: 'call-x', name: 'bash', arguments: '{}' },
    ],
  )
  // An unknown call id injects nothing.
  const toolOnly = [{ type: 'function_call', call_id: 'call-x', name: 'bash', arguments: '{}' }]
  assert.deepEqual(
    toResponsesInput([message('assistant', [toolCall('call-x', 'bash', '{}')])], undefined, () => undefined).input,
    toolOnly,
  )
  // Omitting the callback keeps the pre-replay behavior.
  assert.deepEqual(toResponsesInput([message('assistant', [toolCall('call-x', 'bash', '{}')])]).input, toolOnly)
})

test('toResponsesTools maps to Responses function tools', () => {
  assert.deepEqual(toResponsesTools([{ name: 'bash', description: 'run', parameters: { type: 'object' } }]), [
    { type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' } },
  ])
})

test('toResponsesInput: resolved image parts become input_image data URLs', () => {
  const { input } = toResponsesInput([{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' },
    ],
  }])
  assert.deepEqual(input, [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,aGk=' },
    ],
  }])
  // An unresolved ImageBlock (attachment reference only) is skipped.
  const unresolved = toResponsesInput([{
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'x' } } as never],
  }])
  assert.deepEqual(unresolved.input, [])
})

test('resolveImages: passthrough, loud failure without attachments, and resolution', async () => {
  const plain = [message('user', [{ type: 'text', text: 'hi' }])]
  assert.equal(await resolveImages(plain, undefined), plain, 'no images → same array, no service needed')

  const withImage = [message('user', [{
    type: 'image',
    attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
  } as never])]
  await assert.rejects(
    () => resolveImages(withImage, undefined),
    (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED',
  )

  const attachments = {
    readImage: (ref: unknown) => Promise.resolve({ ref, data: new Uint8Array([104, 105]) }),
  } as never
  const resolved = await resolveImages(withImage, attachments)
  assert.deepEqual(resolved[0].content, [{ type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' }])
})

test('Responses translator: text + tool call stream yields usage before finish', () => {
  const events: ResponsesStreamEvent[] = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg-1' } },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'lo' },
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'bash' },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-1', delta: '{"cmd":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-1', delta: '"ls"}' },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' },
    },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg-1' } },
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    },
  ]
  const chunks = drain(new ResponsesStreamTranslator(), events)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'bash', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'bash', argumentsDelta: '{"cmd":' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'bash', argumentsDelta: '"ls"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { inputTokens: 70, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('Responses translator: plain text completion finishes with stop', () => {
  const chunks = drain(new ResponsesStreamTranslator(), [
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'hi' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } },
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('Responses translator: empty completion is an EMPTY_RESPONSE error finish', () => {
  const chunks = drain(new ResponsesStreamTranslator(), [
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 0 } } },
  ])
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
    },
  })
  const usageIndex = chunks.findIndex(chunk => chunk.type === 'usage')
  assert.ok(usageIndex >= 0 && usageIndex < chunks.length - 1, 'usage comes before finish')
})

test('Responses translator: response.failed maps context overflow and quota', () => {
  const overflow = new ResponsesStreamTranslator()
  assert.throws(
    () => overflow.push({ type: 'response.failed', response: { error: { code: 'context_window_exceeded', message: 'too long' } } }),
    (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
  const quota = new ResponsesStreamTranslator()
  assert.throws(
    () => quota.push({ type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'out of credits' } } }),
    (error: unknown) => error instanceof LlmError && error.code === 'QUOTA',
  )
  const generic = new ResponsesStreamTranslator()
  assert.throws(
    () => generic.push({ type: 'error', code: 'server_error', message: 'boom' }),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER',
  )
})

test('toAnthropicMessages: merge, tool_use input parsing, tool_result', () => {
  const messages = toAnthropicMessages([
    message('system', [{ type: 'text', text: 'system text' }]),
    message('user', [{ type: 'text', text: 'first' }]),
    message('user', [
      { type: 'text', text: 'second' },
      toolResult('call-1', 'result text', true),
    ]),
    message('assistant', [
      { type: 'text', text: 'calling' },
      toolCall('call-1', 'bash', '{"cmd":"ls"}'),
    ]),
  ])
  assert.deepEqual(messages, [
    {
      // The merged user message leads with its tool result; the texts keep
      // their relative order behind it.
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'result text', is_error: true },
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'call-1', name: 'bash', input: { cmd: 'ls' } },
      ],
    },
  ])

  // Malformed tool-call JSON degrades to an empty object, never a crash.
  const malformed = toAnthropicMessages([
    message('assistant', [toolCall('c', 'n', '{bad')]),
  ])
  assert.deepEqual(malformed[0].content[0], { type: 'tool_use', id: 'c', name: 'n', input: {} })
})

test('toAnthropicMessages: a replayed tool call in a user message rides as text', () => {
  // A settled background subagent's closing message is spliced into the parent
  // conversation as a user-role notice, carrying the subagent's own blocks —
  // including tool calls that never got a result. Anthropic rejects `tool_use`
  // outside assistant messages, so those must not reach the wire as tool_use.
  const messages = toAnthropicMessages([
    message('user', [
      { type: 'text', text: 'Background subagent 7f21c45a failed before it finished.' },
      toolCall('toolu_01MG', 'bash', '{"command":"ls"}'),
    ], { kind: 'user' }),
  ])
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'Background subagent 7f21c45a failed before it finished.' },
      { type: 'text', text: '[tool call bash: {"command":"ls"}]' },
    ],
  }])
  assert.ok(!JSON.stringify(messages).includes('tool_use'))
})

test('toAnthropicMessages: merged user message keeps tool_result blocks in one leading run', () => {
  // A parallel tool batch arrives as one result message per call, so context
  // spliced mid-batch merges in between them. Anthropic answers each tool_use
  // against the blocks leading the next message, so the results must regroup
  // at the front or the request is rejected for an unanswered call.
  const messages = toAnthropicMessages([
    message('assistant', [toolCall('call-1', 'bash', '{}'), toolCall('call-2', 'bash', '{}')]),
    message('user', [toolResult('call-1', 'first')], { kind: 'tool', callId: ToolCallId('call-1') }),
    message('user', [{ type: 'text', text: 'spliced notice' }]),
    message('user', [toolResult('call-2', 'second')], { kind: 'tool', callId: ToolCallId('call-2') }),
  ])
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call-1', content: 'first' },
      { type: 'tool_result', tool_use_id: 'call-2', content: 'second' },
      { type: 'text', text: 'spliced notice' },
    ],
  })

  // A user message with no tool results is left exactly as assembled.
  const plain = toAnthropicMessages([
    message('user', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
  ])
  assert.deepEqual(plain[0].content, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
})

test('toAnthropicMessages: resolved image parts become base64 image blocks', () => {
  const messages = toAnthropicMessages([{
    role: 'user',
    content: [
      { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' },
      { type: 'text', text: 'what is this?' },
    ],
  }])
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
      { type: 'text', text: 'what is this?' },
    ],
  }])
})

test('toAnthropicSystem: Claude Code identity first, then explicit and history system text', () => {  const blocks = toAnthropicSystem('explicit', [message('system', [{ type: 'text', text: 'from history' }])])
  assert.deepEqual(blocks, [
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
    { type: 'text', text: 'explicit' },
    { type: 'text', text: 'from history', cache_control: { type: 'ephemeral' } },
  ])
  assert.equal(toAnthropicSystem().length, 1, 'the identity block is always present')
})

test('toAnthropicSystem hoists only the system messages that precede the conversation', () => {
  const history = [
    message('system', [{ type: 'text', text: 'opening' }]),
    message('user', [{ type: 'text', text: 'hi' }]),
    message('system', [{ type: 'text', text: 'mid-conversation' }]),
  ]
  assert.deepEqual(toAnthropicSystem('explicit', history), [
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
    { type: 'text', text: 'explicit' },
    { type: 'text', text: 'opening', cache_control: { type: 'ephemeral' } },
  ], 'a later system message must not move in front of the cached history')
})

test('toAnthropicMessages: a mid-conversation system message rides in place as a reminder', () => {
  const messages = toAnthropicMessages([
    message('system', [{ type: 'text', text: 'opening' }]),
    message('user', [{ type: 'text', text: 'hi' }]),
    message('assistant', [{ type: 'text', text: 'hello' }]),
    message('system', [{ type: 'text', text: 'terse mode' }]),
  ])
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>terse mode</system-reminder>' }] },
  ])
})

test('toAnthropicSystem marks its last block as the tools+system breakpoint', () => {
  const blocks = toAnthropicSystem('explicit')
  assert.deepEqual(blocks, [
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
    { type: 'text', text: 'explicit', cache_control: { type: 'ephemeral' } },
  ])
})

test('markMessageCache marks the tail and one block every stride backwards', () => {
  const content: Record<string, unknown>[] = Array.from(
    { length: 40 },
    (_, index) => ({ type: 'text', text: `b${index}` }),
  )
  const messages: AnthropicMessage[] = [{ role: 'user', content }]
  markMessageCache(messages)
  const marked = content.flatMap((block, index) => ('cache_control' in block ? [index] : []))
  assert.deepEqual(marked, [9, 24, 39], 'three marks, 15 blocks apart, anchored at the tail')
})

test('markMessageCache marks across messages and stops at the start of a short one', () => {
  const first: Record<string, unknown>[] = [{ type: 'text', text: 'hi' }]
  const second: Record<string, unknown>[] = [{ type: 'text', text: 'hello' }]
  const messages: AnthropicMessage[] = [
    { role: 'user', content: first },
    { role: 'assistant', content: second },
  ]
  markMessageCache(messages)
  assert.deepEqual(first, [{ type: 'text', text: 'hi' }], 'no mark within a stride of the tail')
  assert.deepEqual(second, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }])
})

test('markMessageCache leaves an empty conversation alone', () => {
  assert.doesNotThrow(() => { markMessageCache([]) })
})

test('toAnthropicMessages: a system reminder merged with tool results stays behind the leading run', () => {
  const messages = toAnthropicMessages([
    message('user', [{ type: 'text', text: 'go' }]),
    message('assistant', [toolCall('c1', 'bash', '{}')]),
    message('user', [toolResult('c1', 'ok')]),
    message('system', [{ type: 'text', text: 'terse mode' }]),
  ])
  assert.deepEqual(messages[2].content, [
    { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
    { type: 'text', text: '<system-reminder>terse mode</system-reminder>' },
  ], 'tool_result blocks must still lead the merged message')
})

test('an all-system history hoists everything and leaves no messages', () => {
  const history = [
    message('system', [{ type: 'text', text: 'first' }]),
    message('system', [{ type: 'text', text: 'second' }]),
  ]
  assert.deepEqual(toAnthropicSystem(undefined, history), [
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second', cache_control: { type: 'ephemeral' } },
  ])
  assert.deepEqual(toAnthropicMessages(history), [])
})

test('toAnthropicSystem marks the identity block when it is the only one', () => {
  assert.deepEqual(toAnthropicSystem(), [
    { type: 'text', text: CLAUDE_CODE_IDENTITY, cache_control: { type: 'ephemeral' } },
  ])
})

test('markMessageCache marks a tool_result block when the turn ends on one', () => {
  const content: Record<string, unknown>[] = [
    { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
    { type: 'tool_result', tool_use_id: 'c2', content: 'ok' },
  ]
  markMessageCache([{ role: 'user', content }])
  assert.equal(content[0].cache_control, undefined)
  assert.deepEqual(content[1].cache_control, { type: 'ephemeral' })
})

test('toAnthropicTools maps to input_schema tools', () => {
  assert.deepEqual(toAnthropicTools([{ name: 'bash', description: 'run', parameters: { type: 'object' } }]), [
    { name: 'bash', description: 'run', input_schema: { type: 'object' } },
  ])
})

test('toAnthropicTools sorts by name so the tools prefix survives registration order', () => {
  const schemas = [
    { name: 'write', description: 'write a file', parameters: { type: 'object' } },
    { name: 'bash', description: 'run', parameters: { type: 'object' } },
  ]
  assert.deepEqual(toAnthropicTools(schemas), [
    { name: 'bash', description: 'run', input_schema: { type: 'object' } },
    { name: 'write', description: 'write a file', input_schema: { type: 'object' } },
  ])
  assert.deepEqual(
    toAnthropicTools([...schemas].reverse()),
    toAnthropicTools(schemas),
    'the wire order does not depend on the input order',
  )
})

test('Anthropic translator: text + tool_use stream with usage before finish', () => {
  const events: AnthropicStreamEvent[] = [
    { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu-1', name: 'bash' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]
  const chunks = drain(new AnthropicStreamTranslator(), events)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'toolu-1', name: 'bash', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 1, id: 'toolu-1', name: 'bash', argumentsDelta: '{"cmd":' },
    { type: 'tool-call-delta', index: 1, id: 'toolu-1', name: 'bash', argumentsDelta: '"ls"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'toolu-1', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'usage', usage: { inputTokens: 50, outputTokens: 7, cacheReadTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('Anthropic translator: stop reasons and empty completion', () => {
  const maxed = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(maxed.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })

  const empty = drain(new AnthropicStreamTranslator(), [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ])
  assert.deepEqual(empty.at(-1), {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
    },
  })
  const usageIndex = empty.findIndex(chunk => chunk.type === 'usage')
  assert.ok(usageIndex >= 0 && usageIndex < empty.length - 1, 'usage comes before finish')
})

test('Anthropic translator: error event mapping', () => {
  const tooLong = new AnthropicStreamTranslator()
  assert.throws(
    () => tooLong.push({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
  const rateLimited = new AnthropicStreamTranslator()
  assert.throws(
    () => rateLimited.push({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )
  const overloaded = new AnthropicStreamTranslator()
  assert.throws(
    () => overloaded.push({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER',
  )
  const auth = new AnthropicStreamTranslator()
  assert.throws(
    () => auth.push({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }),
    (error: unknown) => error instanceof LlmError && error.code === 'AUTH',
  )
})
