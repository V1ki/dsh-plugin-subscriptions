/**
 * DeepSeek Harness message/tool vocabulary to Antigravity's Gemini-shaped
 * v1internal request envelope, plus response/SSE translation back to the
 * harness streaming contract.
 */
import type { GenerateOptions, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { TranslatableMessage } from './resolved.js';
/** Minimal Gemini part shape used by v1internal. */
export interface AntigravityPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    inlineData?: {
        mimeType: string;
        data: string;
    };
    functionCall?: {
        id?: string;
        name?: string;
        args?: unknown;
    };
    functionResponse?: {
        id: string;
        name: string;
        response: Record<string, unknown>;
    };
}
/** Full Antigravity request envelope. */
export interface AntigravityRequest {
    project: string;
    requestId: string;
    model: string;
    userAgent: 'antigravity';
    requestType: 'agent';
    request: {
        contents: {
            role: 'user' | 'model';
            parts: AntigravityPart[];
        }[];
        sessionId: string;
        systemInstruction?: {
            parts: {
                text: string;
            }[];
        };
        tools?: {
            functionDeclarations: Record<string, unknown>[];
        }[];
        toolConfig?: {
            functionCallingConfig: {
                mode: 'VALIDATED';
            };
        };
        generationConfig?: Record<string, unknown>;
    };
}
/** Map harness tool schemas to Gemini function declarations. */
export declare function toAntigravityTools(tools: readonly ToolSchema[], model?: string): {
    functionDeclarations: Record<string, unknown>[];
}[];
/**
 * Convert resolved harness messages into Gemini contents. Function response
 * names are recovered from prior tool calls because DSH correlates results by
 * id while the Gemini wire requires both id and name.
 */
export declare function toAntigravityContents(messages: readonly TranslatableMessage[], model?: string): {
    role: 'user' | 'model';
    parts: AntigravityPart[];
}[];
/**
 * Build one v1internal generateContent/streamGenerateContent request.
 * When forStreaming is true and the model is Claude, caps maxOutputTokens at 64000
 * to avoid INVALID_ARGUMENT errors.
 */
export declare function toAntigravityRequest(options: GenerateOptions, messages: readonly TranslatableMessage[], projectId: string, forStreaming?: boolean): AntigravityRequest;
/** Antigravity SSE/non-stream response subset. */
export interface AntigravityResponseEvent {
    response?: {
        candidates?: {
            content?: {
                parts?: AntigravityPart[];
            };
            finishReason?: string;
        }[];
        usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            thoughtsTokenCount?: number;
            totalTokenCount?: number;
            cachedContentTokenCount?: number;
        };
    };
}
/** Map Gemini usage metadata to the harness's disjoint counters. */
export declare function mapAntigravityUsage(metadata: NonNullable<NonNullable<AntigravityResponseEvent['response']>['usageMetadata']>): TokenUsage;
/** Push translator for both parsed SSE events and one non-stream response. */
export declare class AntigravityStreamTranslator {
    private blocks;
    private closed;
    private nextIndex;
    private sawContent;
    private sawToolCall;
    terminated: boolean;
    private open;
    private close;
    private closeAll;
    private finish;
    /** Process one decoded Antigravity response frame. */
    push(event: AntigravityResponseEvent): StreamChunk[];
}
/** Consume Antigravity's SSE response into the DSH streaming contract. */
export declare function streamAntigravity(stream: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<StreamChunk>;
/** Translate a non-stream generateContent response using the same state machine. */
export declare function parseAntigravityResponse(event: AntigravityResponseEvent): StreamChunk[];
