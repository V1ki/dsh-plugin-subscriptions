/**
 * Translate between the harness message vocabulary and the OpenAI chat
 * completions wire format the Copilot provider speaks: request message/tool
 * assembly and a push-model SSE-chunk → StreamChunk state machine
 * ({@link ChatCompletionsStreamTranslator}) mirroring the Responses
 * translator, so tests need no streams.
 */

import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  StreamChunk,
  TokenUsage,
  ToolResultBlock,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { parseSse } from './sse.js'
import type { TranslatableMessage } from './resolved.js'

/** Flatten a tool result's content to plain text for a `tool` message. */
function toolResultText(block: ToolResultBlock): string {
  return block.content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

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
export function toChatMessages(
  messages: readonly TranslatableMessage[],
  system?: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const systemTexts: string[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      for (const block of message.content) {
        if (block.type === 'text') systemTexts.push(block.text)
      }
      continue
    }
    if (message.role === 'user') {
      // Tool results ride inside user-role messages; they become their own
      // `tool` messages while ordinary blocks accumulate into one user entry.
      let texts: string[] = []
      let parts: Record<string, unknown>[] = []
      const flushUser = (): void => {
        if (parts.length > 0) {
          if (texts.length > 0) parts.unshift({ type: 'text', text: texts.join('\n') })
          out.push({ role: 'user', content: parts })
        } else if (texts.length > 0) {
          out.push({ role: 'user', content: texts.join('\n') })
        }
        texts = []
        parts = []
      }
      for (const block of message.content) {
        switch (block.type) {
          case 'text':
            texts.push(block.text)
            break
          case 'image':
            if ('dataBase64' in block) {
              parts.push({
                type: 'image_url',
                image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` },
              })
            }
            break
          case 'tool-result':
            flushUser()
            out.push({
              role: 'tool',
              tool_call_id: String(block.toolCallId),
              content: toolResultText(block),
            })
            break
          default:
            break
        }
      }
      flushUser()
      continue
    }
    // assistant: text becomes content, tool calls become the tool_calls array.
    const texts: string[] = []
    const toolCalls: Record<string, unknown>[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          texts.push(block.text)
          break
        case 'tool-call':
          toolCalls.push({
            id: String(block.id),
            type: 'function',
            function: { name: block.name, arguments: block.arguments },
          })
          break
        default:
          // reasoning (not replayed), unknown blocks.
          break
      }
    }
    if (texts.length === 0 && toolCalls.length === 0) continue
    out.push({
      role: 'assistant',
      content: texts.join('\n'),
      ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    })
  }
  const systemText = system ?? (systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined)
  if (systemText !== undefined) out.unshift({ role: 'system', content: systemText })
  return out
}

/**
 * Map harness tool schemas to chat completions function tools.
 * @param tools - tool schemas from the request.
 * @returns the wire `tools` array.
 */
export function toChatTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/** The subset of chat-completion chunk shapes this translator reads. */
export interface ChatCompletionsStreamEvent {
  choices?: {
    index?: number
    delta?: {
      content?: string | null
      role?: string
      reasoning_content?: string | null
      /** Copilot's Gemini models stream thinking as `reasoning_text`. */
      reasoning_text?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: ChatCompletionsUsage | null
}

/** Chat completions `usage` object shape. */
export interface ChatCompletionsUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/**
 * Map chat completions usage to disjoint harness counts (cached input is
 * subtracted out of `inputTokens` and reported as `cacheReadTokens`).
 * @param usage - wire usage from the terminal chunk.
 * @returns harness token usage.
 */
export function mapChatCompletionsUsage(usage: ChatCompletionsUsage): TokenUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cached ?? 0),
    outputTokens: usage.completion_tokens,
    ...cached !== undefined ? { cacheReadTokens: cached } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** One open harness block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId: string
  name?: string
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: ToolCallId(block.callId),
        name: block.name ?? '',
        arguments: block.text,
      }
  }
}

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
export class ChatCompletionsStreamTranslator {
  /** Text/reasoning blocks keyed by kind; tool calls keyed by their wire index. */
  private blocks = new Map<string, OpenBlock>()
  private order: OpenBlock[] = []
  private nextIndex = 0
  private sawToolCall = false
  private pendingUsage: ChatCompletionsUsage | undefined
  private armedFinish: StreamChunk | undefined
  /** Set once the terminal finish chunk was emitted. */
  terminated = false

  private open(key: string, kind: OpenBlock['kind'], chunks: StreamChunk[], callId = '', name?: string): OpenBlock {
    const block: OpenBlock = {
      index: this.nextIndex++,
      kind,
      text: '',
      callId,
      ...name === undefined ? {} : { name },
    }
    this.blocks.set(key, block)
    this.order.push(block)
    chunks.push({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }

  private close(key: string, chunks: StreamChunk[]): void {
    const block = this.blocks.get(key)
    if (block === undefined) return
    this.blocks.delete(key)
    chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
  }

  private closeAll(chunks: StreamChunk[]): void {
    for (const key of [...this.blocks.keys()]) this.close(key, chunks)
  }

  /** Build the terminal finish chunk for one wire finish reason. */
  private finishChunk(finishReason: string | null | undefined): StreamChunk {
    if (this.order.length === 0) {
      return {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      }
    }
    switch (finishReason) {
      case 'tool_calls':
        return { type: 'finish', reason: { kind: 'tool-calls' } }
      case 'length':
        return { type: 'finish', reason: { kind: 'max-tokens' } }
      case 'content_filter':
        return {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'the response was blocked by the provider content filter', code: 'CONTENT_FILTER' },
          },
        }
      default:
        return { type: 'finish', reason: { kind: this.sawToolCall ? 'tool-calls' : 'stop' } }
    }
  }

  /** Usage, then the armed finish: the only order the harness accepts. */
  private drainTerminal(chunks: StreamChunk[]): void {
    if (this.pendingUsage !== undefined) {
      chunks.push({ type: 'usage', usage: mapChatCompletionsUsage(this.pendingUsage) })
      this.pendingUsage = undefined
    }
    if (this.armedFinish !== undefined) {
      chunks.push(this.armedFinish)
      this.armedFinish = undefined
      this.terminated = true
    }
  }

  /**
   * Process one parsed chat-completion chunk.
   * @param event - the parsed chunk object.
   * @returns the StreamChunks this event produced (possibly none).
   */
  push(event: ChatCompletionsStreamEvent): StreamChunk[] {
    if (this.terminated) return []
    const chunks: StreamChunk[] = []
    const usage = event.usage
    const hasUsage = usage !== undefined && usage !== null
    if (hasUsage) this.pendingUsage = usage
    const choice = event.choices?.[0]
    const delta = choice?.delta
    if (delta !== undefined) {
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        const block = this.blocks.get('content') ?? this.open('content', 'text', chunks)
        block.text += delta.content
        chunks.push({ type: 'text-delta', index: block.index, text: delta.content })
      }
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
        : typeof delta.reasoning_text === 'string' ? delta.reasoning_text
        : undefined
      if (reasoning !== undefined && reasoning.length > 0) {
        const block = this.blocks.get('reasoning') ?? this.open('reasoning', 'reasoning', chunks)
        block.text += reasoning
        chunks.push({ type: 'reasoning-delta', index: block.index, text: reasoning })
      }
      for (const call of delta.tool_calls ?? []) {
        const key = `call:${String(call.index ?? 0)}`
        let block = this.blocks.get(key)
        if (block === undefined) {
          this.sawToolCall = true
          block = this.open(key, 'tool-call', chunks, call.id ?? '', call.function?.name)
          chunks.push({
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(block.callId),
            ...block.name === undefined ? {} : { name: block.name },
            argumentsDelta: '',
          })
        }
        if (call.function?.arguments !== undefined && call.function.arguments.length > 0) {
          block.text += call.function.arguments
          chunks.push({
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(block.callId),
            argumentsDelta: call.function.arguments,
          })
        }
      }
    }
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      this.closeAll(chunks)
      // Only arm: usage must be emitted before the terminal finish, and it
      // may still arrive (OpenAI's trailing usage-only chunk) or may have
      // arrived in this very chunk (Gemini folds it in). The drain below or
      // flush() releases the pair.
      if (this.armedFinish === undefined) this.armedFinish = this.finishChunk(choice.finish_reason)
    }
    // Drain at the terminal point: this chunk carried usage AND either the
    // finish is armed (usage + finish pair complete — same chunk for Gemini,
    // trailing chunk for OpenAI) or the chunk is usage-only (no choices to
    // process). Mid-stream usage carriers (Gemini's zero-usage deltas) keep
    // their pendingUsage for a later drain; only the final real usage is
    // emitted.
    if (hasUsage && (this.armedFinish !== undefined || choice === undefined)) {
      this.drainTerminal(chunks)
    }
    return chunks
  }

  /**
   * Emit whatever the stream left pending (`[DONE]` or EOF without a final
   * usage chunk). Safe to call repeatedly.
   * @returns the remaining terminal chunks.
   */
  flush(): StreamChunk[] {
    const chunks: StreamChunk[] = []
    this.drainTerminal(chunks)
    return chunks
  }
}

/**
 * Consume a chat completions SSE byte stream and yield harness StreamChunks.
 * @param stream - raw response body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @returns the chunk stream; throws when the stream ends before any finish chunk.
 */
export async function* streamChatCompletions(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<StreamChunk> {
  const translator = new ChatCompletionsStreamTranslator()
  for await (const sseEvent of parseSse(stream, onActivity)) {
    if (sseEvent.data === '[DONE]') {
      yield* translator.flush()
      return
    }
    let event: ChatCompletionsStreamEvent
    try {
      event = JSON.parse(sseEvent.data) as ChatCompletionsStreamEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    yield* translator.push(event)
    if (translator.terminated) return
  }
  yield* translator.flush()
  if (!translator.terminated) {
    throw new LlmError('chat completions SSE stream ended before a finish chunk', 'STREAM_CLOSED')
  }
}
