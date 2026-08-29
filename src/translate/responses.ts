/**
 * Translate between the harness message vocabulary and the OpenAI Responses
 * API wire format shared by the codex and grok providers: request input
 * assembly, tool schema mapping, and a push-model SSE-event → StreamChunk
 * state machine ({@link ResponsesStreamTranslator}) so tests need no streams.
 */

import {
  ToolCallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  StreamChunk,
  TokenUsage,
  ToolResultBlock,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { parseSse } from './sse.js'
import type { TranslatableMessage } from './resolved.js'

/** Assembled `instructions` + `input` pair for one Responses request. */
export interface ResponsesRequestInput {
  /** System text for the top-level `instructions` field; absent when there is none. */
  instructions?: string
  /** Responses `input` items in conversation order. */
  input: Record<string, unknown>[]
}

/**
 * One COMPLETED reasoning output item captured off a response, replayed as
 * the complete item on a later request of the same conversation. The
 * Responses input schema does not treat a reasoning item's `id` or
 * `summary` as optional — a bare `{ type, encrypted_content }` is not a
 * valid input item — so the capture keeps the item's gateway id (as it
 * arrived on the done event), its summary parts, its status, and the
 * encrypted payload. `encrypted_content` is the only required field here:
 * items without one are simply never captured.
 */
export interface ReasoningReplayItem {
  type: 'reasoning'
  /** The item's gateway id as it arrived on the done event. */
  id?: string
  /** Summary parts, passed through when the gateway disclosed them. */
  summary?: unknown[]
  /** Item lifecycle status, passed through when present (typically `completed`). */
  status?: string
  /** Encrypted reasoning payload; the reason the item is worth replaying. */
  encrypted_content: string
}

/** Flatten a tool result's content to plain text for `function_call_output`. */
function toolResultText(block: ToolResultBlock): string {
  return block.content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

/**
 * Convert harness messages into Responses `instructions` + `input` items.
 * System-role messages become `instructions`; an explicit `system` argument
 * wins over them when both exist. Reasoning blocks are never replayed in
 * their text form: a Responses model continuing past a tool call needs its
 * reasoning back as the provider's completed reasoning items (id, summary,
 * and the ENCRYPTED payload), so `reasoningFor` may resolve per-call
 * captured items, replayed ahead of the matching function_call item. Images
 * must arrive pre-resolved
 * ({@link TranslatableMessage}); an unresolved ImageBlock is skipped because
 * its bytes are unreachable here.
 * @param messages - ordered conversation messages with resolved images.
 * @param system - explicit system prompt, which takes precedence.
 * @param reasoningFor - resolves one tool call id to the COMPLETED reasoning
 *   items captured for it (id, summary, status, encrypted payload), replayed
 *   ahead of the matching function_call item, when the adapter kept them.
 * @returns request fields ready to merge into the request body.
 */
export function toResponsesInput(
  messages: readonly TranslatableMessage[],
  system?: string,
  reasoningFor?: (callId: string) => readonly ReasoningReplayItem[] | undefined,
): ResponsesRequestInput {
  const input: Record<string, unknown>[] = []
  const systemTexts: string[] = []
  // [2026-08-23]-[reasoning models lose their chain of thought across a tool
  // round trip unless the completed reasoning items ride back in; dedupe by
  // ARRAY REFERENCE so parallel calls of one response (which share one array
  // instance) replay the items once, before the first of them]
  let lastReplay: readonly ReasoningReplayItem[] | undefined
  for (const message of messages) {
    if (message.role === 'system') {
      for (const block of message.content) {
        if (block.type === 'text') systemTexts.push(block.text)
      }
      continue
    }
    const role = message.role
    let content: Record<string, unknown>[] = []
    const flushMessage = (): void => {
      if (content.length === 0) return
      input.push({ type: 'message', role, content })
      content = []
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text })
          break
        case 'tool-call': {
          flushMessage()
          const encrypted = reasoningFor?.(String(block.id))
          if (encrypted !== undefined && encrypted !== lastReplay) {
            for (const item of encrypted) {
              input.push({
                type: 'reasoning',
                ...item.id === undefined ? {} : { id: item.id },
                ...item.summary === undefined ? {} : { summary: item.summary },
                ...item.status === undefined ? {} : { status: item.status },
                encrypted_content: item.encrypted_content,
              })
            }
            lastReplay = encrypted
          }
          input.push({
            type: 'function_call',
            call_id: String(block.id),
            name: block.name,
            arguments: block.arguments,
          })
          break
        }
        case 'tool-result':
          flushMessage()
          input.push({
            type: 'function_call_output',
            call_id: String(block.toolCallId),
            output: toolResultText(block),
          })
          break
        case 'image':
          if ('dataBase64' in block) {
            content.push({
              type: 'input_image',
              image_url: `data:${block.mediaType};base64,${block.dataBase64}`,
            })
          }
          // An unresolved ImageBlock carries only an attachment reference; the
          // adapter resolves images before translation, so this is skipped.
          break
        default:
          // reasoning's text form is not replayed (encrypted replay rides
          // reasoningFor), unknown blocks.
          break
      }
    }
    flushMessage()
  }
  const instructions = system ?? (systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined)
  return { ...instructions === undefined ? {} : { instructions }, input }
}

