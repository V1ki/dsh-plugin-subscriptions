import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { Context } from '@deepseek-ai/cordis'
import {
  CODEX_SEARCH_FALLBACK_MODEL,
  CODEX_SEARCH_URL,
  CodexWebSearchProvider,
  normalizeCodexSearchResponse,
} from '../src/providers/codex-search.js'
import type { CodexSession } from '../src/auth/store.js'

const session: CodexSession = {
  accessToken: 'secret', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, accountId: 'acct-1',
}

function provider(fetchFn: typeof fetch, sessionFn = async () => session) {
  return new CodexWebSearchProvider({
    tokens: { session: sessionFn }, fetchFn, requestId: () => 'request-1', retryBaseMs: 0,
  })
}

test('Codex Web Search sends the standalone contract and normalizes citations', async () => {
  let captured: RequestInit | undefined
  const search = provider(async (url, init) => {
    assert.equal(String(url), CODEX_SEARCH_URL)
    captured = init
    return new Response(JSON.stringify({ output: 'Summary', results: [
      { url: 'https://example.com/a', title: ' A ', snippet: 'Snippet' },
      { url: 'https://example.com/a', title: 'duplicate' },
      { source_url: 'https://example.com/b', source_title: 'B', text: 'Text' },
      { url: 'ftp://example.com/nope' },
    ] }))
  })
  const result = await search.search({ query: 'DeepSeek Harness' })
  assert.equal(captured?.method, 'POST')
  const headers = new Headers(captured?.headers)
  assert.equal(headers.get('authorization'), 'Bearer secret')
  assert.equal(headers.get('chatgpt-account-id'), 'acct-1')
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    id: 'request-1', model: CODEX_SEARCH_FALLBACK_MODEL, input: 'DeepSeek Harness',
    commands: { search_query: [{ q: 'DeepSeek Harness' }] },
    settings: { search_context_size: 'medium', allowed_callers: ['direct'], external_web_access: 'live' },
    max_output_tokens: 2048,
  })
  assert.deepEqual(result, { content: 'Summary', sources: [
    { url: 'https://example.com/a', title: 'A', snippet: 'Snippet' },
    { url: 'https://example.com/b', title: 'B', snippet: 'Text' },
  ], truncated: false })
})

test('DSH WebRuntime caps Codex sources for the native web_search tool', async () => {
  const ctx = new Context()
  const web = new WebRuntime(ctx)
  web.registerSearchProvider(provider(async () => new Response(JSON.stringify({ output: 'ok', results: [
    { url: 'https://example.com/1' }, { url: 'https://example.com/2' },
  ] }))))
  assert.deepEqual(await web.search({ query: 'q', maxResults: 1 }), {
    content: 'ok', sources: [{ url: 'https://example.com/1' }], truncated: true,
  })
  await ctx.fiber.dispose()
})

test('Codex Web Search retries transient failures but not rate limits', async () => {
  let attempts = 0
  const transient = provider(async () => {
    attempts++
    if (attempts === 1) throw new TypeError('network')
    if (attempts === 2) return new Response('temporary', { status: 503 })
    return new Response(JSON.stringify({ output: 'recovered', results: [] }))
  })
  assert.equal((await transient.search({ query: 'q' })).content, 'recovered')
  assert.equal(attempts, 3)

  attempts = 0
  await assert.rejects(provider(async () => { attempts++; return new Response('', { status: 429 }) }).search({ query: 'q' }),
    (error: unknown) => (error as { code?: string }).code === 'CODEX_SEARCH_RATE_LIMIT')
  assert.equal(attempts, 1)
})

test('Codex Web Search fails before dispatch without authentication', async () => {
  let fetched = false
  const search = provider(async () => { fetched = true; return new Response() }, async () => { throw new Error('logged out') })
  await assert.rejects(search.search({ query: 'q' }),
    (error: unknown) => (error as { code?: string }).code === 'CODEX_AUTH_REQUIRED')
  assert.equal(fetched, false)
})

test('Codex response normalization rejects invalid envelopes and unsafe sources', () => {
  assert.throws(() => normalizeCodexSearchResponse({ results: [] }),
    (error: unknown) => (error as { code?: string }).code === 'CODEX_SEARCH_RESPONSE')
  assert.deepEqual(normalizeCodexSearchResponse({ output: 'ok', results: [
    { url: 'javascript:alert(1)' }, { url: 'https://example.com', title: 'bad\ncontrol' },
  ] }), { content: 'ok', sources: [{ url: 'https://example.com/' }], truncated: false })
})
