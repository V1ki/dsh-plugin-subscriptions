/**
 * Translate between the harness message vocabulary and the Anthropic Messages
 * API wire format used by the claude provider: request message assembly, tool
 * schema mapping, and a push-model SSE-event → StreamChunk state machine
 * ({@link AnthropicStreamTranslator}) so tests need no streams.
 */

import { createHash, type Hash } from 'node:crypto'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../compat.js'
import type {
  ContentBlock,
  ReplayEnvelope,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { parseSse } from './sse.js'
import type { ResolvedToolResultBlock, TranslatableBlock, TranslatableMessage } from './resolved.js'

/**
 * The Claude Code identity block. The subscription endpoint rejects requests
 * that do not present as Claude Code, so this block is REQUIRED as the first
 * system entry on every request.
 */
export const CLAUDE_CODE_IDENTITY = 'You are Claude Code, Anthropic\'s official CLI for Claude.'

/** Tags wrapping a mid-conversation system message where it sits in the history. */
export const SYSTEM_REMINDER_OPEN = '<system-reminder>'
export const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * How far apart consecutive message breakpoints sit, in content blocks.
 *
 * A breakpoint looks back at most 20 blocks for an entry an earlier request
 * wrote, so marks must stay closer than that: one agentic turn can append a
 * dozen tool_use/tool_result blocks at once, and a single trailing mark would
 * silently fall out of range and rebuild the whole prefix.
 */
export const CACHE_BLOCK_STRIDE = 15

/**
 * Message breakpoints per request. Anthropic allows four in total and the
 * last `system` block takes the fourth, so three are left for the history —
 * enough to tolerate a turn appending roughly {@link CACHE_BLOCK_STRIDE} × 3
 * blocks before a read is lost.
 */
export const MESSAGE_CACHE_BREAKPOINTS = 3

/**
 * How long Anthropic keeps a cache entry after its last use: five minutes
 * (the API default) or one hour. A one-hour entry is written at twice the base
 * input price instead of 1.25×, and reads cost the same either way.
 */
export type PromptCacheTtl = '5m' | '1h'

/** The API default; a marker at this TTL carries no `ttl` field at all. */
export const DEFAULT_PROMPT_CACHE_TTL: PromptCacheTtl = '5m'

/**
 * Build one `cache_control` marker.
 *
 * Five minutes is spelled by omitting `ttl`, so a request that does not opt in
 * stays byte-identical to what earlier releases sent.
 * @param ttl - cache lifetime; defaults to five minutes.
 * @returns a fresh marker object (callers attach it to one block each).
 */
export function cacheControl(ttl: PromptCacheTtl = DEFAULT_PROMPT_CACHE_TTL): Record<string, unknown> {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

/** One Anthropic request message. */
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Record<string, unknown>[]
}

/**
 * What a response's thinking is bound to, recorded with the response.
 *
 * Anthropic binds each returned `thinking` / `redacted_thinking` block to its
 * prefix (the top-level `system`, the set of `tools`, and everything before
 * the block in `messages`, thinking blocks and cache markers aside) and to the
 * thinking block that preceded it. A block sent back after its prefix changed
 * fails the server's check: it is silently dropped or the request is rejected
 * (HTTP 400), depending on the account. Recording the binding lets a later
 * request tell, before sending, which blocks are still valid. See
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#prefix-check
 */
export interface ThinkingBinding {
  /** {@link prefixDigest} of the request the response was produced for. */
  prefix: string
  /** {@link replayDigest} of the last thinking block that request sent; null when it sent none. */
  prev: string | null
  /**
   * Set on the response to a request sent after the API refused replayed
   * thinking: no thinking from before that response is sent again.
   */
  reset?: true
}

/**
 * Response-level part of the replay envelope this translator emits. The tag
 * keeps a history entry written by another adapter (or another envelope
 * shape) from being read as Anthropic thinking metadata, and a response
 * recorded without its binding is never replayed.
 */
export interface AnthropicReplayResponse extends Partial<ThinkingBinding> {
  kind: 'anthropic'
  version: 2
  /** {@link responseContentDigest} of the response's own non-thinking content, as streamed. */
  content?: string
}

/**
 * Per-block replay metadata, aligned with the emitted blocks: a `thinking`
 * block keeps its signature, a `redacted_thinking` block keeps its opaque
 * payload, and every other block needs nothing.
 */
export type AnthropicBlockReplay =
  | Record<string, never>
  | { signature: string }
  | { redactedData: string }

/** Harness text standing in for a `redacted_thinking` block, which carries no readable reasoning. */
export const REDACTED_THINKING_TEXT = '[Reasoning redacted]'

/** A short, stable identity for one thinking block's signature or redacted payload. */
export function replayDigest(opaque: string): string {
  return createHash('sha256').update(opaque, 'utf8').digest('base64url').slice(0, 22)
}

/** JSON with object keys sorted, so equal content always hashes equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort()
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A wire block as the prefix check sees it: cache markers are not part of the prefix. */
function prefixView(block: Record<string, unknown>): Record<string, unknown> {
  if (!('cache_control' in block)) return block
  const { cache_control: _marker, ...rest } = block
  return rest
}

/** Whether a wire block is a thinking block, which Anthropic does not accept a `cache_control` on. */
function isThinkingBlock(block: Record<string, unknown>): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

/**
 * Digest of the request-level part of every thinking block's prefix: the
 * `system` blocks, and the `tools` compared as a set (their order does not
 * matter to the check), without cache markers.
 * @param system - the request's `system` blocks.
 * @param tools - the request's `tools`, when it sends any.
 * @returns the digest each message-level prefix digest starts from.
 */
export function requestBaseDigest(
  system: readonly Record<string, unknown>[],
  tools: readonly Record<string, unknown>[] = [],
): string {
  const set = tools.map(tool => canonicalJson(prefixView(tool))).sort()
  return createHash('sha256')
    .update(canonicalJson(system.map(prefixView)))
    .update(`\u0000${set.join('\u0000')}`)
    .digest('base64url')
}

/** A running prefix digest: the request base, then each non-thinking block with its role. */
function prefixHash(base: string): Hash {
  return createHash('sha256').update(base)
}

function hashBlock(hash: Hash, role: string, block: Record<string, unknown>): void {
  hash.update(`\u0001${role}\u0000${canonicalJson(prefixView(block))}`)
}

function prefixDigest(hash: Hash): string {
  return hash.copy().digest('base64url').slice(0, 32)
}

/**
 * The wire block an assistant message's non-reasoning block is sent as;
 * undefined for blocks the Messages API does not accept there.
 */
function assistantWireBlock(block: TranslatableBlock | ContentBlock): Record<string, unknown> | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'tool-call':
      return { type: 'tool_use', id: String(block.id), name: block.name, input: parseToolInput(block.arguments) }
    case 'image':
      return 'dataBase64' in block
        ? { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 } }
        : undefined
    default:
      return undefined
  }
}

