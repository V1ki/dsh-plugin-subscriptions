/** Opt-in #186 host check. See docs/antigravity-output-images.md for isolated setup. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import { parseAntigravityResponse, streamAntigravity, toAntigravityContents } from '../lib-test/src/translate/antigravity.js'
import { resolveImages } from '../lib-test/src/translate/resolved.js'

const hostRoot = process.argv[2]
assert.ok(hostRoot, 'Pass an isolated npm prefix containing the documented host packages')
const hostRequire = createRequire(join(resolve(hostRoot), 'package.json'))
const hostImport = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const { Context } = await hostImport('@deepseek-ai/cordis')
const { LocalAttachmentStore } = await hostImport('@deepseek-ai/dsh-attachment-local')
const { BlockAssembler, AssistantStreamAccumulator, expandAssistantStream } = await hostImport('@deepseek-ai/dsh-llm')
const sharp = hostRequire('sharp')
const home = await mkdtemp(join(tmpdir(), 'issue186-images-'))
const versions = Object.fromEntries(['dsh-attachment-local', 'dsh-client-ui-attachment', 'dsh-client-ui-chat', 'dsh-llm'].map(name =>
  [name, hostRequire(`@deepseek-ai/${name}/package.json`).version]))
const model = 'gemini-3.1-flash-image'
const frame = (parts, finishReason = 'STOP') => ({ response: { candidates: [{ content: { parts }, finishReason }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } } })
const report = { versions, cases: [], limits: 'host defaults; isolated temporary DSH home', realUpstream: false, browserSession: false }
try {
  let lastImage, lastData
  for (const format of ['png', 'jpeg', 'webp', 'gif']) {
    const data = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ed7d31' } }).toFormat(format).toBuffer()
    const part = { inlineData: { mimeType: `image/${format}`, data: data.toString('base64') }, thoughtSignature: 'image-signature' }
    for (const transport of ['SSE', 'JSON']) for (const mixed of [false, true]) {
      const store = new LocalAttachmentStore(new Context(), { dshHome: home })
      const parts = mixed ? [{ text: 'before' }, part, { text: 'after', thoughtSignature: 'after-signature' }] : [part]
      const event = frame(parts)
      const chunks = transport === 'JSON' ? await parseAntigravityResponse(event, store) : await Array.fromAsync(streamAntigravity(
        new Response(`data: ${JSON.stringify(event)}\n\n`).body, undefined, store))
      const accumulator = new AssistantStreamAccumulator()
      for (const [i, chunk] of chunks.entries()) accumulator.push({ time: i, chunk })
      // Serialize exactly the host's compact stream, then rebuild from its decoder.
      const log = join(home, 'stream.json')
      await writeFile(log, JSON.stringify(accumulator.snapshot()))
      const assembled = new BlockAssembler()
      for (const { chunk } of expandAssistantStream(JSON.parse(await readFile(log, 'utf8')))) assembled.push(chunk)
      assert.equal(assembled.finish.kind, 'stop')
      const message = assembled.message({ provider: 'antigravity', model, replayState: assembled.replayState })
      const saved = join(home, 'message.json')
      await writeFile(saved, JSON.stringify(message))
      const restored = JSON.parse(await readFile(saved, 'utf8'))
      const reopened = new LocalAttachmentStore(new Context(), { dshHome: home })
      const image = restored.content.find(block => block.type === 'image')
      const stored = await reopened.readImage(image.attachment)
      assert.equal((await sharp(stored.data).metadata()).width, 3)
      assert.equal((await sharp(stored.data).metadata()).height, 2)
      const replay = toAntigravityContents(await resolveImages([restored], reopened), model)[0].parts
      assert.deepEqual(replay.map(p => p.text ?? 'image'), parts.map(p => p.text ?? 'image'))
      assert.deepEqual(replay.map(p => p.thoughtSignature), parts.map(p => p.thoughtSignature))
      assert.equal(replay.find(p => p.inlineData).inlineData.data, Buffer.from(stored.data).toString('base64'))
      assert.ok(!JSON.stringify(restored).includes(data.toString('base64')))
      lastImage = image; lastData = stored.data
      report.cases.push(`${format}/${transport}/${mixed ? 'mixed' : 'image-only'}: persisted, reopened, assembled and replayed`)
    }
    const store = new LocalAttachmentStore(new Context(), { dshHome: home })
    await assert.rejects(parseAntigravityResponse(frame([{ inlineData: { mimeType: format === 'png' ? 'image/jpeg' : 'image/png', data: data.toString('base64') } }]), store), { code: 'IMAGE_OUTPUT_STORAGE' })
    await assert.rejects(parseAntigravityResponse(frame([{ inlineData: { mimeType: `image/${format}`, data: data.subarray(0, 12).toString('base64') } }]), store), { code: 'IMAGE_OUTPUT_STORAGE' })
  }
  const large = await sharp(randomBytes(768 * 512 * 3), { raw: { width: 768, height: 512, channels: 3 } }).png().toBuffer()
  assert.ok(large.toString('base64').length > 927472, 'exceeds the payload size reported in #186')
  const largeEvent = frame([{ inlineData: { mimeType: 'image/png', data: large.toString('base64') } }])
  const largeChunks = await parseAntigravityResponse(largeEvent, new LocalAttachmentStore(new Context(), { dshHome: home }))
  assert.equal(largeChunks.at(-1).reason.kind, 'stop')
  for (const limit of [{ maxImagePixels: 5 }, { maxImageDimension: 2 }]) {
    await assert.rejects(parseAntigravityResponse(largeEvent, new LocalAttachmentStore(new Context(), { dshHome: home, ...limit })), { code: 'IMAGE_OUTPUT_STORAGE' })
  }
  report.largeImage = { base64Characters: large.toString('base64').length, accepted: true, pixelAndDimensionLimits: 'rejected by real host decoder' }
  // Run the published image gallery in React SSR with a preloaded image. This
  // verifies its real <img> output, not browser effects, session RPC or layout.
  const projectRequire = createRequire(import.meta.url)
  const React = projectRequire('react')
  const { renderToStaticMarkup } = projectRequire('react-dom/server')
  const bundle = await readFile(hostRequire.resolve('@deepseek-ai/dsh-client-ui-attachment/client'), 'utf8')
  let plugin
  runInNewContext(bundle, { window: { __ModuleLoader__: { load: ({ factory }) => {
    plugin = factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : projectRequire(name))
  } } } })
  const factories = new Map(), slots = new Map()
  plugin.apply({ slots: { registerFactory: (spec, component) => factories.set(spec.name, component),
    inject: (_name, callback) => callback(), register: (spec, component) => slots.set(spec.name, component) } })
  const src = `data:${lastImage.attachment.mediaType};base64,${Buffer.from(lastData).toString('base64')}`
  const loadImage = Object.assign(async () => src, { peek: () => src })
  const renderFactorySlot = (name, props) => React.createElement(factories.get(name), { ...props, t: key => key })
  const markup = renderToStaticMarkup(React.createElement(slots.get('conversation.chat.message.images'), {
    images: [lastImage], loadImage, renderFactorySlot,
  }))
  assert.match(markup, /<img /)
  assert.ok(markup.includes(src))
  report.renderer = 'published assistant message image slot renders an img with persisted bytes (SSR, preloaded URL)'
  report.boundaries = 'real decoder rejects MIME mismatch and truncated rasters for PNG/JPEG/WebP/GIF'
  console.log(JSON.stringify(report, null, 2))
} finally {
  await rm(home, { recursive: true, force: true })
}
