import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ClaudeCliVersionCache, CLAUDE_CLI_VERSION_URL } from '../src/providers/claude-cli-version.js'
import {
  CLAUDE_CLI_FALLBACK_VERSION,
  ClaudeAdapter,
  claudeCliUserAgent,
  claudeCliVersionFloor,
  fetchClaudeModels,
  fetchClaudeUsage,
} from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { FetchFn } from '../src/providers/common.js'

const OLD_LOCAL = '2.1.1'
const NEWER = '9.0.0'
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

test('Claude Code version floor is the newer of the local CLI and the bundled fallback', () => {
  // An outdated local install must not pin requests below what new models need.
  assert.equal(claudeCliVersionFloor(() => OLD_LOCAL), CLAUDE_CLI_FALLBACK_VERSION)
  assert.equal(claudeCliVersionFloor(() => NEWER), NEWER)
})

test('Claude Code version lookup reads npm latest without credentials and never goes below the floor', async () => {
  let probes = 0
  const detect = () => { probes++; return OLD_LOCAL }
  const cache = new ClaudeCliVersionCache(async (url, init) => {
    assert.equal(url, CLAUDE_CLI_VERSION_URL)
    assert.deepEqual(init?.headers, { accept: 'application/json' })
    assert.equal(init?.redirect, 'error')
    return Response.json({ version: '2.1.999' })
  }, undefined, undefined, detect)
  assert.equal(probes, 0, 'the local CLI is probed lazily, not at construction')
  assert.deepEqual(await Promise.all([cache.resolve(), cache.resolve()]), ['2.1.999', '2.1.999'])
  assert.equal(probes, 1)

  // npm behind the floor (a newer local CLI) keeps the floor.
  const local = new ClaudeCliVersionCache(async () => Response.json({ version: '2.1.999' }), undefined, undefined, () => NEWER)
  assert.equal(await local.resolve(), NEWER)

  // An unreachable registry serves the floor.
  const offline = new ClaudeCliVersionCache(async () => new Response('', { status: 503 }), undefined, undefined, detect)
  assert.equal(await offline.resolve(), CLAUDE_CLI_FALLBACK_VERSION)
})

test('Claude catalog and usage requests present the resolved Claude Code version', async () => {
  const agents: string[] = []
  const fetchFn = (payload: unknown): FetchFn => async (_url, init) => {
    agents.push(String((init?.headers as Record<string, string>)['user-agent']))
    return Response.json(payload)
  }
  const version = async () => '2.1.999'
  await fetchClaudeModels(session, fetchFn({ data: [{ id: 'claude-x' }] }), undefined, version)
  await fetchClaudeUsage(session, fetchFn({}), undefined, version)
  assert.deepEqual(agents, [claudeCliUserAgent('2.1.999'), claudeCliUserAgent('2.1.999')])
})

test('Claude turns present the resolved Claude Code version', async () => {
  const original = globalThis.fetch
  const agents: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    agents.push(String((init?.headers as Record<string, string>)['user-agent']))
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stop here' } }), { status: 400 })
  }) as typeof globalThis.fetch
  try {
    const adapter = new ClaudeAdapter({
      models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
      streamIdleTimeoutMs: 1000,
      tokens: tokens(),
      discovery: false,
      resolveCliVersion: async () => '2.1.999',
    })
    const options: GenerateOptions = {
      provider: 'claude',
      model: 'claude-opus-5-5',
      messages: [{ id: MessageId('m'), role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      maxTokens: 1_000,
    }
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options)) { /* drain */ } })
    assert.deepEqual(agents, [claudeCliUserAgent('2.1.999')])
  } finally {
    globalThis.fetch = original
  }
})