/**
 * Digest of one assistant response's non-thinking content in wire form. A
 * thinking block that follows text or a tool call of its own response is bound
 * to that content too, so replay also requires the stored response to be
 * unchanged.
 */
export function responseContentDigest(blocks: readonly (TranslatableBlock | ContentBlock)[]): string {
  const hash = createHash('sha256')
  for (const block of blocks) {
    const wire = assistantWireBlock(block)
    if (wire !== undefined) hash.update(`${canonicalJson(wire)}\u0000`)
  }
  return hash.digest('base64url').slice(0, 22)
}

/**
 * How one request replays thinking: the route and concrete model it targets
 * and the {@link requestBaseDigest} of its own `system` and `tools`.
 *
 * This plugin conservatively replays thinking only to the same concrete
 * provider, account and model that produced it (the account through
 * {@link streamAccountWithReplay}). Some models support cross-model thinking
 * replay; this plugin does not enable it.
 */
export interface ThinkingReplayContext {
  provider: string
  model: string
  base: string
  /** Send no thinking at all: the one-time fallback after the API refused replayed thinking. */
  disabled?: boolean
}

/** One stored reasoning block that could be replayed. */
interface ThinkingCandidate {
  /** The wire block to send. */
  block: Record<string, unknown>
  digest: string
  /** The thinking block it followed when produced; null for none. */
  predecessor: string | null
  /** Index into {@link ReplayHistory.responses}. */
  response: number
}

/** One stored response of this route and model with a readable envelope. */
interface StoredResponse {
  binding: Partial<ThinkingBinding>
  /** The response's own content is what it was when its thinking was produced. */
  contentIntact: boolean
  /** Running prefix digest where the response starts in this request (set while assembling). */
  prefixHere?: string
  /** Index of the wire message holding the response's first block (set while assembling). */
  wireMessage?: number
}

/** The replay metadata of one history, for one request. */
interface ReplayHistory {
  responses: StoredResponse[]
  candidates: ThinkingCandidate[]
  /** Response index of each assistant message (by message index) that has an envelope. */
  responseOf: Map<number, number>
  /** Candidate index of each replayable reasoning block, by message index then content position. */
  slots: Map<number, Map<number, number>>
}

