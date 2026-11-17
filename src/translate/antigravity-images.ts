import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { llmErrorFromFailure } from '../providers/common.js'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

const MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Response-scoped admission: persist bytes before publishing a host image block. */
export class AntigravityOutputImages {
  private count = 0
  private bytes = 0

  constructor(private readonly attachments?: AttachmentStore, private readonly signal?: AbortSignal) {}

  async save(value: unknown): Promise<ImageBlock> {
    this.signal?.throwIfAborted()
    if (value === null || typeof value !== 'object') {
      throw llmErrorFromFailure({ message: 'Antigravity returned invalid inlineData', code: 'INVALID_IMAGE_RESPONSE' })
    }
    const { mimeType, data } = value as { mimeType?: unknown; data?: unknown }
    if (typeof mimeType !== 'string' || !MEDIA_TYPES.includes(mimeType)
      || typeof data !== 'string' || data.length === 0) {
      throw llmErrorFromFailure({ message: 'Antigravity returned an unsupported image MIME type or empty image', code: 'INVALID_IMAGE_RESPONSE' })
    }
    const store = this.attachments
    if (store === undefined) {
      throw llmErrorFromFailure({ message: 'Antigravity image output requires the DSH attachment store', code: 'UNSUPPORTED' })
    }
    const limits = store.imageLimits
    const byteBudget = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes - this.bytes)
    if (this.count >= limits.maxImagesPerMessage || data.length > Math.ceil(byteBudget / 3) * 4) {
      throw llmErrorFromFailure({ message: 'Antigravity image output exceeds host attachment limits', code: 'IMAGE_OUTPUT_LIMIT' })
    }
    // Buffer's decoder is permissive; require canonical, padded base64 and reject
    // data URLs, whitespace, invalid padding and truncated encodings explicitly.
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw llmErrorFromFailure({ message: 'Antigravity returned invalid image base64', code: 'INVALID_IMAGE_RESPONSE' })
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data) {
      throw llmErrorFromFailure({ message: 'Antigravity returned non-canonical image base64', code: 'INVALID_IMAGE_RESPONSE' })
    }
    if (bytes.length > byteBudget) {
      throw llmErrorFromFailure({ message: 'Antigravity image output exceeds host attachment limits', code: 'IMAGE_OUTPUT_LIMIT' })
    }
    if (!limits.mediaTypes.includes(mimeType as ImageMediaType)) {
      throw llmErrorFromFailure({ message: 'Antigravity image MIME type is disabled by the host', code: 'INVALID_IMAGE_RESPONSE' })
    }
    // The store verifies MIME against decoded pixels, dimensions and integrity.
    // Local admission/storage failures must not penalize a subscription account.
    let attachment
    try {
      attachment = await store.saveImage({ data: bytes, mediaType: mimeType as ImageMediaType })
    } catch {
      this.signal?.throwIfAborted()
      throw llmErrorFromFailure({ message: 'Could not validate or persist Antigravity output image', code: 'IMAGE_OUTPUT_STORAGE' })
    }
    this.signal?.throwIfAborted()
    this.count += 1
    this.bytes += bytes.length
    return { type: 'image', attachment }
  }
}
