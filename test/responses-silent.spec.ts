import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ResponsesStreamTranslator, streamResponses } from '../src/translate/responses.js'
import type { ResponsesStreamEvent } from '../src/translate/responses.js'
import { CopilotResponsesItemNormalizer } from '../src/providers/copilot.js'

type Item = NonNullable<ResponsesStreamEvent['item']>
const message = (text = '', id = 'message'): Item => ({
  type: 'message', id, status: 'completed', content: [{ type: 'output_text', text }],
})
const call = (callId = 'call-1', id = 'item-1'): Item => ({
  type: 'function_call', id, call_id: callId, name: 'channel_send', arguments: '{"body":"OK"}',
})
const done = (item: Item): ResponsesStreamEvent => ({ type: 'response.output_item.done', item })
const added = (item: Item): ResponsesStreamEvent => ({ type: 'response.output_item.added', item })
const completed = (output?: Item[]): ResponsesStreamEvent => ({
  type: 'response.completed', response: {
    status: 'completed', usage: { input_tokens: 2, output_tokens: 1 },
    ...output === undefined ? {} : { output },
  },
})
const delta = (text: string): ResponsesStreamEvent => ({
  type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: text,
})
function drain(events: ResponsesStreamEvent[]): StreamChunk[] {
  const translator = new ResponsesStreamTranslator()
  return events.flatMap(event => translator.push(event))
}
function assemble(chunks: StreamChunk[]) {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler
}
function assertError(chunks: StreamChunk[], code: string) {
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
  assert.equal(finish.reason.failure.code, code)
}
function sse(events: ResponsesStreamEvent[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')))
      controller.close()
    },
  })
}

for (const [name, prefix] of Object.entries({
  'done-only empty text': [],
  'equivalent empty delta': [delta('')],
})) {
  test(`Responses silent completion: ${name}`, () => {
    const chunks = drain([...prefix, done(message()), completed([message()])])
    assert.deepEqual(assemble(chunks).blocks(), [{ type: 'text', text: '' }])
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    assert.equal(chunks.at(-2)?.type, 'usage')
    assert.equal(chunks.filter(c => c.type === 'block-start').length, 1)
  })
}

const malformed: Record<string, Item[]> = {
  'no output': [],
  'message shell': [{ type: 'message', id: 'message', content: [] }],
  'missing text': [{ type: 'message', id: 'message', content: [{ type: 'output_text' }] }],
  'non-string text': [{ type: 'message', id: 'message', content: [{ type: 'output_text', text: null as unknown as string }] }],
  'unknown part': [{ type: 'message', id: 'message', content: [{ type: 'unknown', text: '' }] }],
  'reasoning metadata': [{ type: 'reasoning', id: 'reason', summary: [] }],
}
for (const [name, items] of Object.entries(malformed)) {
  test(`Responses missing output remains error: ${name}`, () => {
    assertError(drain([...items.map(done), completed(items)]), 'EMPTY_RESPONSE')
  })
}

test('Responses terminal-only text recovery remains outside this fix', () => {
  for (const text of ['', 'OK']) assertError(drain([completed([message(text)])]), 'EMPTY_RESPONSE')
})

test('Responses streamed and done-only nonempty messages do not change', () => {
  for (const prefix of [[], [delta('OK')]]) {
    const chunks = drain([...prefix, done(message('OK')), completed([message('OK')])])
    assert.deepEqual(assemble(chunks).blocks(), [{ type: 'text', text: 'OK' }])
    assert.deepEqual(assemble(chunks).finish, { kind: 'stop' })
  }
})

for (const [name, events] of Object.entries({
  'terminal-only mixed call and text': [completed([call(), message()])],
  'empty done then unstreamed terminal call': [done(message()), completed([message(), call()])],
  'done-only call with terminal snapshot': [done(call()), done(message()), completed([call(), message()])],
  'done-only call without terminal snapshot': [done(call()), done(message()), completed()],
  'call declaration without item ID': [done({ ...call(), id: undefined } as unknown as Item), done(message()), completed()],
  'one represented and one missing call': [added(call()), done(call()), completed([call(), call('call-2', 'item-2')])],
  'same number but different call IDs': [added(call()), done(call()), completed([call('other')])],
  'missing call ID': [done(message()), completed([{ type: 'function_call', id: 'unknown' }])],
  'empty call ID': [added(call('')), done(call('')), done(message()), completed([call('')])],
  'arguments delta without call identity': [{ type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{}' }, completed([call()])],
  'arguments done as the only call signal': [{ type: 'response.function_call_arguments.done', item_id: 'missing' }, done(message()), completed()],
  'arguments done without identity': [{ type: 'response.function_call_arguments.done' }, done(message()), completed()],
  'unrepresented arguments done alongside a valid call': [added(call()), done(call()), { type: 'response.function_call_arguments.done', item_id: 'missing' }, completed()],
})) {
  test(`Responses rejects unassembled calls: ${name}`, () => {
    assertError(drain(events), 'MALFORMED_RESPONSE')
  })
}

test('Responses represented and closed tool calls are preserved once', () => {
  const item = call()
  const chunks = drain([added(item), done(item), done(message()), completed([item, message()])])
  const assembled = assemble(chunks)
  assert.equal(assembled.blocks().filter(b => b.type === 'tool-call').length, 1)
  assert.deepEqual(assembled.finish, { kind: 'tool-calls' })
})

test('Responses uses stable call IDs through the real Copilot normalizer', async () => {
  const normalizer = new CopilotResponsesItemNormalizer()
  const chunks: StreamChunk[] = []
  const events = [
    { ...added(call('call-1', 'raw-a')), output_index: 0 },
    { type: 'response.function_call_arguments.done', item_id: 'raw-arguments', output_index: 0 },
    { ...done(call('call-1', 'raw-b')), output_index: 0 },
    { ...done(message('', 'raw-c')), output_index: 1 },
    completed([call('call-1', 'raw-terminal'), message('', 'raw-terminal-message')]),
  ]
  for await (const chunk of streamResponses(sse(events), undefined, e => normalizer.push(e))) chunks.push(chunk)
  const assembled = assemble(chunks)
  assert.equal(assembled.blocks().filter(b => b.type === 'tool-call').length, 1)
  assert.equal(assembled.blocks().filter(b => b.type === 'text').length, 1)
  assert.deepEqual(assembled.finish, { kind: 'tool-calls' })
})

test('Responses explicit silent SSE completes once without extra chunks', async () => {
  const chunks: StreamChunk[] = []
  for await (const chunk of streamResponses(sse([done(message()), completed([message()]), delta('late')]))) chunks.push(chunk)
  assert.deepEqual(assemble(chunks).blocks(), [{ type: 'text', text: '' }])
  assert.deepEqual(assemble(chunks).finish, { kind: 'stop' })
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
})

test('Responses silent item still requires completed SSE event', async () => {
  await assert.rejects(async () => {
    for await (const _ of streamResponses(sse([done(message())]))) { /* drain */ }
  }, (error: unknown) => error instanceof LlmError && error.code === 'STREAM_CLOSED')
})

test('Responses failed and incomplete remain failures after silent item', () => {
  for (const type of ['response.failed', 'response.incomplete']) {
    const translator = new ResponsesStreamTranslator()
    translator.push(done(message()))
    assert.throws(() => translator.push({ type, response: { error: { message: 'failure' } } }), /failure/)
  }
})
