/**
 * Pure-function tests for the chat completions wire translator (Copilot
 * provider): request assembly (harness messages → chat messages/tools) and
 * the push-model SSE state machine (parsed chunks → StreamChunk sequences).
 * No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallId, LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ChatCompletionsStreamTranslator,
  mapChatCompletionsUsage,
  streamChatCompletions,
  toChatMessages,
  toChatTools,
} from '../src/translate/chat-completions.js'
import type { ChatCompletionsStreamEvent } from '../src/translate/chat-completions.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

let messageCounter = 0

/** Build a bare message without touching the frozen constructors. */
function message(
  role: Message['role'],
  content: ContentBlock[],
  source?: MessageSource,
): Message {
  const resolvedSource = source ?? (role === 'assistant'
    ? { kind: 'model' as const, provider: 'copilot', model: 'gpt-4.1' }
    : { kind: 'user' as const })
  return { id: MessageId(`m-${++messageCounter}`), role, content, source: resolvedSource }
}

function toolCall(id: string, name: string, args: string): ContentBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: args }
}

function toolResult(callId: string, text: string): ContentBlock {
  return {
    type: 'tool-result',
    toolCallId: ToolCallId(callId),
    content: [{ type: 'text', text }],
  }
}

/** Feed every event through a translator and flatten the chunks. */
function drain(translator: ChatCompletionsStreamTranslator, events: ChatCompletionsStreamEvent[]): StreamChunk[] {
  return events.flatMap(event => translator.push(event))
}

test('toChatMessages: text, tool call, and tool result round trip', () => {
  const messages = toChatMessages([
    message('user', [{ type: 'text', text: 'list files' }]),
    message('assistant', [
      { type: 'text', text: 'running ls' },
      toolCall('call-1', 'bash', '{"cmd":"ls"}'),
    ]),
    message('user', [toolResult('call-1', 'file-a\nfile-b')], { kind: 'tool', callId: ToolCallId('call-1') }),
  ], 'be helpful')

  assert.deepEqual(messages, [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: 'running ls',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'file-a\nfile-b' },
  ])
})

test('toChatMessages: system-role messages become a system message unless options.system wins', () => {
  const systemMessage = message('system', [{ type: 'text', text: 'from history' }])
  const fromMessages = toChatMessages([systemMessage])
  assert.deepEqual(fromMessages, [{ role: 'system', content: 'from history' }])
  const fromOptions = toChatMessages([systemMessage], 'explicit')
  assert.deepEqual(fromOptions, [{ role: 'system', content: 'explicit' }])
})

test('toChatMessages: resolved images become image_url parts, text first', () => {
  // The adapter resolves attachment refs to inline base64 BEFORE translation,
  // so the translator sees ResolvedImageParts (not harness ImageBlocks).
  const resolved: TranslatableMessage[] = [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'aGVsbG8=' },
    ],
  }]
  const messages = toChatMessages(resolved)
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ],
  }])
})

test('toChatMessages: an assistant message with only tool calls keeps empty content', () => {
  const messages = toChatMessages([
    message('assistant', [toolCall('call-9', 'bash', '{}')]),
  ])
  assert.deepEqual(messages, [{
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call-9', type: 'function', function: { name: 'bash', arguments: '{}' } }],
  }])
})

test('toChatTools maps schemas to function tools', () => {
  const tools = toChatTools([{
    name: 'bash',
    description: 'run a command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  }])
  assert.deepEqual(tools, [{
    type: 'function',
    function: {
      name: 'bash',
      description: 'run a command',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
    },
  }])
})

test('mapChatCompletionsUsage subtracts cached input and reports reasoning output', () => {
  assert.deepEqual(mapChatCompletionsUsage({
    prompt_tokens: 100,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 30 },
    completion_tokens_details: { reasoning_tokens: 10 },
  }), { inputTokens: 70, outputTokens: 40, cacheReadTokens: 30, reasoningTokens: 10 })
})

test('translator: text deltas, finish armed, usage chunk emits usage then finish', () => {
  const translator = new ChatCompletionsStreamTranslator()
  const chunks = drain(translator, [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
  ])
  // The finish only arms; the usage-only chunk drains usage before finish.
  assert.equal(translator.terminated, false)
  const terminal = translator.push({
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })
  assert.deepEqual(terminal, [
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(translator.terminated, true)
})

test('translator: tool call fragments assemble into one tool-call block', () => {
  const translator = new ChatCompletionsStreamTranslator()
  const chunks = drain(translator, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'bash', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const terminal = translator.flush()
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), name: 'bash', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), argumentsDelta: '{"cmd"' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), argumentsDelta: ':"ls"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{"cmd":"ls"}' } },
  ])
  assert.deepEqual(terminal, [{ type: 'finish', reason: { kind: 'tool-calls' } }])
})

