/**
 * Translate between the harness message vocabulary and the Anthropic Messages
 * API wire format used by the claude provider: request message assembly, tool
 * schema mapping, and a push-model SSE-event → StreamChunk state machine
 * ({@link AnthropicStreamTranslator}) so tests need no streams.
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { TranslatableMessage } from './resolved.js';
/**
 * The Claude Code identity block. The subscription endpoint rejects requests
 * that do not present as Claude Code, so this block is REQUIRED as the first
 * system entry on every request.
 */
export declare const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Tags wrapping a mid-conversation system message where it sits in the history. */
export declare const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export declare const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
/**
 * How far apart consecutive message breakpoints sit, in content blocks.
 *
 * A breakpoint looks back at most 20 blocks for an entry an earlier request
 * wrote, so marks must stay closer than that: one agentic turn can append a
 * dozen tool_use/tool_result blocks at once, and a single trailing mark would
 * silently fall out of range and rebuild the whole prefix.
 */
export declare const CACHE_BLOCK_STRIDE = 15;
/**
 * Message breakpoints per request. Anthropic allows four in total and the
 * last `system` block takes the fourth, so three are left for the history —
 * enough to tolerate a turn appending roughly {@link CACHE_BLOCK_STRIDE} × 3
 * blocks before a read is lost.
 */
export declare const MESSAGE_CACHE_BREAKPOINTS = 3;
/**
 * How long Anthropic keeps a cache entry after its last use: five minutes
 * (the API default) or one hour. A one-hour entry is written at twice the base
 * input price instead of 1.25×, and reads cost the same either way.
 */
export type PromptCacheTtl = '5m' | '1h';
/** The API default; a marker at this TTL carries no `ttl` field at all. */
export declare const DEFAULT_PROMPT_CACHE_TTL: PromptCacheTtl;
/**
 * Build one `cache_control` marker.
 *
 * Five minutes is spelled by omitting `ttl`, so a request that does not opt in
 * stays byte-identical to what earlier releases sent.
 * @param ttl - cache lifetime; defaults to five minutes.
 * @returns a fresh marker object (callers attach it to one block each).
 */
export declare function cacheControl(ttl?: PromptCacheTtl): Record<string, unknown>;
/** One Anthropic request message. */
export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: Record<string, unknown>[];
}
/**
 * Convert harness messages into Anthropic messages. Consecutive same-role
 * messages merge into one message with multiple content blocks; tool results
 * arrive as user messages with `tool_result` blocks, which a merged user
 * message keeps in one leading run ({@link leadWithToolResults}); system-role
 * messages before the conversation starts are handled by
 * {@link toAnthropicSystem} and skipped here, while a later one rides in
 * place as a user-role `<system-reminder>` block.
 * Reasoning blocks are not replayed (v1). Images must arrive pre-resolved
 * ({@link TranslatableMessage}); an unresolved ImageBlock is skipped because
 * its bytes are unreachable here.
 * @param messages - ordered conversation messages with resolved images.
 * @returns Anthropic messages in conversation order.
 */
export declare function toAnthropicMessages(messages: readonly TranslatableMessage[]): AnthropicMessage[];
/**
 * Mark the conversation's cache breakpoints in place: the last content block,
 * then one every {@link CACHE_BLOCK_STRIDE} blocks backwards, {@link
 * MESSAGE_CACHE_BREAKPOINTS} in total.
 *
 * The history is append-only, so the block one request marks last is
 * byte-identical in the next — that entry is what the next request reads.
 * Marks are counted across the flattened block sequence, not per message,
 * because the lookback window Anthropic walks counts blocks the same way.
 * @param messages - assembled Anthropic messages, marked in place.
 * @param ttl - cache lifetime for every mark; defaults to five minutes.
 */
export declare function markMessageCache(messages: readonly AnthropicMessage[], ttl?: PromptCacheTtl): void;
/**
 * Build the Anthropic `system` array: the mandatory Claude Code identity
 * block, then the explicit system prompt, then any system-role messages.
 * @param system - explicit system prompt, when set.
 * @param messages - conversation messages; the system-role text preceding the
 * conversation is appended, and a later one is left to {@link toAnthropicMessages}.
 * @param ttl - cache lifetime for the tools+system mark; defaults to five minutes.
 * @returns the system content blocks.
 */
export declare function toAnthropicSystem(system?: string, messages?: readonly TranslatableMessage[], ttl?: PromptCacheTtl): Record<string, unknown>[];
/**
 * Map harness tool schemas to Anthropic tools, in name order.
 *
 * `tools` renders at position 0 of the cached prefix, so any reordering
 * invalidates every cache entry behind it — `system` and the whole
 * conversation included. Registration order belongs to the caller and plugin
 * load order can differ between processes, so the wire order is fixed here
 * instead. Anthropic selects a tool by name; the array order carries nothing.
 * @param tools - tool schemas from the request.
 * @returns Anthropic `tools` array entries, ordered by tool name.
 */
export declare function toAnthropicTools(tools: readonly ToolSchema[]): Record<string, unknown>[];
/** The subset of Anthropic SSE event shapes this translator reads. */
export interface AnthropicStreamEvent {
    type: string;
    index?: number;
    message?: {
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
    };
    content_block?: {
        type?: string;
        id?: string;
        name?: string;
    };
    delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
        stop_reason?: string;
    };
    usage?: {
        output_tokens?: number;
    };
    error?: {
        type?: string;
        message?: string;
    };
}
/**
 * Classify an Anthropic `error` event into a thrown LlmError.
 * @param error - the wire error object.
 * @returns the mapped error.
 */
export declare function anthropicFailure(error: {
    type?: string;
    message?: string;
} | undefined): LlmError;
/**
 * Push-model Anthropic SSE translator: feed each parsed event object to
 * {@link push} and collect the emitted harness StreamChunks. Block indexes
 * are allocated in first-seen order; `usage` is emitted before the terminal
 * `finish`, and nothing is emitted after it. `error` events throw
 * {@link LlmError}.
 */
export declare class AnthropicStreamTranslator {
    private blocks;
    private nextIndex;
    private sawAnyBlock;
    private pendingUsage;
    private outputTokens;
    private stopReason;
    private usageEmitted;
    /** Set once `message_stop` produced the terminal finish chunk. */
    terminated: boolean;
    private open;
    private emitUsage;
    /**
     * Process one parsed Anthropic SSE event.
     * @param event - the parsed event object.
     * @returns the StreamChunks this event produced (possibly none).
     */
    push(event: AnthropicStreamEvent): StreamChunk[];
}
/**
 * Consume an Anthropic SSE byte stream and yield harness StreamChunks.
 * @param stream - raw response body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @returns the chunk stream; throws when the stream ends before `message_stop`.
 */
export declare function streamAnthropic(stream: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<StreamChunk>;
