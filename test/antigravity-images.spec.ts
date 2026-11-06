/** #186: injected upstream, real adapter/pool and host chunk assembly; no credentials. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { AntigravitySession } from '../src/auth/store.js'
import { AntigravityAdapter } from '../src/providers/antigravity.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry, memberKey } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { poolKey } from '../src/providers/pool-family.js'
import { AntigravityStreamTranslator, streamAntigravity, toAntigravityContents } from '../src/translate/antigravity.js'
import type { AntigravityPart, AntigravityResponseEvent } from '../src/translate/antigravity.js'
import { resolveImages } from '../src/translate/resolved.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII='
const IMAGE: AntigravityPart = { inlineData: { mimeType: 'image/png', data: PNG }, thoughtSignature: 'image-signature' }
const OPTIONS: GenerateOptions = { provider: 'antigravity', model: 'gemini-3.1-flash-image', messages: [] }
const USAGE = { promptTokenCount: 10, cachedContentTokenCount: 2, candidatesTokenCount: 7, thoughtsTokenCount: 1 }

/** Fixture store: byte-identical round trips; actual image decoder tested separately in the host check. */
class Store extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024 * 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 2 * 1024 * 1024,
    maxImagePixels: 1000000, maxImageDimension: 1000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  }
  saved: SaveImageAttachment[] = []
  fail = false
  constructor(limits: Partial<ImageAttachmentLimits> = {}) { super(new Context()); Object.assign(this.imageLimits, limits) }
  async validateImage(input: SaveImageAttachment): Promise<void> {
    if (this.fail || input.mediaType !== 'image/png' || !Buffer.from(input.data).equals(Buffer.from(PNG, 'base64'))) {
      throw new Error('fixture rejected corrupt bytes/MIME or simulated write failure')
    }
  }
  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    await this.validateImage(input)
    this.saved.push(input)
    return { attachmentId: AttachmentId(`sha256:${createHash('sha256').update(input.data).digest('hex')}`),
      mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
  }
  async readImage(ref: ImageAttachmentRef) {
    const saved = this.saved.find(input => `sha256:${createHash('sha256').update(input.data).digest('hex')}` === ref.attachmentId)
    assert.ok(saved)
    return { ref, data: saved.data }
  }
}
function frame(parts: AntigravityPart[], finishReason?: string, usage = true): AntigravityResponseEvent {
  return { response: { candidates: [{ content: { parts }, ...finishReason === undefined ? {} : { finishReason } }],
    ...usage ? { usageMetadata: USAGE } : {} } }
}
function bytes(text: string, split = 17) {
  const data = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < data.length; i += split) controller.enqueue(data.slice(i, i + split))
    controller.close()
  } })
}
const sse = (frames: AntigravityResponseEvent[]) => frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
function assemble(chunks: StreamChunk[]) {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler
}
function adapter(frames: AntigravityResponseEvent[], store: Store | undefined, calls: string[] = []) {
  const tokens = new AccountTokenManager<AntigravitySession>({ provider: 'antigravity', displayName: 'fixture',
    makeOptions: () => ({ preemptMs: 0, refresh: async value => value, isPermanent: () => false }),
    io: { list: async () => ['alice', 'bob'].map(key => ({ key, session: { accessToken: key, refreshToken: 'fixture', expiresAt: Date.now() + 3600000, projectId: 'fixture' } })), get: async key => ({ accessToken: key ?? 'alice', refreshToken: 'fixture',
      expiresAt: Date.now() + 3600000, projectId: 'fixture' }), save: async () => {}, remove: async () => {} } })
  return new AntigravityAdapter({ models: [{ id: OPTIONS.model }], discovery: false, tokens,
    streamIdleTimeoutMs: 5000, runtime: { baseURL: 'https://fixture.invalid', onboard: false },
    resolveAttachments: () => store,
    fetchFn: async (url, init) => {
      calls.push(new Headers(init?.headers).get('authorization') ?? '')
      return String(url).includes('streamGenerateContent')
        ? new Response(bytes(sse(frames)), { headers: { 'content-type': 'text/event-stream' } })
        : new Response(JSON.stringify(frames[0]), { headers: { 'content-type': 'application/json' } })
    },
  })
}
for (const transport of ['SSE', 'JSON']) for (const text of [false, true]) {
  test(`${transport}: ${text ? 'text + image + text' : 'image only'} survives adapter and host assembly`, async () => {
    const store = new Store()
    const parts = text ? [{ text: 'before' }, IMAGE, { text: 'after', thoughtSignature: 'after-signature' }] : [IMAGE]
    const raw = adapter([frame(parts, 'STOP')], store)
    const chunks = transport === 'SSE' ? await collect(raw.stream(OPTIONS)) : await raw.generate(OPTIONS)
    const result = assemble(chunks)
    assert.deepEqual(result.blocks().map(block => block.type), text ? ['text', 'image', 'text'] : ['image'])
    assert.equal(result.finish.kind, 'stop')
    assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 7, cacheReadTokens: 2, reasoningTokens: 1 })
    assert.equal(chunks.at(-2)?.type, 'usage')
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
    const saved = JSON.parse(JSON.stringify(result.message({ provider: 'antigravity', model: OPTIONS.model, replayState: result.replayState })))
    const resolved = await resolveImages([saved], store)
    const replay = toAntigravityContents(resolved, OPTIONS.model)[0].parts
    assert.deepEqual(replay, parts)
    const image = result.blocks().find(block => block.type === 'image')
    assert.ok(image?.type === 'image')
    assert.equal(Buffer.from((await store.readImage(image.attachment)).data).toString('base64'), PNG)
    assert.ok(!JSON.stringify(saved).includes(PNG), 'history contains references, never raw image bytes')
  })
}

