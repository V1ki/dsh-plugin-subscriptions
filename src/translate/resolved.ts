/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */

import { llmErrorFromFailure } from '../providers/common.js'
import * as llm from '@deepseek-ai/dsh-llm'
import type { CompatibleContentBlock as ContentBlock, CompatibleMessage as Message, LegacyToolResultBlock as ToolResultBlock } from '../compat.js'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** An image block with its bytes resolved to inline base64 for the wire. */
export interface ResolvedImagePart {
  type: 'image'
  /** MIME type verified by the attachment service (e.g. `image/png`). */
  mediaType: string
  /** Base64-encoded image bytes. */
  dataBase64: string
}

/** Translator input block: a harness block, with images pre-resolved. */
export type TranslatableBlock = Exclude<ContentBlock, ToolResultBlock> | ResolvedImagePart | ResolvedToolResultBlock

/** Tool results may themselves carry attachment-backed images. */
export interface ResolvedToolResultBlock extends Omit<ToolResultBlock, 'content'> {
  content: readonly TranslatableBlock[]
}

/**
 * Wires with text-only tool outputs receive images in a following user turn.
 * Defer that turn until all consecutive user messages have been processed:
 * parallel tool results can arrive in separate harness messages, and a user
 * image message must not interrupt their tool-call/output pairing.
 */
export function withToolResultImages(messages: readonly TranslatableMessage[]): TranslatableMessage[] {
  const out: TranslatableMessage[] = []
  let images: TranslatableBlock[] = []
  const flush = (): void => {
    if (images.length > 0) out.push({ role: 'user', content: images })
    images = []
  }
  for (const message of messages) {
    if (message.role === 'assistant') flush()
    out.push(message)
    if (message.role === 'tool') {
      const parts = message.content.filter((part): part is ResolvedImagePart => part.type === 'image' && 'dataBase64' in part)
      if (parts.length > 0) {
        images.push({ type: 'text', text: `Images from tool result ${String(message.toolCallId)}:` }, ...parts)
      }
    }
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const parts = block.content.filter((part): part is ResolvedImagePart => part.type === 'image' && 'dataBase64' in part)
      if (parts.length > 0) {
        images.push({ type: 'text', text: `Images from tool result ${String(block.toolCallId)}:` }, ...parts)
      }
    }
  }
  flush()
  return out
}

/** Translator input message: role plus resolved blocks. */
export interface TranslatableMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: readonly TranslatableBlock[]
  /** First-class tool result correlation in current harness messages. */
  toolCallId?: string
  /** Chat Completions correlation in imported histories. */
  tool_call_id?: string
  isError?: boolean
  /** Preserved for adapters whose provider-private replay metadata is required. */
  source?: NonNullable<Message['source']>
}

/** A route's cap on outgoing image size; stored attachments are never changed. */
export interface ImageRequestLimit {
  /** Longest edge in pixels an image may be sent at. */
  maxEdge: number
  /** Encoded-byte target before base64 expansion. */
  maxBytes: number
  /**
   * Stored size above which an image within `maxEdge` is still re-encoded at
   * its own dimensions, and the byte target for every re-encoded image. Lossless
   * screenshots run 2–4MB each, so without it a few of them exhaust a route's
   * request image budget and older images are omitted. Absent means only
   * oversized edges trigger a re-encode.
   */
  softBytes?: number
}

/** Execution-world read path of one image, as the host's offload placeholder names it. */
export interface ImageAccess {
  readonlyPath: string
}

/** Maps one absolute host path into the current tool execution world. */
export type HostPathMapper = (hostPath: string) => string | undefined

/**
 * Failure code a host's image-offload executor answers by replacing the oldest
 * retained images with text and retrying (`IMAGE_OFFLOAD_REQUIRED_CODE` in
 * dsh-llm 0.2+). Spelled out so the build links against older hosts too.
 */
export const IMAGE_OFFLOAD_REQUIRED = 'IMAGE_OFFLOAD_REQUIRED'

/**
 * Whether the installed host records image offloads. Hosts that predate the
 * executor never mark images `offloaded`, so asking them to would fail every
 * later request instead of shrinking it.
 */
