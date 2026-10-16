/**
 * `video_generate` tool: generate videos through the grok subscription's
 * Imagine video endpoint and save them as MP4 files under the harness home.
 * The xAI API is asynchronous: POST `/v1/videos/generations` returns a
 * `request_id`, GET `/v1/videos/{request_id}` is polled until the status
 * leaves `pending`, and the completed response carries a temporary MP4 URL
 * that is downloaded promptly (the URL expires). The canonical result is the
 * saved file path; videos have no attachment surface, so the result stays
 * text-only (unlike image_generate).
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GrokSession } from '../auth/store.js';
import { AccountTokenManager } from '../providers/accounts.js';
import type { FetchFn } from '../providers/common.js';
/** Endpoint the generation request is posted to. */
export declare const VIDEO_GENERATE_URL = "https://api.x.ai/v1/videos/generations";
/** The video model the grok subscription endpoint serves. */
export declare const VIDEO_GENERATE_MODEL = "grok-imagine-video-1.5";
/** Polling endpoint for one generation request. */
export declare function videoStatusUrl(requestId: string): string;
/** Default delay between two status polls. */
export declare const DEFAULT_POLL_INTERVAL_MS = 3000;
/** Default overall deadline for one generation (submit → done). */
export declare const DEFAULT_MAX_WAIT_MS: number;
/** Dependencies of the `video_generate` tool. */
export interface VideoGenerateToolOptions {
    /** Grok session source; a missing session throws the log-in hint. */
    tokens: AccountTokenManager<GrokSession>;
    /** Fetch implementation (injectable for tests). */
    fetchFn?: FetchFn;
    /** Directory override for saved videos (defaults under the harness home). */
    videosDir?: string;
    /** Delay between status polls (injectable for tests). */
    pollIntervalMs?: number;
    /** Overall deadline from submit to completion. */
    maxWaitMs?: number;
}
/** The wire request body for one generation call. */
export interface VideoGenerateRequestBody {
    prompt: string;
    model: string;
    duration?: number;
    aspect_ratio?: string;
    resolution?: string;
    image?: {
        url: string;
    };
}
/**
 * Assemble the request body from tool arguments (hand-checks the non-empty
 * prompt and the duration range the schema DSL cannot express).
 */
export declare function buildVideoGenerateBody(args: {
    prompt: string;
    duration?: number;
    aspect_ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '3:2' | '2:3';
    resolution?: '480p' | '720p' | '1080p';
    image_url?: string;
}): VideoGenerateRequestBody;
/**
 * Extract the request id from the submit response. Throws when the payload
 * carries none.
 */
export declare function parseVideoStartResponse(payload: unknown): string;
/** One decoded poll response. */
export type VideoStatus = {
    status: 'pending';
} | {
    status: 'done';
    url: string;
    duration?: number;
} | {
    status: 'failed' | 'expired';
    detail?: string;
};
/**
 * Decode one poll response. A `done` payload without a video URL and an
 * unrecognized status both throw (the poll loop cannot make progress on
 * either).
 */
export declare function parseVideoStatusResponse(payload: unknown): VideoStatus;
/** Directory the downloaded MP4 files are written to. */
export declare function videosDirectory(): string;
/**
 * Build the `video_generate` tool definition.
 * @param options - grok session source, fetch implementation, and video directory.
 * @returns the tool to register on `ctx.tools`.
 */
export declare function createVideoGenerateTool(options: VideoGenerateToolOptions): ToolDefinition;
