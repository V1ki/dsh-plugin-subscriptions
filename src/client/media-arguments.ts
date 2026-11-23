import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

const PROMPT_MAX_LENGTH = 60

/** Read during render: the host republishes preparing calls when observed answers change. */
export function mediaArguments(block: ToolCallBlock): { prompt: string; references: number } {
  // Older hosts have only argsRaw, not the incremental argument view.
  const args = block.args as ToolCallBlock['args'] | undefined
  const raw = 'kind' in block ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined
  let prompt: string | undefined
  let references: unknown
  if (args !== undefined) {
    prompt = args.textPrefix('prompt', PROMPT_MAX_LENGTH + 1)
    if (!prompt) {
      for (const key of args.keys()) {
        const candidate = args.textPrefix(key, PROMPT_MAX_LENGTH + 1)
        if (candidate) { prompt = candidate; break }
      }
    }
    references = args.value('referenceImages')
  } else if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const fields = parsed as Record<string, unknown>
        if (typeof fields.prompt === 'string' && fields.prompt !== '') prompt = fields.prompt
        else prompt = Object.values(fields).find((value): value is string => typeof value === 'string' && value !== '')
        references = fields.referenceImages
      }
    } catch { /* Keep the raw line for malformed arguments. */ }
  }
  const line = (prompt ?? raw ?? '').split('\n', 1)[0] ?? ''
  return {
    prompt: line.length > PROMPT_MAX_LENGTH ? line.slice(0, PROMPT_MAX_LENGTH) + '…' : line,
    references: Array.isArray(references) ? references.length : 0,
  }
}
