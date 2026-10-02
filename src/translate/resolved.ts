/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
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
}

/**
 * The request projection for one oversized image, or undefined when it fits.
 * Hosts before DSH 0.1.7 read a pixel budget (`maxPixels`), later ones the
 * target edges (`width`/`height`); each validates only its own fields, so
 * one projection carries both.
 */
export function imageRequestTarget(
  ref: { width: number; height: number },
  limit: ImageRequestLimit,
): { width: number; height: number; maxPixels: number; maxBytes: number } | undefined {
  const longEdge = Math.max(ref.width, ref.height)
  if (!(longEdge > limit.maxEdge)) return undefined
  const short = (edge: number): number => Math.max(1, Math.floor(edge * limit.maxEdge / longEdge))
  const width = ref.width >= ref.height ? limit.maxEdge : short(ref.width)
  const height = ref.width >= ref.height ? short(ref.height) : limit.maxEdge
  return { width, height, maxPixels: width * height, maxBytes: limit.maxBytes }
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
 * @returns the same messages with image blocks resolved for the translators.
 */
export async function resolveImages(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
  limit?: ImageRequestLimit,
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
    throw new LlmError(
      'dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
      + 'image input requires the harness attachment store',
      'UNSUPPORTED',
    )
  }
  const readForRequest = async (ref: ImageAttachmentRef) => {
    if (attachments === undefined) throw new LlmError('No attachment service for retained image', 'UNSUPPORTED')
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
  const resolveBlock = async (block: ContentBlock): Promise<TranslatableBlock[]> => {
    if (block.type === 'tool-result') {
      return [{ ...block, content: (await Promise.all(block.content.map(resolveBlock))).flat() }]
    }
    if (block.type !== 'image') return [block]
    if ('offloaded' in block && block.offloaded === true) {
      // New hosts own the omission decision. Never restore omitted bytes,
      // including when the original attachment is no longer readable.
      const format = (llm as { offloadedImageText?: (ref: ImageAttachmentRef) => string }).offloadedImageText
      return [{ type: 'text', text: format?.(block.attachment)
        ?? `[image omitted to fit request image limits; ${block.attachment.attachmentId}]` }]
    }
    const { data, mediaType: sentType, ref } = await readForRequest(block.attachment)
    const { attachmentId, mediaType, bytes, width, height, name } = ref
    return [{
      type: 'image',
      mediaType: sentType,
      dataBase64: Buffer.from(data).toString('base64'),
    }, {
      type: 'text',
      text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
        attachmentId, mediaType, bytes, width, height, ...name === undefined ? {} : { name },
      })}`,
    }]
  }
  return Promise.all(messages.map(async (message): Promise<TranslatableMessage> => ({
    ...message,
    content: (await Promise.all(message.content.map(resolveBlock))).flat(),
  })))
}