export function hostSupportsImageOffload(): boolean {
  const exports = llm as Record<string, unknown>
  return exports['IMAGE_OFFLOAD_REQUIRED_CODE'] === IMAGE_OFFLOAD_REQUIRED
    && typeof exports['offloadedImageText'] === 'function'
}

/**
 * How many of the oldest images still sent inline must be offloaded before
 * the resolved request fits `maxBase64Bytes` of image data; zero when it fits.
 * Images are counted depth-first in request order, skipping assistant
 * messages, the same order the host's executor selects occurrences in.
 * @param messages - the resolved request, after {@link resolveImages}.
 * @param maxBase64Bytes - the route's budget for all inline image data.
 */
export function requiredImageOffloadCount(messages: readonly TranslatableMessage[], maxBase64Bytes: number): number {
  const lengths: number[] = []
  const visit = (blocks: readonly TranslatableBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image' && 'dataBase64' in block) lengths.push(block.dataBase64.length)
      else if (block.type === 'tool-result') visit(block.content)
    }
  }
  for (const message of messages) {
    if (message.role !== 'assistant') visit(message.content)
  }
  let excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - maxBase64Bytes
  let count = 0
  while (excess > 0 && count < lengths.length) {
    excess -= lengths[count]!
    count += 1
  }
  return count
}

/** Request-image target carrying every host generation's fields. */
export interface ImageRequestProjection {
  width: number
  height: number
  /** DSH 0.1.x pixel budget. */
  maxPixels: number
  /** DSH 0.1.7–0.2.2 byte target. */
  maxBytes: number
  /** DSH 0.2.3+ hard encoded-byte cap: the route's own limit. */
  maxImageBytes: number
  /** DSH 0.2.3+ preferred encoded-byte target, never above `maxImageBytes`. */
  imageTargetBytes: number
}

/**
 * The request projection for one oversized image, or undefined when it fits.
 * An image is oversized when its long edge exceeds `maxEdge`, or when its
 * stored bytes exceed `softBytes`; the latter keeps its dimensions and is only
 * re-encoded. Hosts before DSH 0.1.7 read a pixel budget (`maxPixels`), later
 * ones the target edges (`width`/`height`). DSH 0.2.3 split the byte budget
 * into a hard cap (`maxImageBytes`) and a preferred target
 * (`imageTargetBytes`) and rejects a target that lacks them; hosts before it
 * read the single `maxBytes`. Each host validates only its own fields, so one
 * projection carries all of them.
 */
export function imageRequestTarget(
  ref: { width: number; height: number; bytes?: number },
  limit: ImageRequestLimit,
): ImageRequestProjection | undefined {
  const maxBytes = limit.softBytes === undefined ? limit.maxBytes : Math.min(limit.maxBytes, limit.softBytes)
  const budget = { maxBytes, maxImageBytes: limit.maxBytes, imageTargetBytes: maxBytes }
  const longEdge = Math.max(ref.width, ref.height)
  if (!(longEdge > limit.maxEdge)) {
    if (limit.softBytes === undefined || !(ref.bytes !== undefined && ref.bytes > maxBytes)) return undefined
    return { width: ref.width, height: ref.height, maxPixels: ref.width * ref.height, ...budget }
  }
  const short = (edge: number): number => Math.max(1, Math.floor(edge * limit.maxEdge / longEdge))
  const width = ref.width >= ref.height ? limit.maxEdge : short(ref.width)
  const height = ref.width >= ref.height ? short(ref.height) : limit.maxEdge
  return { width, height, maxPixels: width * height, ...budget }
}

/**
 * Read path of one stored image for the offload placeholder, so the model can
 * reopen an omitted image with its own tools as on the host's built-in routes.
 * Undefined when the host predates `resolveImageAttachmentAccess`, no mapper
 * is mounted, or the reference cannot be resolved: the placeholder then keeps
 * its no-path wording rather than failing the request.
 */
export function offloadedImageAccess(
  attachments: AttachmentStore | undefined,
  mapHostPath: HostPathMapper | undefined,
  ref: ImageAttachmentRef,
): ImageAccess | undefined {
  if (attachments === undefined || mapHostPath === undefined) return undefined
  const resolve = (llm as {
    resolveImageAttachmentAccess?: (store: AttachmentStore, map: HostPathMapper, ref: ImageAttachmentRef) => ImageAccess | undefined
  }).resolveImageAttachmentAccess
  if (typeof resolve !== 'function') return undefined
  try {
    return resolve(attachments, mapHostPath, ref)
  } catch {
    return undefined
  }
}

