import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import type { WebRuntimeConfig } from '@deepseek-ai/dsh-web'
import { Context } from '@deepseek-ai/cordis'
import {
  CODEX_SEARCH_MODEL,
  CODEX_SEARCH_URL,
  CodexWebSearchProvider,
  normalizeCodexSearchResponse,
} from '../src/providers/codex-search.js'
import type { CodexSession } from '../src/auth/store.js'

const session: CodexSession = {
  accessToken: 'secret', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, accountId: 'acct-1',
}

/**
 * DSH 0.2.1-rc.2 takes the runtime's provider overrides as `Volatile` refs.
 * Both answering `undefined` pins no provider, so selection falls to the seam's
 * auto-select rule (one usable provider wins, several are ambiguous), which is
 * the behaviour these cases exercise.
 */
function autoSelectConfig(): WebRuntimeConfig {
  return { searchProvider: { get: () => undefined }, fetchProvider: { get: () => undefined } }
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
  // Same originator as every other Codex call in this plugin; a plugin-specific
  // value is not a client ChatGPT's Codex backend knows.
  assert.equal(headers.get('originator'), 'codex_cli_rs')
  assert.match(String(headers.get('user-agent')), /\S/)
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    id: 'request-1', model: CODEX_SEARCH_MODEL, input: 'DeepSeek Harness',
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
  const web = new WebRuntime(ctx, autoSelectConfig())
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

test('the Codex web_search switch drives provider availability, not the host tool', async () => {
  const fetchFn = async () => new Response(JSON.stringify({ output: 'ok', results: [] }))
  assert.equal(provider(fetchFn).available(), true, 'absent switch counts as enabled')

  let enabled = true
  const gated = new CodexWebSearchProvider({
    tokens: { session: async () => session }, fetchFn, enabled: () => enabled,
  })
  assert.equal(gated.available(), true)
  enabled = false
  // Read per call: flipping the switch must not need a re-registration.
  assert.equal(gated.available(), false)
})

test('a disabled Codex provider releases the seam instead of holding it', async () => {
  const ctx = new Context()
  const web = new WebRuntime(ctx, autoSelectConfig())
  let enabled = false
  web.registerSearchProvider(new CodexWebSearchProvider({
    tokens: { session: async () => session },
    fetchFn: async () => new Response(JSON.stringify({ output: 'codex', results: [] })),
    enabled: () => enabled,
  }))
  // Sole provider, switched off: the seam reports its own unavailable error
  // rather than running Codex or losing the host's tool.
  await assert.rejects(web.search({ query: 'q' }),
    (error: unknown) => (error as { code?: string }).code === 'WEB_PROVIDER_UNAVAILABLE')

  // A second provider must win while Codex is off, and collide once it is on:
  // this is why the plugin no longer pins `searchProvider` for the whole host.
  web.registerSearchProvider({
    id: 'other', available: () => true,
    search: async () => ({ content: 'other', sources: [], truncated: false }),
  })
  assert.equal((await web.search({ query: 'q' })).content, 'other')
  enabled = true
  await assert.rejects(web.search({ query: 'q' }),
    (error: unknown) => (error as { code?: string }).code === 'WEB_PROVIDER_AMBIGUOUS')
  await ctx.fiber.dispose()
})