/** Read the stored replay metadata of a history: responses of the request's own route and model only. */
function replayHistory(messages: readonly TranslatableMessage[], replay: ThinkingReplayContext | undefined): ReplayHistory {
  const history: ReplayHistory = { responses: [], candidates: [], responseOf: new Map(), slots: new Map() }
  if (replay === undefined) return history
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    const source = message.source
    if (source?.kind !== 'model' || source.provider !== replay.provider || source.model !== replay.model) continue
    const state = source.replayState
    if (state === null || typeof state !== 'object') continue
    const envelope = state as { response?: unknown; blocks?: unknown }
    const response = envelope.response as Partial<AnthropicReplayResponse> | null | undefined
    if (response === null || typeof response !== 'object' || response.kind !== 'anthropic' || response.version !== 2) continue
    const entries = envelope.blocks
    if (!Array.isArray(entries) || entries.length !== message.content.length) continue
    const binding: Partial<ThinkingBinding> = {
      ...typeof response.prefix === 'string' ? { prefix: response.prefix } : {},
      ...response.prev === null || typeof response.prev === 'string' ? { prev: response.prev } : {},
      ...response.reset === true ? { reset: true as const } : {},
    }
    const index = history.responses.push({
      binding,
      contentIntact: typeof response.content === 'string' && response.content === responseContentDigest(message.content),
    }) - 1
    history.responseOf.set(messageIndex, index)
    // The first thinking block followed whatever the request sent last; each
    // later one follows the previous thinking block of the same response.
    let predecessor: string | null | undefined = binding.prev
    const slots = new Map<number, number>()
    for (const [position, block] of message.content.entries()) {
      if (block.type !== 'reasoning') continue
      const entry = entries[position] as Record<string, unknown> | null | undefined
      let wire: Record<string, unknown> | undefined
      let digest: string | undefined
      if (entry !== null && typeof entry === 'object' && typeof entry.redactedData === 'string' && entry.redactedData.length > 0) {
        wire = { type: 'redacted_thinking', data: entry.redactedData }
        digest = replayDigest(entry.redactedData)
      } else if (entry !== null && typeof entry === 'object' && typeof entry.signature === 'string' && entry.signature.length > 0) {
        // The text goes back exactly as it was received, with its signature.
        wire = { type: 'thinking', thinking: block.text, signature: entry.signature }
        digest = replayDigest(entry.signature)
      }
      if (wire !== undefined && digest !== undefined && predecessor !== undefined) {
        slots.set(position, history.candidates.push({ block: wire, digest, predecessor, response: index }) - 1)
      }
      // An unsigned block breaks the chain: nothing after it in this response can be placed.
      predecessor = digest
    }
    if (slots.size > 0) history.slots.set(messageIndex, slots)
  }
  return history
}

/**
 * Pick the thinking blocks to send.
 *
 * The API accepts a replayed block only when its prefix is what it was when the
 * block was produced, and when the thinking block sent right before it is the
 * one it followed. The blocks kept must be an unbroken run of the original
 * sequence: the oldest or the newest may be left out, a middle one may not,
 * and one left out must stay out, because later blocks were produced without
 * it. So the run starts at the newest block whose prefix still matches and
 * follows each block's recorded predecessor backwards, stopping at the first
 * block that is missing, changed, or older than a refusal.
 * @returns the candidate indexes to send.
 */
function selectThinking(history: ReplayHistory, replay: ThinkingReplayContext | undefined): Set<number> {
  const chosen = new Set<number>()
  if (replay === undefined || replay.disabled === true) return chosen
  let barrier = -1
  for (const [index, response] of history.responses.entries()) if (response.binding.reset === true) barrier = index
  const usable = (index: number): boolean => {
    const candidate = history.candidates[index]
    const response = history.responses[candidate.response]
    return candidate.response >= barrier && response.contentIntact
      && response.binding.prefix !== undefined && response.binding.prefix === response.prefixHere
  }
  let at = -1
  for (let index = history.candidates.length - 1; index >= 0; index--) if (usable(index)) { at = index; break }
  while (at >= 0) {
    chosen.add(at)
    const predecessor = history.candidates[at].predecessor
    if (predecessor === null) break
    let previous = -1
    for (let earlier = at - 1; earlier >= 0; earlier--) {
      if (history.candidates[earlier].digest === predecessor) { previous = earlier; break }
    }
    at = previous !== -1 && usable(previous) ? previous : -1
  }
  return chosen
}

/**
 * Whether an HTTP failure is the API refusing a replayed thinking block:
 * ``messages.N.content.M: Invalid `signature` in `thinking` block`` (a
 * signature it cannot verify, or one bound to a different prefix) or an
 * invalid `redacted_thinking` payload. Resending the same body fails the same
 * way; dropping the replayed thinking does not.
 */
