/** Codex-backed provider for DSH's native web_search capability. */
import { randomUUID } from 'node:crypto'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { CodexSession } from '../auth/store.js'
import type { AccountTokenManager } from '../providers/accounts.js'

export const CODEX_SEARCH_PROVIDER_ID = 'codex'
export const CODEX_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search'
export const CODEX_SEARCH_FALLBACK_MODEL = 'gpt-5.6-terra'
const MAX_ATTEMPTS = 5
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const RETRY_BASE_MS = 100

export interface CodexWebSearchOptions {
  tokens: Pick<AccountTokenManager<CodexSession>, 'session'>
  fetchFn?: typeof fetch
  requestId?: () => string
  model?: () => string | undefined
  retryBaseMs?: number
}

/** Search provider registered behind DSH's stock web_search tool and citation UI. */
export class CodexWebSearchProvider implements WebSearchProvider {
  readonly id = CODEX_SEARCH_PROVIDER_ID

  constructor(private readonly options: CodexWebSearchOptions) {}

  available(): boolean { return true }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal)
    let session: CodexSession
    try {
      session = await this.options.tokens.session()
    } catch (cause) {
      throw new WebError(
        'Codex Web Search requires a logged-in Codex account; log in via Settings → Subscriptions',
        'CODEX_AUTH_REQUIRED',
        { cause },
      )
    }
    const body = {
      id: this.options.requestId?.() ?? randomUUID(),
      model: this.options.model?.() ?? CODEX_SEARCH_FALLBACK_MODEL,
      input: request.query,
      commands: { search_query: [{ q: request.query }] },
      settings: {
        search_context_size: 'medium',
        allowed_callers: ['direct'],
        external_web_access: 'live',
      },
      max_output_tokens: 2048,
    }
    const value = await this.dispatch(body, session, signal)
    return normalizeCodexSearchResponse(value)
  }

  private async dispatch(body: object, session: CodexSession, signal?: AbortSignal): Promise<unknown> {
    const fetchFn = this.options.fetchFn ?? fetch
    const retryBaseMs = this.options.retryBaseMs ?? RETRY_BASE_MS
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      throwIfAborted(signal)
      let response: Response
      try {
        response = await fetchFn(CODEX_SEARCH_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'chatgpt-account-id': session.accountId,
            'content-type': 'application/json',
            originator: 'dsh-plugin-subscriptions',
            'user-agent': 'dsh-plugin-subscriptions',
          },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (cause) {
        if (signal?.aborted) throw cancelled(cause)
        if (attempt < MAX_ATTEMPTS) {
          await abortableDelay(retryBaseMs * 2 ** (attempt - 1), signal)
          continue
        }
        throw new WebError('Codex Web Search failed after five transport attempts', 'CODEX_SEARCH_NETWORK', { cause })
      }
      if (response.status === 429) {
        await discard(response)
        throw new WebError('Codex Web Search was rate-limited; retry later', 'CODEX_SEARCH_RATE_LIMIT')
      }
      if (response.status >= 500 && response.status <= 599 && attempt < MAX_ATTEMPTS) {
        await discard(response)
        await abortableDelay(retryBaseMs * 2 ** (attempt - 1), signal)
        continue
      }
      if (!response.ok) {
        await discard(response)
        throw new WebError(`Codex Web Search returned HTTP ${response.status}`, 'CODEX_SEARCH_UPSTREAM')
      }
      const text = await boundedText(response, signal)
      try { return JSON.parse(text) as unknown } catch (cause) {
        throw new WebError('Codex Web Search returned invalid JSON', 'CODEX_SEARCH_RESPONSE', { cause })
      }
    }
    throw new WebError('Codex Web Search exhausted its retry policy', 'CODEX_SEARCH_UPSTREAM')
  }
}

export function normalizeCodexSearchResponse(value: unknown): WebSearchResult {
  if (!record(value) || typeof value.output !== 'string') {
    throw new WebError('Codex Web Search returned an unusable response', 'CODEX_SEARCH_RESPONSE')
  }
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  if (Array.isArray(value.results)) for (const candidate of value.results) {
    if (!record(candidate)) continue
    const rawUrl = safeString(candidate.url, 8192) ?? safeString(candidate.source_url, 8192)
    const url = rawUrl === undefined ? undefined : httpUrl(rawUrl)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = safeString(candidate.title, 1000) ?? safeString(candidate.source_title, 1000)
    const snippet = safeString(candidate.snippet, 4000) ?? safeString(candidate.text, 4000)
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) })
  }
  return { content: value.output, sources, truncated: false }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function safeString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) return undefined
  return text
}
function httpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch { return undefined }
}
async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* best effort */ }
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled(signal.reason)
}
function cancelled(cause?: unknown): WebError {
  return new WebError('Codex Web Search was cancelled', 'CODEX_SEARCH_CANCELLED', { cause })
}
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) { throwIfAborted(signal); return Promise.resolve() }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => { cleanup(); reject(cancelled(signal?.reason)) }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
async function boundedText(response: Response, signal?: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await discard(response)
    throw new WebError('Codex Web Search response exceeded the safe size limit', 'CODEX_SEARCH_RESPONSE_TOO_LARGE')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      throwIfAborted(signal)
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new WebError('Codex Web Search response exceeded the safe size limit', 'CODEX_SEARCH_RESPONSE_TOO_LARGE')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } catch (cause) {
    if (signal?.aborted) throw cancelled(cause)
    throw cause
  } finally {
    try { reader.releaseLock() } catch { /* best effort */ }
  }
}
