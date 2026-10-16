/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */
import type { CompatibleContentBlock as ContentBlock, CompatibleMessage as Message, LegacyToolResultBlock as ToolResultBlock } from '../compat.js';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
/** An image block with its bytes resolved to inline base64 for the wire. */
export interface ResolvedImagePart {
    type: 'image';
    /** MIME type verified by the attachment service (e.g. `image/png`). */
    mediaType: string;
    /** Base64-encoded image bytes. */
    dataBase64: string;
}
/** Translator input block: a harness block, with images pre-resolved. */
export type TranslatableBlock = Exclude<ContentBlock, ToolResultBlock> | ResolvedImagePart | ResolvedToolResultBlock;
/** Tool results may themselves carry attachment-backed images. */
export interface ResolvedToolResultBlock extends Omit<ToolResultBlock, 'content'> {
    content: readonly TranslatableBlock[];
}
/**
 * Wires with text-only tool outputs receive images in a following user turn.
 * Defer that turn until all consecutive user messages have been processed:
 * parallel tool results can arrive in separate harness messages, and a user
 * image message must not interrupt their tool-call/output pairing.
 */
export declare function withToolResultImages(messages: readonly TranslatableMessage[]): TranslatableMessage[];
/** Translator input message: role plus resolved blocks. */
export interface TranslatableMessage {
    role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
    content: readonly TranslatableBlock[];
    /** First-class tool result correlation in current harness messages. */
    toolCallId?: string;
    /** Chat Completions correlation in imported histories. */
    tool_call_id?: string;
    isError?: boolean;
    /** Preserved for adapters whose provider-private replay metadata is required. */
    source?: NonNullable<Message['source']>;
}
/** A route's cap on outgoing image size; stored attachments are never changed. */
export interface ImageRequestLimit {
    /** Longest edge in pixels an image may be sent at. */
    maxEdge: number;
    /** Encoded-byte target before base64 expansion. */
    maxBytes: number;
}
/**
 * Failure code a host's image-offload executor answers by replacing the oldest
 * retained images with text and retrying (`IMAGE_OFFLOAD_REQUIRED_CODE` in
 * dsh-llm 0.2+). Spelled out so the build links against older hosts too.
 */
export declare const IMAGE_OFFLOAD_REQUIRED = "IMAGE_OFFLOAD_REQUIRED";
/**
 * Whether the installed host records image offloads. Hosts that predate the
 * executor never mark images `offloaded`, so asking them to would fail every
 * later request instead of shrinking it.
 */
export declare function hostSupportsImageOffload(): boolean;
/**
 * How many of the oldest images still sent inline must be offloaded before
 * the resolved request fits `maxBase64Bytes` of image data; zero when it fits.
 * Images are counted depth-first in request order, skipping assistant
 * messages, the same order the host's executor selects occurrences in.
 * @param messages - the resolved request, after {@link resolveImages}.
 * @param maxBase64Bytes - the route's budget for all inline image data.
 */
export declare function requiredImageOffloadCount(messages: readonly TranslatableMessage[], maxBase64Bytes: number): number;
/**
 * The request projection for one oversized image, or undefined when it fits.
 * Hosts before DSH 0.1.7 read a pixel budget (`maxPixels`), later ones the
 * target edges (`width`/`height`); each validates only its own fields, so
 * one projection carries both.
 */
export declare function imageRequestTarget(ref: {
    width: number;
    height: number;
}, limit: ImageRequestLimit): {
    width: number;
    height: number;
    maxPixels: number;
    maxBytes: number;
} | undefined;
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
export declare function resolveImages(messages: readonly Message[], attachments: AttachmentStore | undefined, signal?: AbortSignal, limit?: ImageRequestLimit): Promise<readonly TranslatableMessage[]>;