export function isRefusedThinkingError(error: LlmError): boolean {
  return error.failure.status === 400
    && /Invalid `(?:signature|data)` in `(?:redacted_)?thinking` block/.test(error.message)
}

/** The messages to send, plus the binding the response to them must record. */
export interface AnthropicMessagesAssembly {
  messages: AnthropicMessage[]
  binding: ThinkingBinding
  /** How many thinking / redacted_thinking blocks are replayed. */
  replayedThinking: number
}

/** Preserve native image blocks, retaining the existing text-only wire shape. */
function toolResultContent(block: ResolvedToolResultBlock): string | Record<string, unknown>[] {
  if (!block.content.some(part => part.type === 'image' && 'dataBase64' in part)) {
    return block.content.map(part => (part.type === 'text' ? part.text : '')).join('')
  }
  const content: Record<string, unknown>[] = []
  for (const part of block.content) {
    if (part.type === 'text' && part.text.length > 0) content.push({ type: 'text', text: part.text })
    if (part.type === 'image' && 'dataBase64' in part) {
      content.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 } })
    }
  }
  return content
}

/** Parse a tool call's raw JSON arguments into Anthropic's object-shaped `input`. */
function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    // The model produced malformed JSON; an empty object keeps the request valid.
    return {}
  }
}

/**
 * Move a user message's `tool_result` blocks into one contiguous run at the
 * front, preserving the relative order of both groups.
 *
 * Anthropic answers every `tool_use` against the blocks that *lead* the next
 * message, so a block of any other kind before or between the results reads
 * as a call left unanswered and the request is rejected. The harness merges
 * everything queued for one user turn into a single message, and a parallel
 * tool batch arrives as one result message per call, so any context spliced
 * mid-batch lands between two results. Restoring the run here keeps that
 * independent of delivery order. Order *among* the results does not matter.
 * @param message - one assembled user message, reordered in place.
 */
function leadWithToolResults(message: AnthropicMessage): void {
  const firstOther = message.content.findIndex(block => block.type !== 'tool_result')
  if (firstOther === -1) return
  if (!message.content.slice(firstOther).some(block => block.type === 'tool_result')) return
  message.content = [
    ...message.content.filter(block => block.type === 'tool_result'),
    ...message.content.filter(block => block.type !== 'tool_result'),
  ]
}

/**
 * Index of the first non-system message; `messages.length` when every message
 * is a system one.
 *
 * A system message before the conversation starts is the operator's opening
 * instruction and belongs in the `system` slot. One that arrives later is
 * mid-conversation context, and hoisting it into `system` would move bytes in
 * front of the whole history — invalidating every cached turn behind it — so
 * it stays where it is, as a reminder block in `messages`.
 * @param messages - ordered conversation messages.
 * @returns the boundary index separating the two.
 */
function conversationStart(messages: readonly TranslatableMessage[]): number {
  const index = messages.findIndex(message => message.role !== 'system')
  return index === -1 ? messages.length : index
}

/**
 * Convert harness messages into Anthropic messages. Consecutive same-role
 * messages merge into one message with multiple content blocks; tool results
 * arrive as user messages with `tool_result` blocks, which a merged user
 * message keeps in one leading run ({@link leadWithToolResults}); system-role
 * messages before the conversation starts are handled by
 * {@link toAnthropicSystem} and skipped here, while a later one rides in
 * place as a user-role `<system-reminder>` block.
 * Images must arrive pre-resolved ({@link TranslatableMessage}); an
 * unresolved ImageBlock is skipped because its bytes are unreachable here.
 *
 * Reasoning blocks are replayed as signed `thinking` / `redacted_thinking`
 * blocks, in their original position, only for responses of the request's
 * own route and model whose binding still holds ({@link selectThinking}):
 * the prefix each was produced after is computed here from the request being
 * built, so a changed system prompt, tool set or earlier message drops the
 * thinking that depended on it while the rest of the history is sent as before.
 * @param messages - ordered conversation messages with resolved images.
 * @param replay - the request's route, model and request-level prefix;
 * omitted, no reasoning is replayed.
 * @returns the messages and the binding the response to them must record.
 */
