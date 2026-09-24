import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexClientVersionCache, CODEX_VERSION_URL } from '../src/providers/codex-client-version.js'
import { CODEX_CLIENT_VERSION } from '../src/providers/codex.js'

test('Codex version lookup deduplicates, caches and refreshes public metadata without credentials', async () => {
  let now = 1000
  let calls = 0
  const cache = new CodexClientVersionCache(async (url, init) => {
    assert.equal(url, CODEX_VERSION_URL)
    assert.deepEqual(init?.headers, { accept: 'application/json', 'accept-encoding': 'identity' })
    assert.equal(init?.redirect, 'error')
    calls++
    return Response.json({ version: '0.155.0' })
  }, () => now)
  assert.deepEqual(await Promise.all([cache.resolve(), cache.resolve()]), ['0.155.0', '0.155.0'])
  await cache.resolve()
  assert.equal(calls, 1)
  now += 6 * 60 * 60_000
  await cache.resolve()
  assert.equal(calls, 2)
  cache.invalidate()
  await cache.resolve()
  assert.equal(calls, 3)
})

test('Codex version lookup rejects invalid, prerelease and regressed versions with retry cooldown', async () => {
  for (const version of [undefined, null, 123, '0.155.0-alpha.1', '0.155.0-linux-x64', '0.1.0', 'oops']) {
    let calls = 0
    const cache = new CodexClientVersionCache(async () => { calls++; return Response.json({ version }) })
    assert.equal(await cache.resolve(), CODEX_CLIENT_VERSION)
    assert.equal(await cache.resolve(), CODEX_CLIENT_VERSION)
    assert.equal(calls, 1)
  }
})

test('Codex version lookup preserves last good version after failure and retries after cooldown', async () => {
  let now = 1000
  let calls = 0
  const cache = new CodexClientVersionCache(async () => {
    calls++
    if (calls === 2) return new Response('', { status: 503 })
    return Response.json({ version: calls === 1 ? '0.155.0' : '0.156.0' })
  }, () => now)
  assert.equal(await cache.resolve(), '0.155.0')
  now += 6 * 60 * 60_000
  assert.equal(await cache.resolve(), '0.155.0')
  assert.equal(await cache.resolve(), '0.155.0')
  assert.equal(calls, 2)
  now += 5 * 60_000
  assert.equal(await cache.resolve(), '0.156.0')
})

test('Codex version lookup bounds stalled transports and does not accept late results', async () => {
  let finish!: (response: Response) => void
  let signal: AbortSignal | null | undefined
  const cache = new CodexClientVersionCache((_url, init) => {
    signal = init?.signal
    return new Promise(resolve => { finish = resolve })
  }, Date.now, 5)
  assert.equal(await cache.resolve(), CODEX_CLIENT_VERSION)
  assert.equal(signal?.aborted, true)
  finish(Response.json({ version: '0.199.0' }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(await cache.resolve(), CODEX_CLIENT_VERSION)
})