/**
 * Resolve every ImageBlock's attachment reference to inline base64 bytes.
 * Messages without images pass through unchanged. A request carrying an image
 * with no attachment service available fails loudly rather than silently
 * dropping the image.
 * @param messages - the request's conversation messages.
 * @param attachments - the deployment's attachment service, when mounted.
 * @param signal - cancellation for the storage reads.
 * @param limit - the route's outgoing image cap; oversized images are sent
 *   downscaled while the stored attachment and history stay untouched.
 * @param mapHostPath - the mounted filesystem's host-path mapping; when
 *   present, offload placeholders name a read-only copy the model can reopen.
 * @returns the same messages with image blocks resolved for the translators.
 */
export async function resolveImages(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
  limit?: ImageRequestLimit,
  mapHostPath?: HostPathMapper,
): Promise<readonly TranslatableMessage[]> {
  const hasImage = (block: ContentBlock): boolean => block.type === 'image'
    || (block.type === 'tool-result' && block.content.some(hasImage))
  if (!messages.some(message => message.content.some(hasImage))) {
    return messages
  }
  const hasRetainedImage = (block: ContentBlock): boolean => block.type === 'image'
    ? !('offloaded' in block && block.offloaded === true)
    : block.type === 'tool-result' && block.content.some(hasRetainedImage)
  if (attachments === undefined && messages.some(message => message.content.some(hasRetainedImage))) {
    throw llmErrorFromFailure({
      message: 'dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
        + 'image input requires the harness attachment store',
      code: 'UNSUPPORTED',
    })
  }
  const readForRequest = async (ref: ImageAttachmentRef) => {
    if (attachments === undefined) throw llmErrorFromFailure({ message: 'No attachment service for retained image', code: 'UNSUPPORTED' })
    const target = limit === undefined ? undefined : imageRequestTarget(ref, limit)
    if (target !== undefined) {
      try {
        const version = await attachments.readImageRequest(ref, target, signal)
        return { data: version.data, mediaType: version.mediaType, ref: version.attachment }
      } catch (error) {
        // A host that cannot derive request images keeps sending the stored bytes, as before.
        if (signal?.aborted) throw error
      }
    }
    const stored = await attachments.readImage(ref, signal)
    return { data: stored.data, mediaType: stored.ref.mediaType, ref: stored.ref }
  }
  const resolveBlock = async (block: ContentBlock, assistant = false): Promise<TranslatableBlock[]> => {
    if (block.type === 'tool-result') {
      return [{ ...block, content: (await Promise.all(block.content.map(part => resolveBlock(part)))).flat() }]
    }
    if (block.type !== 'image') return [block]
    if ('offloaded' in block && block.offloaded === true) {
      // New hosts own the omission decision. Never restore omitted bytes,
      // including when the original attachment is no longer readable.
      const format = (llm as { offloadedImageText?: (ref: ImageAttachmentRef, access?: ImageAccess) => string }).offloadedImageText
      return [{ type: 'text', text: format?.(block.attachment, offloadedImageAccess(attachments, mapHostPath, block.attachment))
        ?? `[image omitted to fit request image limits; ${block.attachment.attachmentId}]` }]
    }
    const { data, mediaType: sentType, ref } = await readForRequest(block.attachment)
    const { attachmentId, mediaType, bytes, width, height, name } = ref
    const image: ResolvedImagePart = {
      type: 'image',
      mediaType: sentType,
      dataBase64: Buffer.from(data).toString('base64'),
    }
    // Assistant replay metadata is indexed by content block. Adding a helper
    // text block here would shift every later thought signature onto the wrong
    // block. User/tool image references still carry the editing-tool hint.
    if (assistant) return [image]
    return [image, {
      type: 'text',
      text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
        attachmentId, mediaType, bytes, width, height, ...name === undefined ? {} : { name },
      })}`,
    }]
  }
  return Promise.all(messages.map(async (message): Promise<TranslatableMessage> => ({
    ...message,
    content: (await Promise.all(message.content.map(block => resolveBlock(block, message.role === 'assistant')))).flat(),
  })))
}