export function assembleAnthropicMessages(
  messages: readonly TranslatableMessage[],
  replay?: ThinkingReplayContext,
): AnthropicMessagesAssembly {
  const history = replayHistory(messages, replay)
  const out: AnthropicMessage[] = []
  /** Placeholder object of each candidate, so the final position is known before choosing. */
  const placeholders = new Map<Record<string, unknown>, number>()
  const start = conversationStart(messages)
  for (const [index, message] of messages.entries()) {
    // A leading system message is an opening instruction; toAnthropicSystem
    // owns those. A later one rides here so the cached prefix ahead of it
    // stays byte-identical.
    if (message.role === 'system' && index < start) continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks: Record<string, unknown>[] = []
    if (message.role === 'tool') {
      const id = message.toolCallId ?? message.tool_call_id
        ?? (message.source?.kind === 'tool' ? String(message.source.callId) : undefined)
      if (id === undefined) throw new LlmError('tool result has no call id', 'INVALID_REQUEST')
      blocks.push({
        type: 'tool_result',
        tool_use_id: id,
        content: toolResultContent({ type: 'tool-result', toolCallId: ToolCallId(id), content: message.content }),
        ...message.isError === true ? { is_error: true } : {},
      })
      const last = out[out.length - 1]
      if (last?.role === 'user') last.content.push(...blocks)
      else out.push({ role: 'user', content: blocks })
      continue
    }
    const slots = history.slots.get(index)
    for (const [position, block] of message.content.entries()) {
      switch (block.type) {
        case 'reasoning': {
          const candidate = slots?.get(position)
          if (candidate !== undefined) {
            const placeholder: Record<string, unknown> = { type: 'thinking' }
            placeholders.set(placeholder, candidate)
            blocks.push(placeholder)
          }
          break
        }
        case 'text':
          blocks.push({
            type: 'text',
            text: message.role === 'system'
              ? `${SYSTEM_REMINDER_OPEN}${block.text}${SYSTEM_REMINDER_CLOSE}`
              : block.text,
          })
          break
        case 'tool-call':
          // Anthropic accepts `tool_use` only in assistant messages, and only
          // when a matching `tool_result` follows. A tool call in any other
          // role is replayed narrative — a settled subagent's closing message
          // spliced into the parent as a user-role notice carries the calls it
          // died holding, which no result will ever answer — so it rides as
          // descriptive text instead of a call the API would reject.
          blocks.push(role === 'assistant'
            ? assistantWireBlock(block) as Record<string, unknown>
            : { type: 'text', text: `[tool call ${block.name}: ${block.arguments}]` })
          break
        case 'tool-result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: String(block.toolCallId),
            content: toolResultContent(block),
            ...block.isError === true ? { is_error: true } : {},
          })
          break
        case 'image':
          if ('dataBase64' in block) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
            })
          }
          // An unresolved ImageBlock carries only an attachment reference; the
          // adapter resolves images before translation, so this is skipped.
          break
        default:
          // Unknown blocks carry nothing the Messages API accepts.
          break
      }
    }
    if (blocks.length === 0) continue
    const response = history.responseOf.get(index)
    const last = out[out.length - 1]
    if (last !== undefined && last.role === role) {
      // Merged into an earlier message: not where the response started when
      // it was produced, so its prefix cannot match.
      last.content.push(...blocks)
    } else {
      if (response !== undefined) history.responses[response]!.wireMessage = out.length
      out.push({ role, content: blocks })
    }
  }
  for (const message of out) {
    if (message.role === 'user') leadWithToolResults(message)
  }
  // The prefix of every position: the request base, then each message's role
  // and its non-thinking blocks, cache markers aside.
  const hash = prefixHash(replay?.base ?? '')
  const before: string[] = []
  for (const message of out) {
    before.push(prefixDigest(hash))
    hash.update(`\u0002${message.role}`)
    for (const block of message.content) if (!placeholders.has(block)) hashBlock(hash, message.role, block)
  }
  for (const response of history.responses) {
    if (response.wireMessage !== undefined) response.prefixHere = before[response.wireMessage]
  }
  const chosen = selectThinking(history, replay)
  let prev: string | null = null
  let replayed = 0
  for (const message of out) {
    message.content = message.content.flatMap(block => {
      const candidate = placeholders.get(block)
      if (candidate === undefined) return [block]
      if (!chosen.has(candidate)) return []
      replayed += 1
      prev = history.candidates[candidate]!.digest
      return [history.candidates[candidate]!.block]
    })
  }
  return {
    messages: out,
    binding: {
      prefix: prefixDigest(hash),
      prev: replay?.disabled === true ? null : prev,
      ...replay?.disabled === true ? { reset: true as const } : {},
    },
    replayedThinking: replayed,
  }
}

/**
 * Convert harness messages into Anthropic messages ({@link assembleAnthropicMessages}).
 * @param messages - ordered conversation messages with resolved images.
 * @param replay - the request's route, model and request-level prefix; omitted, no reasoning is replayed.
 * @returns Anthropic messages in conversation order.
 */
export function toAnthropicMessages(messages: readonly TranslatableMessage[], replay?: ThinkingReplayContext): AnthropicMessage[] {
  return assembleAnthropicMessages(messages, replay).messages
}

