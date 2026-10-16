/**
 * `image_generate` tool: generate images through a subscription image
 * endpoint, save them under the harness home, and — when the deployment
 * mounts an attachment store and the calling route declares image input —
 * also commit the bytes as durable attachments so the images render inline
 * and enter model context (the same path `read_image` uses).
 *
 * Provider selection: the `provider` argument names the preferred provider
 * (default `gpt`, i.e. the ChatGPT/Codex subscription serving gpt-image-2 —
 * mirrors codex-rs `codex-api/src/images.rs`); when the preferred one is
 * logged out the other serves as fallback (`grok` is grok-imagine-image-2.0
 * via `api.x.ai/v1/images/generations` with `response_format: 'b64_json'`).
 * Both answer the OpenAI images shape (`data[].b64_json`).
 */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CodexSession, GrokSession } from '../auth/store.js';
import { AccountTokenManager } from '../providers/accounts.js';
import { ImageAccountPool } from '../providers/image-pool.js';
import type { FetchFn } from '../providers/common.js';
/** Endpoint the codex generation request is posted to. */
export declare const IMAGE_GENERATE_URL = "https://chatgpt.com/backend-api/codex/images/generations";
export declare const IMAGE_EDIT_URL = "https://chatgpt.com/backend-api/codex/images/edits";
/** The image model the codex subscription endpoint serves. */
export declare const IMAGE_GENERATE_MODEL = "gpt-image-2";
/** Endpoint the grok generation request is posted to. */
export declare const GROK_IMAGE_GENERATE_URL = "https://api.x.ai/v1/images/generations";
export declare const GROK_IMAGE_EDIT_URL = "https://api.x.ai/v1/images/edits";
/** The image model the grok subscription endpoint serves. */
export declare const GROK_IMAGE_GENERATE_MODEL = "grok-imagine-image-2.0";
/** Dependencies of the `image_generate` tool. */
export interface ImageGenerateToolOptions {
    /** Shared generation/edit account scheduling; standalone tools get a private pool. */
    imagePool?: ImageAccountPool;
    /** Creation-time provider policy; existing sessions retain their original tools. */
    providerEnabled?: (provider: 'codex' | 'grok', createdAt: number | undefined) => boolean;
    /** Codex session source; the default preferred provider (`provider: 'gpt'`). */
    codexTokens?: AccountTokenManager<CodexSession>;
    /** Grok session source; preferred when the call passes `provider: 'grok'`. */
    grokTokens?: AccountTokenManager<GrokSession>;
    /** Fetch implementation (injectable for tests). */
    fetchFn?: FetchFn;
    /** Directory override for saved images (defaults under the harness home). */
    imagesDir?: string;
    /** Lazy attachment-store lookup; absent or unmounted store keeps the text-only result. */
    resolveAttachments?: () => AttachmentStore | undefined;
    /** Lazy llm-service lookup for the image-capability route check. */
    resolveLlm?: () => LlmRuntime | undefined;
}
/** The wire request body for one generation call. */
export interface ImageGenerateRequestBody {
    prompt: string;
    model: string;
    size?: string;
    quality?: string;
}
/** The tool's own argument shape, shared by both provider body builders. */
export interface ImageGenerateArgs {
    prompt: string;
    size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
    quality?: 'low' | 'medium' | 'high' | 'auto';
    /** Preferred provider; the other one serves when the preferred is logged out. */
    provider?: 'gpt' | 'grok';
    /** Ordered durable references; omission generates, presence edits. */
    referenceImages?: ImageGenerateImageValue[];
}
/**
 * Assemble the codex request body from tool arguments (hand-checks the
 * non-empty prompt the schema DSL cannot express).
 */
export declare function buildImageGenerateBody(args: ImageGenerateArgs): ImageGenerateRequestBody;
/** The wire request body for one grok generation call. */
export interface GrokImageGenerateRequestBody {
    prompt: string;
    model: string;
    response_format: 'b64_json';
    aspect_ratio?: string;
    quality?: 'low' | 'medium';
}
/**
 * Assemble the grok request body from the same tool arguments: `size` maps
 * onto the nearest `aspect_ratio`, and `quality` folds into grok's low/medium
 * pair (`high` → `medium`, `auto` → provider default).
 */
export declare function buildGrokImageGenerateBody(args: ImageGenerateArgs): GrokImageGenerateRequestBody;
/** One generated image decoded from the response. */
export interface GeneratedImage {
    /** PNG bytes. */
    data: Buffer;
    /** Provider-revised prompt, when the response carries one. */
    revisedPrompt?: string;
}
/**
 * Parse the generations response into decodable images. Throws when the
 * payload carries no usable `b64_json` entries.
 */
export declare function parseImageGenerateResponse(payload: unknown): GeneratedImage[];
/** Directory the generated image files are written to. */
export declare function imagesDirectory(): string;
/** Media types the attachment store accepts and this tool can produce. */
export type GeneratedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
/**
 * Sniff a generated image's media type from its magic bytes (codex serves
 * PNG; grok's format is undocumented, so trust the bytes). Unrecognized data
 * defaults to PNG, matching the historical behavior.
 */
export declare function sniffImageMediaType(data: Buffer): GeneratedImageMediaType;
/** Canonical image metadata as the output schema declares it. */
interface ImageGenerateImageValue {
    attachmentId: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    bytes: number;
    width: number;
    height: number;
    name?: string;
    originalDimensions?: {
        width: number;
        height: number;
    };
}
/**
 * Build the `image_generate` tool definition.
 * @param options - codex session source, fetch implementation, and image directory.
 * @returns the tool to register on `ctx.tools`.
 */
export declare function createImageGenerateTool(options: ImageGenerateToolOptions): ToolDefinition;
export {};