test('multiple images and interleaved text across SSE frames preserve order, signatures and latest usage', async () => {
  const store = new Store()
  const frames = [frame([{ text: 'a' }, IMAGE]), frame([{ text: 'b' }]), frame([IMAGE, { text: 'c' }]), frame([], 'STOP', false)]
  const chunks = await collect(adapter(frames, store).stream(OPTIONS))
  const result = assemble(chunks)
  assert.deepEqual(result.blocks().map(b => b.type === 'text' ? b.text : b.type), ['a', 'image', 'b', 'image', 'c'])
  assert.deepEqual(result.replayState?.blocks, [{}, { thoughtSignature: 'image-signature' }, {}, { thoughtSignature: 'image-signature' }, {}])
  assert.equal(result.usage?.outputTokens, 7)
  assert.equal(store.saved.length, 2, 'identical images at different positions are not deduplicated away')
  assert.deepEqual(chunks.filter(c => c.type === 'block-start').map(c => c.index), [0, 1, 2, 3, 4])
})

for (const [reason, expected] of [['MAX_TOKENS', 'max-tokens'], ['SAFETY', 'error'], ['RECITATION', 'error'], ['BLOCKLIST', 'error']]) {
  test(`image output preserves ${reason} finish`, async () => {
    const chunks = await adapter([frame([IMAGE], reason)], new Store()).generate(OPTIONS)
    assert.equal(assemble(chunks).finish.kind, expected)
  })
}
test('image followed by a tool call retains tool-calls completion and signed replay', async () => {
  const parts = [IMAGE, { functionCall: { id: 'c', name: 'check', args: {} }, thoughtSignature: 'tool-signature' }]
  const result = assemble(await adapter([frame(parts, 'STOP')], new Store()).generate(OPTIONS))
  assert.deepEqual(result.blocks().map(b => b.type), ['image', 'tool-call'])
  assert.equal(result.finish.kind, 'tool-calls')
  assert.deepEqual(result.replayState?.blocks, [{ thoughtSignature: 'image-signature' }, { thoughtSignature: 'tool-signature' }])
})

