/**
 * `x_search` tool: run xAI's hosted X (Twitter) search through the grok
 * subscription's OAuth session. The wire call is a non-streaming Responses
 * request carrying the built-in `x_search` tool definition; the canonical
 * output is `{ answer, citations }`.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GrokSession } from '../auth/store.js';
import { AccountTokenManager } from '../providers/accounts.js';
import type { FetchFn } from '../providers/common.js';
/** Endpoint the search request is posted to. */
export declare const X_SEARCH_URL = "https://api.x.ai/v1/responses";
/** Grok model the search runs on (a catalog model of the grok provider). */
export declare const X_SEARCH_MODEL = "grok-4";
/** Dependencies of the `x_search` tool. */
export interface XSearchToolOptions {
    /** Grok session source; a missing session throws the log-in hint. */
    tokens: AccountTokenManager<GrokSession>;
    /** Fetch implementation (injectable for tests). */
    fetchFn?: FetchFn;
}
/** Normalized, validated arguments of one search call. */
interface XSearchRequest {
    query: string;
    tool: Record<string, unknown>;
}
/**
 * Validate and assemble the request facts from tool arguments. Throws plain
 * Errors for argument problems the schema DSL cannot express (non-empty
 * query, handle caps, mutually exclusive filters).
 */
export declare function buildXSearchRequest(args: {
    query: string;
    allowed_x_handles?: string[];
    excluded_x_handles?: string[];
    from_date?: string;
    to_date?: string;
    enable_image_understanding?: boolean;
    enable_video_understanding?: boolean;
}): XSearchRequest;
/** The canonical output of one successful search. */
interface XSearchOutput {
    answer: string;
    citations: string[];
}
/**
 * Extract the answer text and citation URLs from a Responses payload: the
 * `output_text` shortcut or message output parts for the answer, and both
 * top-level `citations` and inline `url_citation` annotations for sources.
 */
export declare function parseXSearchResponse(payload: unknown): XSearchOutput;
/**
 * Build the `x_search` tool definition.
 * @param options - grok session source and fetch implementation.
 * @returns the tool to register on `ctx.tools`.
 */
export declare function createXSearchTool(options: XSearchToolOptions): ToolDefinition;
export {};
