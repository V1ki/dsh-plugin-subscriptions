import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { imageRequestTarget, resolveImages } from '../src/translate/resolved.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'

const LIMIT = { maxEdge: 2000, maxBytes: 3_750_000 }
const WIDE = { attachmentId: 'wide', mediaType: 'image/png', bytes: 9, width: 2560, height: 1215 }
const TALL = { attachmentId: 'tall', mediaType: 'image/png', bytes: 9, width: 1800, height: 2329 }
const SMALL = { attachmentId: 'small', mediaType: 'image/png', bytes: 9, width: 800, height: 600 }

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

test('Claude turns send images within the 2000px many-image limit (#110)', async () => {
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
  const { attachments, calls } = store()
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('{}', { status: 400 })) as typeof globalThis.fetch
  try {
    const adapter = new ClaudeAdapter({
      models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
      streamIdleTimeoutMs: 1000,
      tokens,
      discovery: false,
      resolveAttachments: () => attachments,
      resolveCliVersion: async () => '2.1.999',
    })
    const options: GenerateOptions = { provider: 'claude', model: 'claude-opus-5-5', messages: withImages(TALL), maxTokens: 1_000 }
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options)) { /* drain */ } })
    assert.deepEqual(calls, ['request:tall'])
  } finally {
    globalThis.fetch = original
  }
})
