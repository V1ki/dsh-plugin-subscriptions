import { parseAccountModelId } from '../providers/account-preferences.js'
import type { UsageChunk } from '../providers/replay.js'
import type { HostTokenUsage } from './host-events.js'
import type { TokenCounts } from './window-tracker.js'

/** Copy only the token buckets reported by DSH. No message or request data is retained. */
export function usageCounts(usage: HostTokenUsage): TokenCounts {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  }
}

export function requestCounts(chunk: UsageChunk): TokenCounts {
  return usageCounts(chunk.usage)
}

/** Keep the actual model id, not the account-prefixed picker alias. */
export function servedModel(model: string): string {
  try {
    return parseAccountModelId(model)?.model ?? model
  } catch {
    return model
  }
}