/**
 * Mark the conversation's cache breakpoints in place: the last content block,
 * then one every {@link CACHE_BLOCK_STRIDE} blocks backwards, {@link
 * MESSAGE_CACHE_BREAKPOINTS} in total.
 *
 * The history is append-only, so the block one request marks last is
 * byte-identical in the next — that entry is what the next request reads.
 * Marks are counted across the flattened block sequence, not per message,
 * because the lookback window Anthropic walks counts blocks the same way.
 *
 * Anthropic rejects a `cache_control` on a `thinking` or `redacted_thinking`
 * block (HTTP 400), so a mark that would land on one moves to the nearest
 * earlier block that can carry it; the prefix it caches still includes the
 * thinking block, which the next mark's lookback spans either way.
 * @param messages - assembled Anthropic messages, marked in place.
 * @param ttl - cache lifetime for every mark; defaults to five minutes.
 */
export function markMessageCache(messages: readonly AnthropicMessage[], ttl?: PromptCacheTtl): void {
  const blocks = messages.flatMap(message => message.content)
  let floor = blocks.length
  for (let mark = 0; mark < MESSAGE_CACHE_BREAKPOINTS; mark++) {
    let at = Math.min(blocks.length - 1 - mark * CACHE_BLOCK_STRIDE, floor - 1)
    while (at >= 0 && isThinkingBlock(blocks[at])) at -= 1
    if (at < 0) return
    blocks[at].cache_control = cacheControl(ttl)
    floor = at
  }
}

/**
 * Build the Anthropic `system` array: the mandatory Claude Code identity
 * block, then the explicit system prompt, then any system-role messages.
 * @param system - explicit system prompt, when set.
 * @param messages - conversation messages; the system-role text preceding the
 * conversation is appended, and a later one is left to {@link toAnthropicMessages}.
 * @param ttl - cache lifetime for the tools+system mark; defaults to five minutes.
 * @returns the system content blocks.
 */
export function toAnthropicSystem(
  system?: string,
  messages?: readonly TranslatableMessage[],
  ttl?: PromptCacheTtl,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }]
  if (system !== undefined && system.length > 0) blocks.push({ type: 'text', text: system })
  const history = messages ?? []
  for (const message of history.slice(0, conversationStart(history))) {
    for (const block of message.content) {
      if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    }
  }
  // `tools` renders ahead of `system`, so this one marker caches both. It is
  // deliberately separate from the message marks: a tool_choice or thinking
  // change invalidates the messages tier only, and this entry survives it.
  //
  // Anthropic processes `tools`, `system`, then `messages`, and rejects a
  // one-hour mark that follows a five-minute one (HTTP 400). This mark and the
  // message marks therefore share one TTL, which can never hit that ordering.
  blocks[blocks.length - 1].cache_control = cacheControl(ttl)
  return blocks
}

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
export function toAnthropicTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  return [...tools]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
}

/** The subset of Anthropic SSE event shapes this translator reads. */
export interface AnthropicStreamEvent {
  type: string
  index?: number
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  content_block?: {
    type?: string
    id?: string
    name?: string
    /** `thinking` blocks: text and signature may already be present at start. */
    thinking?: string
    signature?: string
    /** `redacted_thinking` blocks: the encrypted reasoning payload. */
    data?: string
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

/** One open harness block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId: string
  name?: string
  /** A `thinking` block's signature, accumulated from `signature_delta`. */
  signature?: string
  /** A `redacted_thinking` block's opaque payload. */
  redactedData?: string
}

/** The replay entry one closed block contributes to the finish envelope. */
function blockReplay(block: OpenBlock): AnthropicBlockReplay {
  if (block.kind !== 'reasoning') return {}
  if (block.redactedData !== undefined && block.redactedData.length > 0) return { redactedData: block.redactedData }
  if (block.signature !== undefined && block.signature.length > 0) return { signature: block.signature }
  return {}
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
 * Classify an Anthropic `error` event into a thrown LlmError.
 * @param error - the wire error object.
 * @returns the mapped error.
 */
export function anthropicFailure(error: { type?: string; message?: string } | undefined): LlmError {
  const type = error?.type ?? 'unknown_error'
  const message = error?.message ?? `Anthropic reported ${type}`
  if (type === 'invalid_request_error' && /prompt is too long/i.test(message)) {
    return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE)
  }
  if (type === 'rate_limit_error') return new LlmError(message, 'RATE_LIMIT')
  if (type === 'authentication_error') return new LlmError(message, 'AUTH')
  return new LlmError(message, 'SERVER')
}

/**
 * Push-model Anthropic SSE translator: feed each parsed event object to
 * {@link push} and collect the emitted harness StreamChunks. Block indexes
 * are allocated in first-seen order; `usage` is emitted before the terminal
 * `finish`, and nothing is emitted after it. `error` events throw
 * {@link LlmError}.
 */
export class AnthropicStreamTranslator {
  private blocks = new Map<number, OpenBlock>()
  /** Replay entry per emitted block, by harness index. */
  private replay: AnthropicBlockReplay[] = []
  /** Each emitted block, by harness index, for the response-content digest. */
  private emitted: ContentBlock[] = []
  /** Set once any block carries a signature or redacted payload worth replaying. */
  private sawSignedThinking = false
  private nextIndex = 0