const malformed: [string, unknown][] = [
  ['null', null], ['empty', { mimeType: 'image/png', data: '' }],
  ['MIME', { mimeType: 'image/svg+xml', data: PNG }], ['non-image', { mimeType: 'audio/mp3', data: PNG }],
  ['missing MIME', { data: PNG }], ['non-string', { mimeType: 'image/png', data: 123 }],
  ['base64 alphabet', { mimeType: 'image/png', data: '!!!!' }], ['base64 padding', { mimeType: 'image/png', data: 'a===' }],
  ['base64 trailing bits', { mimeType: 'image/png', data: 'Zh==' }],
  ['base64 whitespace', { mimeType: 'image/png', data: PNG + '\n' }],
  ['base64 truncated', { mimeType: 'image/png', data: PNG.slice(0, -1) }],
  ['data URL', { mimeType: 'image/png', data: `data:image/png;base64,${PNG}` }],
]
for (const [name, inlineData] of malformed) for (const transport of ['SSE', 'JSON']) {
  test(`${transport}: rejects ${name} without image emission or success`, async () => {
    const store = new Store()
    const raw = adapter([frame([{ inlineData } as AntigravityPart], 'STOP')], store)
    await assert.rejects(transport === 'SSE' ? collect(raw.stream(OPTIONS)) : raw.generate(OPTIONS), { code: 'INVALID_IMAGE_RESPONSE' })
    assert.equal(store.saved.length, 0)
  })
}
for (const transport of ['SSE', 'JSON']) for (const [name, part] of [
  ['MIME mismatch', { inlineData: { mimeType: 'image/jpeg', data: PNG } }],
  ['truncated raster', { inlineData: { mimeType: 'image/png', data: Buffer.from(PNG, 'base64').subarray(0, 30).toString('base64') } }],
] as const) test(`${transport}: delegates ${name} rejection to attachment store`, async () => {
  const store = new Store()
  const raw = adapter([frame([part], 'STOP')], store)
  await assert.rejects(transport === 'SSE' ? collect(raw.stream(OPTIONS)) : raw.generate(OPTIONS), { code: 'IMAGE_OUTPUT_STORAGE' })
  assert.equal(store.saved.length, 0)
})

