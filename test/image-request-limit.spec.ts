import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '../src/compat.js'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { hostSupportsImageOffload, imageRequestTarget, requiredImageOffloadCount, resolveImages } from '../src/translate/resolved.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'
import { CLAUDE_REQUEST_IMAGE_BUDGET, ClaudeAdapter } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { CompatibleMessage } from '../src/compat.js'

const LIMIT = { maxEdge: 2000, maxBytes: 3_750_000 }
const WIDE = { attachmentId: 'wide', mediaType: 'image/png', bytes: 9, width: 2560, height: 1215 }
const TALL = { attachmentId: 'tall', mediaType: 'image/png', bytes: 9, width: 1800, height: 2329 }
const SMALL = { attachmentId: 'small', mediaType: 'image/png', bytes: 9, width: 800, height: 600 }

test('offloaded request images remain text without reading attachments or requiring a store', async () => {
  const messages: GenerateOptions['messages'] = [{
    role: 'user',
    content: [{ type: 'image', attachment: { ...SMALL, mediaType: 'image/png', attachmentId: AttachmentId('small') }, offloaded: true }],
  }]
  const { attachments, calls } = store()
  for (const backend of [attachments, undefined]) {
    const result = await resolveImages(messages, backend)
    assert.equal(result[0]?.content.some(block => block.type === 'image'), false)
    assert.match(JSON.stringify(result), /image omitted to fit request image limits/)
  }
  assert.deepEqual(calls, [])
  assert.equal(messages[0]?.content[0]?.type, 'image', 'durable input is not rewritten')
})

test('legacy nested tool images honor offload while retained occurrences still resolve', async () => {
  const attachment = { ...SMALL, mediaType: 'image/png' as const, attachmentId: AttachmentId('small') }
  const messages: CompatibleMessage[] = [{ role: 'user', content: [{
    type: 'tool-result', toolCallId: ToolCallId('call'), content: [
      { type: 'image', attachment, offloaded: true },
      { type: 'image', attachment },
    ],
  }] }]
  const { attachments, calls } = store()
  const result = await resolveImages(messages, attachments)
  assert.deepEqual(calls, ['stored:small'])
  const block = result[0]?.content[0]
  assert.equal(block?.type, 'tool-result')
  if (block?.type !== 'tool-result') throw new Error('missing tool result')
  assert.equal(block.content.filter(part => part.type === 'image').length, 1)
  assert.match(JSON.stringify(block.content[0]), /image omitted/)
})

function withImages(...refs: object[]): Message[] {
  return [{
    id: MessageId('m'),
    role: 'user',
    source: { kind: 'user' },
    content: refs.map(attachment => ({ type: 'image', attachment }) as never),
  }]
}

/** An attachment store recording which read each image took. */
function store(options: { projection?: 'unsupported' } = {}) {
  const calls: string[] = []
  const targets: unknown[] = []
  const attachments = {
    readImage: async (ref: { attachmentId: string }) => {
      calls.push(`stored:${ref.attachmentId}`)
      return { ref, data: new Uint8Array([111]) }
    },
    readImageRequest: async (ref: { attachmentId: string }, target: unknown) => {
      if (options.projection === 'unsupported') throw new Error('The mounted attachment provider cannot derive model-request images.')
      calls.push(`request:${ref.attachmentId}`)
      targets.push(target)
      return { attachment: ref, data: new Uint8Array([115]), mediaType: 'image/jpeg' }
    },
  }
  return { attachments: attachments as never, calls, targets }
}

test('image request targets fit the long edge and carry both host projection shapes', () => {
  // Pre-0.1.7 hosts read maxPixels, 0.1.7+ hosts read width/height.
  assert.deepEqual(imageRequestTarget(WIDE, LIMIT), { width: 2000, height: 949, maxPixels: 1_898_000, maxBytes: 3_750_000 })
  assert.deepEqual(imageRequestTarget(TALL, LIMIT), { width: 1545, height: 2000, maxPixels: 3_090_000, maxBytes: 3_750_000 })
  assert.equal(imageRequestTarget({ width: 2000, height: 2000 }, LIMIT), undefined)
  assert.equal(imageRequestTarget(SMALL, LIMIT), undefined)
})

test('a limited route sends oversized images downscaled and leaves the rest as stored', async () => {
  const { attachments, calls, targets } = store()
  const [message] = await resolveImages(withImages(WIDE, SMALL), attachments, undefined, LIMIT)
  assert.deepEqual(calls, ['request:wide', 'stored:small'])
  assert.deepEqual(targets, [imageRequestTarget(WIDE, LIMIT)])
  assert.deepEqual(message!.content[0], { type: 'image', mediaType: 'image/jpeg', dataBase64: 'cw==' })
  // The reference the model may reuse still names the stored attachment.
  assert.match((message!.content[1] as { text: string }).text, /"attachmentId":"wide","mediaType":"image\/png","bytes":9,"width":2560/)
  assert.deepEqual(message!.content[2], { type: 'image', mediaType: 'image/png', dataBase64: 'bw==' })
})

