/**
 * Structural mirrors of the DSH session-history types the pre-tracking fold
 * reads.
 *
 * Why mirrors instead of importing `@deepseek-ai/dsh-session-query` and
 * `@deepseek-ai/dsh-session`: neither is a plugin peer, and adding a runtime
 * `dsh-*` peer is kept to a minimum. Their declarations are
 * identical on 0.2.1-rc.5 and 0.2.2-rc.1 for every field used here. Only
 * the fields the fold reads are named, as wide as the host's own types, so
 * the host's `SessionQueryEngine` is assignable to {@link HostSessionQuery}
 * (branded ids and seqs are a string and a number at runtime).
 *
 * Event payloads stay `unknown`: a stored log carries whatever an earlier
 * DSH wrote, so `pre-tracking.ts` checks every field it reads.
 */

/** DSH `TokenUsage` (dsh-llm): disjoint buckets; reasoning is a subset of output. */
export interface HostTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** DSH `SessionHeader`, the fields read here. */
export interface HostSessionHeader {
  id: string
  createdAt?: number
  parentSession?: string
}

/** DSH `SessionEvent`: a discriminated union over `type`, mirrored with an opaque payload. */
export interface HostSessionEvent {
  type: string
  seq: number
  /** Unix epoch milliseconds at append. */
  time: number
  data: unknown
}

/** DSH `SessionRecord` (dsh-session-query), the fields read here. */
export interface HostSessionRecord {
  header: HostSessionHeader
}

/** DSH `SessionLogSnapshot` (dsh-session-query): one complete, replay-validated log. */
export interface HostSessionLog {
  session: HostSessionHeader
  /** The fork-inherited prefix length: the first this many events belong to the parent. */
  inheritedEventCount: number
  events: readonly HostSessionEvent[]
}

/** The two `ctx.sessionQuery` reads the one-time scan uses (`SessionQueryEngine`). */
export interface HostSessionQuery {
  listSessions(signal?: AbortSignal): Promise<readonly HostSessionRecord[]>
  readSession(sessionId: string): Promise<HostSessionLog>
}

/** The session event types the fold reads; every other type is ignored. */
export const HOST_EVENT = {
  assistantMessage: 'assistant/message',
  assistantAttempt: 'assistant/attempt',
  compactionSummary: 'compaction/summary',
  requestContext: 'request/context',
  /** dsh-llm-retry: closes the (turn, step) usage slot, so the retried attempt adds (dsh-token-meter). */
  retryStarted: 'llm/retry-started',
} as const

/** The raw stream record that wraps one unpacked chunk (`AssistantStreamRecord`), and the usage chunk type. */
export const HOST_STREAM = {
  rawRecord: 'chunk',
  usageChunk: 'usage',
} as const