for (const limit of [
  { maxImageBytes: Buffer.from(PNG, 'base64').length - 1 },
  { maxImagesPerMessage: 0 }, { maxMessageImageBytes: 1 },
]) test(`enforces admission budget ${JSON.stringify(limit)}`, async () => {
  const store = new Store(limit)
  await assert.rejects(adapter([frame([IMAGE], 'STOP')], store).generate(OPTIONS), { code: 'IMAGE_OUTPUT_LIMIT' })
  assert.equal(store.saved.length, 0)
})
test('accepts exact byte limits', async () => {
  const size = Buffer.from(PNG, 'base64').length
  const result = await adapter([frame([IMAGE], 'STOP')], new Store({ maxImageBytes: size, maxMessageImageBytes: size, maxImagesPerMessage: 1 })).generate(OPTIONS)
  assert.equal(assemble(result).finish.kind, 'stop')
})
for (const limits of [{ maxImagesPerMessage: 1 }, { maxMessageImageBytes: Buffer.from(PNG, 'base64').length * 2 - 1 }]) {
  test(`limits accumulate across frames: ${JSON.stringify(limits)}`, async () => {
    const store = new Store(limits)
    const seen: StreamChunk[] = []
    await assert.rejects(async () => {
      for await (const c of adapter([frame([IMAGE]), frame([IMAGE], 'STOP')], store).stream(OPTIONS)) seen.push(c)
    }, { code: 'IMAGE_OUTPUT_LIMIT' })
    assert.equal(store.saved.length, 1)
    assert.equal(seen.some(c => c.type === 'finish'), false)
  })
}
test('disabled host MIME, missing store, write error and cancellation fail explicitly', async () => {
  await assert.rejects(adapter([frame([IMAGE], 'STOP')], new Store({ mediaTypes: ['image/jpeg'] })).generate(OPTIONS), { code: 'INVALID_IMAGE_RESPONSE' })
  await assert.rejects(adapter([frame([IMAGE], 'STOP')], undefined).generate(OPTIONS), { code: 'UNSUPPORTED' })
  const store = new Store(); store.fail = true
  await assert.rejects(adapter([frame([IMAGE], 'STOP')], store).generate(OPTIONS), { code: 'IMAGE_OUTPUT_STORAGE' })
  const abort = new AbortController(); abort.abort()
  await assert.rejects(new AntigravityStreamTranslator(new Store(), abort.signal).push(frame([IMAGE], 'STOP')), { name: 'AbortError' })
})
for (const suffix of ['', 'data: [DONE]\n\n', 'data: {"response":']) {
  test(`SSE truncated before finish is never a successful pure image (${suffix})`, async () => {
    const seen: StreamChunk[] = []
    await assert.rejects(async () => {
      for await (const c of streamAntigravity(bytes(sse([frame([IMAGE])]) + suffix), undefined, new Store())) seen.push(c)
    }, { code: 'STREAM_CLOSED' })
    assert.equal(seen.some(c => c.type === 'finish'), false)
  })
}
test('unterminated image frame and malformed JSON cannot emit an image', async () => {
  const store = new Store()
  await assert.rejects(collect(streamAntigravity(bytes(sse([frame([IMAGE], 'STOP')]).trimEnd()), undefined, store)), { code: 'STREAM_CLOSED' })
  await assert.rejects(collect(streamAntigravity(bytes('data: {broken\n\n'), undefined, store)), { code: 'MALFORMED_RESPONSE' })
  assert.equal(store.saved.length, 0)
  await assert.rejects(adapter([frame([IMAGE])], store).generate(OPTIONS), { code: 'STREAM_CLOSED' })
})
test('terminated translator ignores subsequent frames', async () => {
  const store = new Store()
  const translator = new AntigravityStreamTranslator(store)
  await translator.push(frame([IMAGE], 'STOP'))
  assert.deepEqual(await translator.push(frame([IMAGE], 'STOP')), [])
  assert.equal(store.saved.length, 1)
})

for (const mode of ['success', 'empty', 'missing-store', 'invalid', 'storage'] as const) {
  test(`real PoolAdapter isolates ${mode} image outcome`, async () => {
    const calls: string[] = []
    const store = mode === 'missing-store' ? undefined : new Store()
    if (mode === 'storage' && store) store.fail = true
    const parts = mode === 'empty' ? [] : mode === 'invalid' ? [{ inlineData: { mimeType: 'image/png', data: '!!!!' } }] : [IMAGE]
    const raw = adapter([frame(parts, 'STOP')], store, calls)
    const health = new PoolHealthRegistry()
    const warnings: string[] = []
    const pool = new PoolAdapter({ adapters: { antigravity: raw }, health, usage: new PoolUsageTracker(() => undefined),
      strategy: 'priority', switchMargin: 2, defaultAccount: async () => 'alice',
      families: async () => new Map([[poolKey('antigravity', OPTIONS.model), { members: ['alice', 'bob'].map(account => ({ provider: 'antigravity' as const, model: OPTIONS.model, account })) }]]),
      tiers: {}, onWarn: value => warnings.push(value) })
    if (mode === 'success') {
      for (let i = 0; i < 2; i++) {
        const result = assemble(await collect(pool.stream(OPTIONS)))
        assert.equal(result.finish.kind, 'stop')
        assert.equal(result.blocks()[0]?.type, 'image')
      }
      assert.deepEqual(calls, ['Bearer alice', 'Bearer alice'])
      assert.deepEqual(warnings, [])
    } else {
      await assert.rejects(collect(pool.stream(OPTIONS)), (error: unknown) => error instanceof LlmError)
      assert.equal(calls.length, mode === 'empty' ? 2 : 1)
    }
    assert.equal(health.isAvailable(memberKey('antigravity', 'alice', OPTIONS.model)), mode !== 'empty')
    assert.equal(health.isAvailable(memberKey('antigravity', 'bob', OPTIONS.model)), mode !== 'empty')
  })
}