test('without a limit, or on a host that cannot project, images are sent as stored', async () => {
  const unlimited = store()
  await resolveImages(withImages(WIDE), unlimited.attachments)
  assert.deepEqual(unlimited.calls, ['stored:wide'])
  const unsupported = store({ projection: 'unsupported' })
  const [message] = await resolveImages(withImages(WIDE), unsupported.attachments, undefined, LIMIT)
  assert.deepEqual(unsupported.calls, ['stored:wide'])
  assert.deepEqual(message!.content[0], { type: 'image', mediaType: 'image/png', dataBase64: 'bw==' })
})

/** A Claude adapter on one logged-in account whose requests `fetch` answers. */
function claudeAdapter(attachments: unknown) {
  const session: ClaudeSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scopes: 'scope' }
  const tokens = new AccountTokenManager<ClaudeSession>({
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
  return new ClaudeAdapter({
    models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
    streamIdleTimeoutMs: 1000,
    tokens,
    discovery: false,
    resolveAttachments: () => attachments as never,
    resolveCliVersion: async () => '2.1.999',
  })
}

/** Drain one Claude turn with `fetch` stubbed, returning the error and request count. */
async function claudeTurn(messages: Message[], attachments: unknown): Promise<{ error: unknown; fetches: number }> {
  let fetches = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    fetches += 1
    return new Response('{}', { status: 400 })
  }) as typeof globalThis.fetch
  try {
    const options: GenerateOptions = { provider: 'claude', model: 'claude-opus-5-5', messages, maxTokens: 1_000 }
    for await (const _chunk of claudeAdapter(attachments).stream(options)) { /* drain */ }
    return { error: undefined, fetches }
  } catch (error: unknown) {
    return { error, fetches }
  } finally {
    globalThis.fetch = original
  }
}

/** An attachment store whose every image reads back as `bytes` raw bytes. */
function sizedStore(bytes: number) {
  const data = new Uint8Array(bytes)
  return {
    readImage: async (ref: unknown) => ({ ref, data }),
    readImageRequest: async (ref: unknown) => ({ attachment: ref, data, mediaType: 'image/png' }),
  }
}

test('Claude turns send images within the 2000px many-image limit (#110)', async () => {
  const { attachments, calls } = store()
  const { error } = await claudeTurn(withImages(TALL), attachments)
  assert.ok(error instanceof Error)
  assert.deepEqual(calls, ['request:tall'])
})

/** Resolved user turn carrying one inline image per given base64 length. */
function resolvedImages(...lengths: number[]): TranslatableMessage[] {
  return [{ role: 'user', content: lengths.map(length => ({ type: 'image', mediaType: 'image/png', dataBase64: 'A'.repeat(length) })) }]
}

test('a request within the image budget needs no offload', () => {
  assert.equal(requiredImageOffloadCount(resolvedImages(40, 60), 100), 0)
})

test('the oldest images are offloaded until the rest fit the budget', () => {
  assert.equal(requiredImageOffloadCount(resolvedImages(50, 30, 40, 20), 100), 1)
  assert.equal(requiredImageOffloadCount(resolvedImages(10, 10, 90, 20), 100), 3)
})

test('tool-result images count toward the budget and assistant images do not', () => {
  const messages: TranslatableMessage[] = [
    { role: 'assistant', content: resolvedImages(500)[0]!.content },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('call'), content: resolvedImages(80)[0]!.content }] },
    ...resolvedImages(80),
  ]
  assert.equal(requiredImageOffloadCount(messages, 100), 1)
})

test('this host records image offloads', () => {
  assert.equal(hostSupportsImageOffload(), true)
})

test('Claude asks the host to offload the oldest images instead of sending an oversized request', async () => {
  // 7 images of 3.75MB raw (5MB base64) total 35MB, over the 20MiB budget;
  // offloading the oldest 3 leaves 4 (20MB), which fits.
  const raw = 3_750_000
  const refs = Array.from({ length: 7 }, (_, index) => ({ ...SMALL, attachmentId: `shot${index}`, bytes: raw }))
  const { error, fetches } = await claudeTurn(withImages(...refs), sizedStore(raw))
  assert.equal(fetches, 0, 'nothing is sent before the host offloads')
  assert.ok(error instanceof Error)
  const failure = error as Error & { code?: string; failure?: { offloadImages?: number } }
  assert.equal(failure.code, 'IMAGE_OFFLOAD_REQUIRED')
  const base64 = Math.ceil(raw / 3) * 4
  assert.equal(failure.failure?.offloadImages, 7 - Math.floor(CLAUDE_REQUEST_IMAGE_BUDGET / base64))
})

test('Claude sends a request whose images fit the budget', async () => {
  const refs = Array.from({ length: 3 }, (_, index) => ({ ...SMALL, attachmentId: `shot${index}`, bytes: 1_000_000 }))
  const { error, fetches } = await claudeTurn(withImages(...refs), sizedStore(1_000_000))
  assert.equal(fetches, 1)
  assert.notEqual((error as { code?: string }).code, 'IMAGE_OFFLOAD_REQUIRED')
})
