/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

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

/**
 * Translator input message: role plus resolved blocks.
 *
 * A delivered request may carry a tool result as its own message — role `tool`, the call id at
 * message level, and text blocks — rather than as the `tool-result` block a `user` message holds.
 * Both shapes reach the translators, so both are admitted here and each translator maps the
 * message form onto the tool-output item its own wire expects.
 */
export interface TranslatableMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: readonly TranslatableBlock[]
  /** Preserved for adapters whose provider-private replay metadata is required. */
  source?: Message['source']
  /** Call id of a delivered tool result; the message form carries it here, not in a block. */
  toolCallId?: string
  /** Whether a delivered tool result reports a failed call. */
  isError?: boolean
}

/**
 * Resolve every ImageBlock's attachment reference to inline base64 bytes.
 * Messages without images pass through unchanged. A request carrying an image
 * with no attachment service available fails loudly rather than silently
 * dropping the image.
 * @param messages - the request's conversation messages.
 * @param attachments - the deployment's attachment service, when mounted.
 * @param signal - cancellation for the storage reads.
 * @returns the same messages with image blocks resolved for the translators.
 */
export async function resolveImages(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly TranslatableMessage[]> {
  const hasImage = (block: ContentBlock): boolean => block.type === 'image'
    || (block.type === 'tool-result' && block.content.some(hasImage))
  if (!messages.some(message => message.content.some(hasImage))) {
    return messages
  }
  if (attachments === undefined) {
    throw new LlmError(
      'dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
      + 'image input requires the harness attachment store',
      'UNSUPPORTED',
    )
  }
  const resolveBlock = async (block: ContentBlock): Promise<TranslatableBlock[]> => {
    if (block.type === 'tool-result') {
      return [{ ...block, content: (await Promise.all(block.content.map(resolveBlock))).flat() }]
    }
    if (block.type !== 'image') return [block]
    const stored = await attachments.readImage(block.attachment, signal)
    const { attachmentId, mediaType, bytes, width, height, name } = stored.ref
    return [{
      type: 'image',
      mediaType: stored.ref.mediaType,
      dataBase64: Buffer.from(stored.data).toString('base64'),
    }, {
      type: 'text',
      text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
        attachmentId, mediaType, bytes, width, height, ...name === undefined ? {} : { name },
      })}`,
    }]
  }
  return Promise.all(messages.map(async (message): Promise<TranslatableMessage> => ({
    role: message.role,
    source: message.source,
    content: (await Promise.all(message.content.map(resolveBlock))).flat(),
  })))
}
