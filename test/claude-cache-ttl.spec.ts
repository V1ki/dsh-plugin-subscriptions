/**
 * The `claudePromptCacheTtl` option, end to end: adapter option → request body
 * on the wire. Body assembly is covered in models.spec.ts and translate.spec.ts;
 * this pins the wiring between them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { PromptCacheTtl } from '../src/translate/anthropic.js'

const session: ClaudeSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scopes: 'scope' }

function tokens(): AccountTokenManager<ClaudeSession> {
  return new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: s => Promise.resolve(s), isPermanent: () => false }),
    io: {
      list: () => Promise.resolve([{ key: 'acct', session }]),
      get: () => Promise.resolve(session),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  })
}

/** Send one turn through a real adapter and return the JSON body it POSTed. */
async function sentBody(promptCacheTtl: PromptCacheTtl | undefined): Promise<{ system: Record<string, unknown>[], messages: { content: Record<string, unknown>[] }[] }> {
  const original = globalThis.fetch
  let body = ''
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = String(init?.body)
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stop here' } }), { status: 400 })
  }) as typeof globalThis.fetch
  try {
    const adapter = new ClaudeAdapter({
      models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
      streamIdleTimeoutMs: 1000,
      tokens: tokens(),
      discovery: false,
      resolveCliVersion: async () => '2.1.999',
      ...promptCacheTtl === undefined ? {} : { promptCacheTtl },
    })
    const options: GenerateOptions = {
      provider: 'claude',
      model: 'claude-opus-5-5',
      system: 'be brief',
      messages: [{ id: MessageId('m'), role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      maxTokens: 1_000,
    }
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options)) { /* drain */ } })
    return JSON.parse(body) as never
  } finally {
    globalThis.fetch = original
  }
}

const markers = (body: Awaited<ReturnType<typeof sentBody>>): unknown[] =>
  [...body.system, ...body.messages.flatMap(entry => entry.content)]
    .filter(block => block.cache_control !== undefined)
    .map(block => block.cache_control)

test('a Claude turn sends five-minute cache marks unless the adapter is told otherwise', async () => {
  for (const ttl of [undefined, '5m'] as const) {
    const body = await sentBody(ttl)
    assert.deepEqual(markers(body), [{ type: 'ephemeral' }, { type: 'ephemeral' }], `promptCacheTtl=${String(ttl)}`)
  }
})

test('a Claude turn sends one-hour cache marks when the adapter is configured for them', async () => {
  const body = await sentBody('1h')
  assert.deepEqual(
    markers(body),
    [{ type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '1h' }],
    'both the tools+system mark and the conversation tail mark carry the one-hour TTL',
  )
})
