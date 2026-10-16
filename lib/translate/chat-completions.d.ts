/**
 * Translate between the harness message vocabulary and the OpenAI chat
 * completions wire format the Copilot provider speaks: request message/tool
 * assembly and a push-model SSE-chunk → StreamChunk state machine
 * ({@link ChatCompletionsStreamTranslator}) mirroring the Responses
 * translator, so tests need no streams.
 */
import type { StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { TranslatableMessage } from './resolved.js';
/**
 * Convert harness messages into chat completions `messages`. System-role
 * messages become one leading `system` message; an explicit `system` argument
 * wins over them when both exist. Reasoning blocks are not replayed (matching
 * the Responses translator). Images must arrive pre-resolved; an unresolved
 * ImageBlock is skipped because its bytes are unreachable here. A user message
 * carrying only text collapses to a plain string body (some endpoints still
 * reject content-part arrays); tool results become separate `tool` messages.
 * @param messages - ordered conversation messages with resolved images.
 * @param system - explicit system prompt, which takes precedence.
 * @returns the wire `messages` array.
 */
export declare function toChatMessages(messages: readonly TranslatableMessage[], system?: string): Record<string, unknown>[];
/**
 * Map harness tool schemas to chat completions function tools.
 * @param tools - tool schemas from the request.
 * @returns the wire `tools` array.
 */
export declare function toChatTools(tools: readonly ToolSchema[]): Record<string, unknown>[];
/** The subset of chat-completion chunk shapes this translator reads. */
export interface ChatCompletionsStreamEvent {
    choices?: {
        index?: number;
        delta?: {
            content?: string | null;
            role?: string;
            reasoning_content?: string | null;
            /** Copilot's Gemini models stream thinking as `reasoning_text`. */
            reasoning_text?: string | null;
            tool_calls?: {
                index?: number;
                id?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }[];
        };
        finish_reason?: string | null;
    }[];
    usage?: ChatCompletionsUsage | null;
}
/** Chat completions `usage` object shape. */
export interface ChatCompletionsUsage {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
}
/**
 * Map chat completions usage to disjoint harness counts (cached input is
 * subtracted out of `inputTokens` and reported as `cacheReadTokens`).
 * @param usage - wire usage from the terminal chunk.
 * @returns harness token usage.
 */
export declare function mapChatCompletionsUsage(usage: ChatCompletionsUsage): TokenUsage;
/**
 * Push-model chat completions SSE translator: feed each parsed chunk object
 * to {@link push} and collect the emitted harness StreamChunks. The terminal
 * `finish_reason` chunk closes every block but only ARMS the finish chunk —
 * usage must precede the terminal finish, and where usage lives differs by
 * upstream: OpenAI-style streams send a trailing usage-only chunk
 * (stream_options.include_usage), while Copilot's Gemini models attach a
 * (zero) usage object to EVERY chunk and fold the real usage into the
 * finish chunk itself. A chunk therefore never early-returns on `usage`
 * alone: its deltas are always processed, and the terminal pair is drained
 * when the finish is armed and usage arrived (or when a usage-only chunk
 * follows an armed finish). `flush()` emits whatever remains when the
 * stream's `[DONE]` (or EOF) arrives.
 */
export declare class ChatCompletionsStreamTranslator {
    /** Text/reasoning blocks keyed by kind; tool calls keyed by their wire index. */
    private blocks;
    private order;
    private nextIndex;
    private sawToolCall;
    private pendingUsage;
    private armedFinish;
    /** Set once the terminal finish chunk was emitted. */
    terminated: boolean;
    private open;
    private close;
    private closeAll;
    /** Build the terminal finish chunk for one wire finish reason. */
    private finishChunk;
    /** Usage, then the armed finish: the only order the harness accepts. */
    private drainTerminal;
    /**
     * Process one parsed chat-completion chunk.
     * @param event - the parsed chunk object.
     * @returns the StreamChunks this event produced (possibly none).
     */
    push(event: ChatCompletionsStreamEvent): StreamChunk[];
    /**
     * Emit whatever the stream left pending (`[DONE]` or EOF without a final
     * usage chunk). Safe to call repeatedly.
     * @returns the remaining terminal chunks.
     */
    flush(): StreamChunk[];
}
/**
 * Consume a chat completions SSE byte stream and yield harness StreamChunks.
 * @param stream - raw response body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @returns the chunk stream; throws when the stream ends before any finish chunk.
 */
export declare function streamChatCompletions(stream: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<StreamChunk>;