/**
 * Map harness tool schemas to Responses function tools.
 * @param tools - tool schemas from the request.
 * @returns Responses `tools` array entries.
 */
export function toResponsesTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

/** The subset of Responses SSE event shapes this translator reads. */
export interface ResponsesStreamEvent {
  type: string
  item_id?: string
  /**
   * Position of the event's item in the response's output array. The spec
   * carries it on output_item/delta events; Copilot's adapter uses it as the
   * stable item correlator when the gateway mints fresh ids per event.
   */
  output_index?: number
  content_index?: number
  summary_index?: number
  delta?: string
  item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    /** Encrypted reasoning payload, present when the request asked to include it. */
    encrypted_content?: string
    /** Summary parts of a completed reasoning item, when the gateway disclosed them. */
    summary?: unknown[]
    /** Item lifecycle status (e.g. `completed`), when present. */
    status?: string
    content?: Array<{ type?: string; text?: string }>
  }
  response?: {
    status?: string
    usage?: ResponsesUsage
    error?: { code?: string; message?: string }
    incomplete_details?: { reason?: string }
  }
  code?: string
  message?: string
}

/** Responses `usage` object shape. */
export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

/**
 * Map Responses usage to disjoint harness counts (cached input is subtracted
 * out of `inputTokens` and reported as `cacheReadTokens`).
 * @param usage - wire usage from `response.completed`.
 * @returns harness token usage.
 */