  /**
   * @param binding - what the request this response answers is bound to
   * ({@link assembleAnthropicMessages}); without it the response's thinking
   * is recorded unbound and never replayed.
   */
  constructor(private readonly binding?: ThinkingBinding) {}
  private sawAnyBlock = false
  private pendingUsage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined
  private outputTokens: number | undefined
  private stopReason: 'stop' | 'tool-calls' | 'max-tokens' = 'stop'
  private usageEmitted = false
  /** Set once `message_stop` produced the terminal finish chunk. */
  terminated = false

  private open(wireIndex: number, kind: OpenBlock['kind'], chunks: StreamChunk[], callId = '', name?: string): OpenBlock {
    const block: OpenBlock = {
      index: this.nextIndex++,
      kind,
      text: '',
      callId,
      ...name === undefined ? {} : { name },
    }
    this.blocks.set(wireIndex, block)
    this.sawAnyBlock = true
    chunks.push({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }

  /** Emit one block's `block-end` and record its replay entry. */
  private close(block: OpenBlock, chunks: StreamChunk[]): void {
    const entry = blockReplay(block)
    if (Object.keys(entry).length > 0) this.sawSignedThinking = true
    this.replay[block.index] = entry
    const content = closeBlock(block)
    this.emitted[block.index] = content
    chunks.push({ type: 'block-end', index: block.index, block: content })
  }

  /**
   * The finish envelope: each thinking block's signature aligned with the
   * emitted blocks, plus the binding of the request it answered and a digest
   * of the response's own content. Absent when no block needs replay
   * metadata, so a response without signed thinking stores exactly what it
   * did before.
   */
  private replayState(): ReplayEnvelope | undefined {
    // A response to a request sent after a refusal records the refusal even
    // without thinking of its own, so older thinking is never resent.
    if (!this.sawSignedThinking && this.binding?.reset !== true) return undefined
    const blocks: AnthropicBlockReplay[] = []
    for (let index = 0; index < this.nextIndex; index++) blocks.push(this.replay[index] ?? {})
    const emitted = this.emitted.filter((block): block is ContentBlock => block !== undefined)
    const response: AnthropicReplayResponse = {
      kind: 'anthropic',
      version: 2,
      ...this.binding === undefined ? {} : {
        prefix: this.binding.prefix,
        prev: this.binding.prev,
        ...this.binding.reset === true ? { reset: true as const } : {},
      },
      content: responseContentDigest(emitted),
    }
    return { response, blocks }
  }

  private emitUsage(chunks: StreamChunk[]): void {
    if (this.usageEmitted) return
    this.usageEmitted = true
    const usage: TokenUsage = {
      inputTokens: this.pendingUsage?.inputTokens ?? 0,
      outputTokens: this.outputTokens ?? 0,
      ...this.pendingUsage?.cacheReadTokens !== undefined
        ? { cacheReadTokens: this.pendingUsage.cacheReadTokens }
        : {},
      ...this.pendingUsage?.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: this.pendingUsage.cacheWriteTokens }
        : {},
    }
    chunks.push({ type: 'usage', usage })
  }

  /**
   * Process one parsed Anthropic SSE event.
   * @param event - the parsed event object.
   * @returns the StreamChunks this event produced (possibly none).
   */
  push(event: AnthropicStreamEvent): StreamChunk[] {
    if (this.terminated) return []
    const chunks: StreamChunk[] = []
    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage
        if (usage !== undefined) {
          this.pendingUsage = {
            inputTokens: usage.input_tokens ?? 0,
            ...usage.cache_read_input_tokens !== undefined
              ? { cacheReadTokens: usage.cache_read_input_tokens }
              : {},
            ...usage.cache_creation_input_tokens !== undefined
              ? { cacheWriteTokens: usage.cache_creation_input_tokens }
              : {},
          }
          this.outputTokens = usage.output_tokens ?? this.outputTokens
        }
        return chunks
      }
      case 'content_block_start': {
        const wireIndex = event.index ?? 0
        const block = event.content_block
        switch (block?.type) {
          case 'text':
            this.open(wireIndex, 'text', chunks)
            break
          case 'thinking': {
            const opened = this.open(wireIndex, 'reasoning', chunks)
            // Both fields normally arrive empty and fill in through deltas;
            // keep whatever the start event already carries.
            if (typeof block.signature === 'string' && block.signature.length > 0) opened.signature = block.signature
            if (typeof block.thinking === 'string' && block.thinking.length > 0) {
              opened.text = block.thinking
              chunks.push({ type: 'reasoning-delta', index: opened.index, text: block.thinking })
            }
            break
          }
          case 'redacted_thinking': {
            // Encrypted reasoning: nothing readable to show, but the payload
            // must go back verbatim for the model to keep its reasoning.
            const opened = this.open(wireIndex, 'reasoning', chunks)
            opened.text = REDACTED_THINKING_TEXT
            if (typeof block.data === 'string') opened.redactedData = block.data
            chunks.push({ type: 'reasoning-delta', index: opened.index, text: REDACTED_THINKING_TEXT })
            break
          }
          case 'tool_use': {
            const opened = this.open(wireIndex, 'tool-call', chunks, block.id ?? '', block.name)
            chunks.push({
              type: 'tool-call-delta',
              index: opened.index,
              id: ToolCallId(opened.callId),
              ...block.name === undefined ? {} : { name: block.name },
              argumentsDelta: '',
            })
            break
          }
          default:
            break
        }
        return chunks
      }
      case 'content_block_delta': {
        const wireIndex = event.index ?? 0
        const block = this.blocks.get(wireIndex)
        const delta = event.delta
        if (block === undefined || delta === undefined) return chunks
        switch (delta.type) {
          case 'text_delta':
            block.text += delta.text ?? ''
            chunks.push({ type: 'text-delta', index: block.index, text: delta.text ?? '' })
            break
          case 'thinking_delta':
            block.text += delta.thinking ?? ''
            chunks.push({ type: 'reasoning-delta', index: block.index, text: delta.thinking ?? '' })
            break
          case 'input_json_delta':
            block.text += delta.partial_json ?? ''
            chunks.push({
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(block.callId),
              ...block.name === undefined ? {} : { name: block.name },
              argumentsDelta: delta.partial_json ?? '',
            })
            break
          case 'signature_delta':
            // Not harness content: the signature rides in the finish
            // envelope so the next request can replay this thinking block.
            if (block.kind === 'reasoning') block.signature = (block.signature ?? '') + (delta.signature ?? '')
            break
          default:
            // Future deltas carry no harness content.
            break
        }
        return chunks
      }
      case 'content_block_stop': {
        const wireIndex = event.index ?? 0
        const block = this.blocks.get(wireIndex)
        if (block === undefined) return chunks
        this.blocks.delete(wireIndex)
        this.close(block, chunks)
        return chunks
      }
      case 'message_delta': {
        if (event.usage?.output_tokens !== undefined) this.outputTokens = event.usage.output_tokens
        switch (event.delta?.stop_reason) {
          case 'end_turn':
          case 'stop_sequence':
            this.stopReason = 'stop'
            break
          case 'tool_use':
            this.stopReason = 'tool-calls'
            break
          case 'max_tokens':
            this.stopReason = 'max-tokens'
            break
          default:
            break
        }
        return chunks
      }
      case 'message_stop': {
        this.terminated = true
        for (const [wireIndex, block] of [...this.blocks]) {
          this.blocks.delete(wireIndex)
          this.close(block, chunks)
        }
        this.emitUsage(chunks)
        if (this.stopReason === 'stop' && !this.sawAnyBlock) {
          chunks.push({
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
            },
          })
        } else {
          const replayState = this.replayState()
          chunks.push({
            type: 'finish',
            reason: { kind: this.stopReason },
            ...replayState === undefined ? {} : { replayState },
          })
        }
        return chunks
      }
      case 'error':
        throw anthropicFailure(event.error)
      default:
        // ping and future event types carry no harness content.
        return chunks
    }
  }
}

/**
 * Consume an Anthropic SSE byte stream and yield harness StreamChunks.
 * @param stream - raw response body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @param binding - what the request is bound to, recorded with its thinking.
 * @returns the chunk stream; throws when the stream ends before `message_stop`.
 */
export async function* streamAnthropic(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  binding?: ThinkingBinding,
): AsyncGenerator<StreamChunk> {
  const translator = new AnthropicStreamTranslator(binding)
  for await (const sseEvent of parseSse(stream, onActivity)) {
    let event: AnthropicStreamEvent
    try {
      event = JSON.parse(sseEvent.data) as AnthropicStreamEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    yield* translator.push(event)
    if (translator.terminated) return
  }
  throw new LlmError('Anthropic SSE stream ended before message_stop', 'STREAM_CLOSED')
}