test('translator: reasoning_content becomes a reasoning block', () => {
  const translator = new ChatCompletionsStreamTranslator()
  const chunks = drain(translator, [
    { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking…' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } },
  ])
})

test('translator: Copilot Gemini streams (usage on every chunk) keep their deltas', () => {
  // Regression: Copilot's Gemini models attach a zero `usage` object to every
  // chunk and stream thinking as `reasoning_text`; the real usage rides the
  // finish chunk itself. The old early-return on usage-bearing chunks
  // swallowed every delta, leaving an empty response with usage only.
  const translator = new ChatCompletionsStreamTranslator()
  const mid = drain(translator, [
    {
      choices: [{ index: 0, delta: { content: null, role: 'assistant', reasoning_text: 'greeting…' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    },
    {
      choices: [{ index: 0, delta: { content: 'Hello, how are you today?', role: 'assistant' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    },
  ])
  // The mid-stream zero-usage chunks emit no usage of their own.
  assert.deepEqual(mid, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'greeting…' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Hello, how are you today?' },
  ])
  assert.equal(translator.terminated, false)
  // The finish chunk carries finish_reason AND the real usage together.
  const terminal = translator.push({
    choices: [{ index: 0, delta: { content: null, role: 'assistant' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 4 },
    },
  })
  assert.deepEqual(terminal, [
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'greeting…' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello, how are you today?' } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 7, cacheReadTokens: 0, reasoningTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(translator.terminated, true)
})

test('translator: a finish chunk without usage still arms until flush', () => {
  const translator = new ChatCompletionsStreamTranslator()
  drain(translator, [
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ])
  // No usage anywhere: [DONE] (flush) releases the finish alone.
  assert.deepEqual(translator.flush(), [{ type: 'finish', reason: { kind: 'stop' } }])
})

test('translator: finish reasons map to harness kinds', () => {
  const length = new ChatCompletionsStreamTranslator()
  drain(length, [
    { choices: [{ delta: { content: 'x' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ])
  assert.deepEqual(length.flush(), [{ type: 'finish', reason: { kind: 'max-tokens' } }])

  const filtered = new ChatCompletionsStreamTranslator()
  drain(filtered, [
    { choices: [{ delta: { content: 'x' } }] },
    { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
  ])
  assert.deepEqual(filtered.flush(), [{
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'the response was blocked by the provider content filter', code: 'CONTENT_FILTER' },
    },
  }])
})

test('translator: an empty completion finishes with an error', () => {
  const translator = new ChatCompletionsStreamTranslator()
  drain(translator, [{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
  const [finish] = translator.flush()
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
})

/** A readable byte stream of one string per chunk. */
function byteStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

/** One SSE data frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

test('streamChatCompletions consumes an SSE stream through [DONE]', async () => {
  const stream = byteStream([
    frame({ choices: [{ delta: { content: 'hi' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    'data: [DONE]\n\n',
  ])
  const chunks: StreamChunk[] = []
  for await (const chunk of streamChatCompletions(stream)) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'text-delta', 'block-end', 'usage', 'finish',
  ])
})

test('streamChatCompletions: a Copilot Gemini SSE stream yields text and terminates', async () => {
  // Raw shape captured from api.githubcopilot.com with gemini-3.5-flash:
  // every data frame carries a (zero) usage object; the terminal frame folds
  // the real usage into the finish chunk; [DONE] follows.
  const stream = byteStream([
    frame({
      choices: [{ index: 0, delta: { content: null, role: 'assistant', reasoning_text: 'greeting…' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    }),
    frame({
      choices: [{ index: 0, delta: { content: 'Hello, how are you today?', role: 'assistant' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    }),
    frame({
      choices: [{ index: 0, delta: { content: null, role: 'assistant' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 7 },
    }),
    'data: [DONE]\n\n',
  ])
  const chunks: StreamChunk[] = []
  for await (const chunk of streamChatCompletions(stream)) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'reasoning-delta', 'block-start', 'text-delta',
    'block-end', 'block-end', 'usage', 'finish',
  ])
  const text = chunks.find(chunk => chunk.type === 'text-delta')
  assert.equal(text?.type === 'text-delta' ? text.text : undefined, 'Hello, how are you today?')
})

test('streamChatCompletions: a stream without a finish chunk throws STREAM_CLOSED', async () => {
  const stream = byteStream([frame({ choices: [{ delta: { content: 'hi' } }] })])
  await assert.rejects(async () => {
    for await (const chunk of streamChatCompletions(stream)) void chunk
  }, (error: unknown) => error instanceof LlmError && error.code === 'STREAM_CLOSED')
})

test('streamChatCompletions: malformed payload throws MALFORMED_RESPONSE', async () => {
  const stream = byteStream(['data: {not json\n\n'])
  await assert.rejects(async () => {
    for await (const chunk of streamChatCompletions(stream)) void chunk
  }, (error: unknown) => error instanceof LlmError && error.code === 'MALFORMED_RESPONSE')
})