export function mapResponsesUsage(usage: ResponsesUsage): TokenUsage {
  const cached = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.input_tokens - (cached ?? 0),
    outputTokens: usage.output_tokens,
    ...cached !== undefined ? { cacheReadTokens: cached } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/**
 * Classify a Responses failure payload into a thrown LlmError.
 * @param code - provider error code, when present.
 * @param message - provider error message, when present.
 * @returns the mapped error (context overflow, quota, otherwise SERVER).
 */
export function responsesFailure(code: string | undefined, message: string | undefined): LlmError {
  const text = message ?? code ?? 'the provider reported a failed response'
  const detail = `${code ?? ''} ${message ?? ''}`
  if (code === 'context_window_exceeded' || isContextWindowExceededError(detail)) {
    return new LlmError(text, CONTEXT_WINDOW_EXCEEDED_CODE)
  }
  if ((code !== undefined && /insufficient|quota/i.test(code)) || isQuotaExceededError(detail)) {
    return new LlmError(text, QUOTA_EXCEEDED_CODE)
  }
  return new LlmError(text, 'SERVER')
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
 * Push-model Responses SSE translator: feed each parsed event object to
 * {@link push} and collect the emitted harness StreamChunks. Block indexes
 * are allocated in first-seen order; `usage` is emitted before the terminal
 * `finish`, and nothing is emitted after it. Terminal provider failures
 * throw {@link LlmError}.
 */
export class ResponsesStreamTranslator {
  private blocks = new Map<string, OpenBlock>()
  private order: OpenBlock[] = []
  private nextIndex = 0
  private sawToolCall = false
  /** Set once `response.completed` produced the terminal finish chunk. */
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

  private textBlock(key: string, chunks: StreamChunk[]): OpenBlock {
    return this.blocks.get(key) ?? this.open(key, 'text', chunks)
  }

  private reasoningBlock(key: string, chunks: StreamChunk[]): OpenBlock {
    return this.blocks.get(key) ?? this.open(key, 'reasoning', chunks)
  }

  private close(key: string, chunks: StreamChunk[]): void {
    const block = this.blocks.get(key)
    if (block === undefined) return
    this.blocks.delete(key)
    chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
  }

  /** Close every still-open block for one output item (prefix match on the key). */
  private closeItem(itemId: string, chunks: StreamChunk[]): void {
    for (const key of [...this.blocks.keys()]) {
      if (key.startsWith(`${itemId}:`)) this.close(key, chunks)
    }
  }

  /** Close every still-open block (provider ended the response without done events). */
  private closeAll(chunks: StreamChunk[]): void {
    for (const block of this.order) this.closeKeyIfOpen(block, chunks)
  }

  private closeKeyIfOpen(block: OpenBlock, chunks: StreamChunk[]): void {
    for (const [key, candidate] of this.blocks) {
      if (candidate === block) {
        this.blocks.delete(key)
        chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
        return
      }
    }
  }

  /**
   * Process one parsed Responses SSE event.
   * @param event - the parsed event object.
   * @returns the StreamChunks this event produced (possibly none).
   */
  push(event: ResponsesStreamEvent): StreamChunk[] {
    if (this.terminated) return []
    const chunks: StreamChunk[] = []
    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call' && item.id !== undefined) {
          this.sawToolCall = true
          const callId = item.call_id ?? ''
          const block = this.open(`${item.id}:call`, 'tool-call', chunks, callId, item.name)
          chunks.push({
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(callId),
            ...item.name === undefined ? {} : { name: item.name },
            argumentsDelta: '',
          })
        }
        return chunks
      }
      case 'response.output_text.delta': {
        const key = `${event.item_id ?? ''}:text:${String(event.content_index ?? 0)}`
        const block = this.textBlock(key, chunks)
        block.text += event.delta ?? ''
        chunks.push({ type: 'text-delta', index: block.index, text: event.delta ?? '' })
        return chunks
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const sub = event.summary_index ?? event.content_index ?? 0
        const key = `${event.item_id ?? ''}:reason:${String(sub)}`
        const block = this.reasoningBlock(key, chunks)
        block.text += event.delta ?? ''
        chunks.push({ type: 'reasoning-delta', index: block.index, text: event.delta ?? '' })
        return chunks
      }
      case 'response.function_call_arguments.delta': {
        const key = `${event.item_id ?? ''}:call`
        let block = this.blocks.get(key)
        if (block === undefined) {
          // The item.added event was missed; open the block from the delta alone.
          this.sawToolCall = true
          block = this.open(key, 'tool-call', chunks)
        }
        block.text += event.delta ?? ''
        chunks.push({
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId),
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: event.delta ?? '',
        })
        return chunks
      }
      case 'response.output_item.done': {
        const item = event.item
        if (item === undefined || item.id === undefined) return chunks
        if (item.type === 'function_call') {
          const key = `${item.id}:call`
          // The provider may deliver the complete arguments only on done.
          const block = this.blocks.get(key)
          if (block !== undefined && block.text.length === 0 && item.arguments !== undefined) {
            block.text = item.arguments
          }
          this.close(key, chunks)
        } else if (item.type === 'message') {
          if (![...this.blocks.keys()].some(key => key.startsWith(`${item.id}:text:`))) {
            // No deltas arrived for this item; synthesize blocks from the done payload.
            for (const [partIndex, part] of (item.content ?? []).entries()) {
              if (part?.type !== 'output_text' || typeof part.text !== 'string' || part.text.length === 0) continue
              const block = this.open(`${item.id}:text:${partIndex}`, 'text', chunks)
              block.text = part.text
              this.close(`${item.id}:text:${partIndex}`, chunks)
            }
          }
          this.closeItem(item.id, chunks)
        } else {
          this.closeItem(item.id, chunks)
        }
        return chunks
      }
      case 'response.completed': {
        this.terminated = true
        this.closeAll(chunks)
        const usage = event.response?.usage
        if (usage !== undefined) chunks.push({ type: 'usage', usage: mapResponsesUsage(usage) })
        if (this.order.length === 0) {
          chunks.push({
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
            },
          })
        } else {
          chunks.push({ type: 'finish', reason: { kind: this.sawToolCall ? 'tool-calls' : 'stop' } })
        }
        return chunks
      }
      case 'response.failed':
        throw responsesFailure(event.response?.error?.code, event.response?.error?.message)
      case 'response.incomplete':
        throw responsesFailure(
          event.response?.incomplete_details?.reason,
          event.response?.error?.message
            ?? `the provider reported an incomplete response (${event.response?.incomplete_details?.reason ?? 'unknown reason'})`,
        )
      case 'error':
        throw responsesFailure(event.code, event.message)
      default:
        // response.created, response.in_progress, content_part events, etc.: no chunks.
        return chunks
    }
  }
}

/**
 * Consume a Responses SSE byte stream and yield harness StreamChunks.
 * @param stream - raw response body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @param transform - optional per-event rewrite applied before translation
 *   (Copilot's gateway mints a fresh item id per event; the adapter rewrites
 *   them into stable per-item keys).
 * @returns the chunk stream; throws when the stream ends before `response.completed`.
 */
export async function* streamResponses(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  transform?: (event: ResponsesStreamEvent) => ResponsesStreamEvent,
): AsyncGenerator<StreamChunk> {
  const translator = new ResponsesStreamTranslator()
  for await (const sseEvent of parseSse(stream, onActivity)) {
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(sseEvent.data) as ResponsesStreamEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    if (transform !== undefined) event = transform(event)
    yield* translator.push(event)
    if (translator.terminated) return
  }
  throw new LlmError('Responses SSE stream ended before response.completed', 'STREAM_CLOSED')
}
