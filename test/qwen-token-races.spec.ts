/** Qwen refresh races use a private on-disk store and deterministic gates. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  compareAndDeleteQwenAccount, compareAndSaveQwenAccount, deleteAccountSession,
  getAccountSession, listAccounts, resolveAccountKey, saveAccountSession,
} from '../src/auth/store.js'
import type { QwenSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { isQwenPermanentRefreshError, QwenOAuthError } from '../src/providers/qwen.js'

const key = 'alice'
function session(name: string, expiresIn = 3_600_000): QwenSession {
  return { account: key, accessToken: name + '-access', refreshToken: name + '-refresh', expiresAt: Date.now() + expiresIn }
}
function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
async function fixture(refresh: (session: QwenSession) => Promise<QwenSession>, initial = session('old', -1)) {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-cas-races-'))
  const path = join(dir, 'auth.json')
  await saveAccountSession('qwen-subscription', key, initial, path)
  const notifications: string[] = []
  const makeTokens = () => new AccountTokenManager<QwenSession>({
    provider: 'qwen-subscription', displayName: 'Qwen',
    makeOptions: () => ({ preemptMs: 60_000, refresh, isPermanent: isQwenPermanentRefreshError }),
    onAccountRemoved: account => { notifications.push(account) },
    io: {
      list: () => listAccounts('qwen-subscription', path),
      get: account => getAccountSession('qwen-subscription', account, path),
      save: (account, next) => saveAccountSession('qwen-subscription', account, next, path),
      remove: account => deleteAccountSession('qwen-subscription', account, path),
      compareAndSave: (account, expected, next) => compareAndSaveQwenAccount(account, expected, next, path),
      compareAndDelete: (account, expected) => compareAndDeleteQwenAccount(account, expected, path),
      resolve: account => resolveAccountKey('qwen-subscription', account, path),
    },
  })
  return { path, tokens: makeTokens(), makeTokens, notifications, close: () => rm(dir, { recursive: true, force: true }) }
}
function hasCode(code: string) {
  return (error: unknown): boolean => error instanceof LlmError && error.code === code
}

test('successful refresh cannot resurrect a logged-out Qwen account', async () => {
  const entered = gate<void>(), finish = gate<QwenSession>()
  const f = await fixture(async () => { entered.resolve(); return finish.promise })
  try {
    const pending = f.tokens.session(key)
    await entered.promise
    await deleteAccountSession('qwen-subscription', key, f.path)
    finish.resolve(session('rotated'))
    await assert.rejects(pending, hasCode('MISSING_CREDENTIAL'))
    assert.equal(await getAccountSession('qwen-subscription', key, f.path), undefined)
    assert.deepEqual(f.notifications, [])
  } finally { await f.close() }
})

test('successful refresh never overwrites a concurrent Qwen login', async () => {
  const entered = gate<void>(), finish = gate<QwenSession>()
  const f = await fixture(async () => { entered.resolve(); return finish.promise })
  try {
    const pending = f.tokens.session(key)
    await entered.promise
    const login = session('new-login')
    await saveAccountSession('qwen-subscription', key, login, f.path)
    finish.resolve(session('obsolete-rotation'))
    assert.deepEqual(await pending, login)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, f.path), login)
  } finally { await f.close() }
})

test('late invalid_grant cannot delete a new login; only successful removal notifies', async () => {
  const entered = gate<void>(), finish = gate<QwenSession>()
  const f = await fixture(async () => { entered.resolve(); return finish.promise })
  try {
    const pending = f.tokens.session(key)
    await entered.promise
    const login = session('new-login')
    await saveAccountSession('qwen-subscription', key, login, f.path)
    finish.reject(new QwenOAuthError('invalid_grant', 400))
    assert.deepEqual(await pending, login)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, f.path), login)
    assert.deepEqual(f.notifications, [])
  } finally { await f.close() }
})

test('invalid_grant coalesces waiters, removes only the revoked account and notifies once', async () => {
  const entered = gate<void>(), finish = gate<QwenSession>()
  let calls = 0
  const f = await fixture(async () => { calls++; entered.resolve(); return finish.promise })
  try {
    const other = { ...session('bob'), account: 'bob' }
    await saveAccountSession('qwen-subscription', 'bob', other, f.path)
    const a = f.tokens.session(key), b = f.tokens.session(key)
    await entered.promise
    finish.reject(new QwenOAuthError('invalid_grant', 400))
    await Promise.all([assert.rejects(a, hasCode('INVALID_CREDENTIAL')), assert.rejects(b, hasCode('INVALID_CREDENTIAL'))])
    assert.equal(calls, 1)
    assert.equal(await getAccountSession('qwen-subscription', key, f.path), undefined)
    assert.deepEqual(await getAccountSession('qwen-subscription', 'bob', f.path), other)
    assert.deepEqual(f.notifications, [key])
  } finally { await f.close() }
})

test('transient failure after logout or relogin cannot return the old still-valid access token', async () => {
  for (const logout of [true, false]) {
    const entered = gate<void>(), finish = gate<QwenSession>()
    const old = session('old', 30_000)
    const f = await fixture(async () => { entered.resolve(); return finish.promise }, old)
    try {
      const pending = f.tokens.session(key)
      await entered.promise
      const login = session('new-login')
      if (logout) await deleteAccountSession('qwen-subscription', key, f.path)
      else await saveAccountSession('qwen-subscription', key, login, f.path)
      finish.reject(new LlmError('rate limited', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 1000 }))
      if (logout) await assert.rejects(pending, hasCode('MISSING_CREDENTIAL'))
      else assert.deepEqual(await pending, login)
      assert.deepEqual(await getAccountSession('qwen-subscription', key, f.path), logout ? undefined : login)
      assert.deepEqual(f.notifications, [])
    } finally { await f.close() }
  }
})

test('forced refresh preserves RATE_LIMIT while proactive refresh may use a valid token', async () => {
  const old = session('old', 30_000)
  const failure = new LlmError('rate limited', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 1000 })
  const f = await fixture(async () => { throw failure }, old)
  try {
    assert.deepEqual(await f.tokens.session(key), old)
    await assert.rejects(f.tokens.session(key, true), (error: unknown) => error === failure)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, f.path), old)
    assert.deepEqual(f.notifications, [])
  } finally { await f.close() }
})

test('a delayed 401 does not force rotation of a newer token', async () => {
  let calls = 0
  const f = await fixture(async current => { calls++; return session(current.accessToken + '-rotated') }, session('new-login'))
  try {
    const current = await getAccountSession('qwen-subscription', key, f.path)
    assert.deepEqual(await f.tokens.sessionAfterRejected(key, 'old-access'), current)
    assert.equal(calls, 0)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, f.path), current)
  } finally { await f.close() }
})

test('CAS conflict re-evaluates an expired new login instead of serving it', async () => {
  const entered = gate<void>(), finish = gate<QwenSession>()
  let calls = 0
  const f = await fixture(async () => {
    calls++
    if (calls === 1) { entered.resolve(); return finish.promise }
    return session('new-login-refreshed')
  })
  try {
    const pending = f.tokens.session(key)
    await entered.promise
    await saveAccountSession('qwen-subscription', key, session('new-login', -1), f.path)
    finish.resolve(session('old-rotation'))
    const current = session('new-login-refreshed')
    const actual = await pending
    assert.equal(actual.accessToken, current.accessToken)
    assert.equal(actual.refreshToken, current.refreshToken)
    assert.equal(calls, 2)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, f.path), actual)
  } finally { await f.close() }
})

test('CAS conflict re-evaluates a still-rejected access token with a new refresh token', async () => {
  const entered = gate<void>(), finish = gate<QwenSession>()
  const old = session('old')
  let calls = 0
  const f = await fixture(async () => {
    calls++
    if (calls === 1) { entered.resolve(); return finish.promise }
    return session('new-login-refreshed')
  }, old)
  try {
    const pending = f.tokens.sessionAfterRejected(key, old.accessToken)
    await entered.promise
    const login = { ...session('new-login'), accessToken: old.accessToken }
    await saveAccountSession('qwen-subscription', key, login, f.path)
    finish.resolve(session('old-rotation'))
    assert.equal((await pending).accessToken, 'new-login-refreshed-access')
    assert.equal(calls, 2)
    assert.equal((await getAccountSession('qwen-subscription', key, f.path))?.accessToken, 'new-login-refreshed-access')
  } finally { await f.close() }
})

test('independent managers cannot overwrite a newer completed refresh', async () => {
  const firstEntered = gate<void>(), secondEntered = gate<void>()
  const first = gate<QwenSession>(), second = gate<QwenSession>()
  let calls = 0
  const f = await fixture(async () => {
    calls++
    if (calls === 1) { firstEntered.resolve(); return first.promise }
    secondEntered.resolve(); return second.promise
  })
  try {
    const pendingFirst = f.tokens.session(key)
    await firstEntered.promise
    const pendingSecond = f.makeTokens().session(key)
    await secondEntered.promise
    const winner = session('winner')
    second.resolve(winner)
    assert.deepEqual(await pendingSecond, winner)
    first.resolve(session('late'))
    assert.deepEqual(await pendingFirst, winner)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, f.path), winner)
    assert.equal(calls, 2)
  } finally { await f.close() }
})
