/**
 * AccountTokenManager: one lazily-built TokenManager per account, so refresh
 * coalescing and permanent-failure removal stay scoped to a single account.
 * All tests run over an in-memory store backend (the `io` seam).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { AccountEntry, ProviderId } from '../src/auth/store.js'

interface TestSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function session(accessToken: string, expiresInMs = 3_600_000): TestSession {
  return { accessToken, refreshToken: `${accessToken}-rt`, expiresAt: Date.now() + expiresInMs }
}

/** An in-memory multi-account store; `refresh` counts calls per account. */
function harness(options: {
  accounts?: Record<string, TestSession>
  refresh?: (account: string, session: TestSession) => Promise<TestSession>
  permanent?: (account: string, error: unknown) => boolean
} = {}) {
  const stored = new Map<string, TestSession>(Object.entries(options.accounts ?? {}))
  const removed: string[] = []
  const notified: string[] = []
  const refreshes: string[] = []
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex' as ProviderId,
    displayName: 'Test',
    makeOptions: account => ({
      preemptMs: 60_000,
      refresh: async (current) => {
        refreshes.push(account)
        const next = await (options.refresh ?? (() => Promise.resolve(current)))(account, current)
        return next
      },
      isPermanent: error => options.permanent?.(account, error) ?? false,
    }),
    onAccountRemoved: (account) => {
      notified.push(account)
    },
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, s]) => ({ key, session: s }) as AccountEntry<TestSession>)),
      get: account => Promise.resolve(account === undefined ? stored.values().next().value : stored.get(account)),
      save: (account, s) => {
        stored.set(account, s)
        return Promise.resolve()
      },
      remove: (account) => {
        stored.delete(account)
        removed.push(account)
        return Promise.resolve()
      },
    },
  })
  return { tokens, stored, removed, notified, refreshes }
}

test('session() without an account serves the default (first) account', async () => {
  const { tokens } = harness({ accounts: { a1: session('at-1'), a2: session('at-2') } })
  assert.equal((await tokens.session()).accessToken, 'at-1')
  assert.equal((await tokens.session('a2')).accessToken, 'at-2')
})

test('session() with no accounts throws MISSING_CREDENTIAL', async () => {
  const { tokens } = harness()
  await assert.rejects(
    tokens.session(),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('concurrent refreshes of one account coalesce; accounts refresh independently', async () => {
  let calls = 0
  const { tokens, refreshes } = harness({
    accounts: {
      a1: session('at-1', 1000), // inside the preempt window → refreshes
      a2: session('at-2', 1000),
    },
    refresh: async (_account, current) => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return { ...current, accessToken: `${current.accessToken}-new`, expiresAt: Date.now() + 3_600_000 }
    },
  })
  const [s1, s2, s3] = await Promise.all([tokens.session('a1'), tokens.session('a1'), tokens.session('a2')])
  assert.equal(s1.accessToken, 'at-1-new')
  assert.equal(s2.accessToken, 'at-1-new')
  assert.equal(s3.accessToken, 'at-2-new')
  assert.equal(calls, 2, 'one refresh per account, not per call')
  assert.deepEqual(refreshes.sort(), ['a1', 'a2'])
})

test('legacy and canonical keys share one in-flight refresh', async () => {
  const expired = session('old', 1000)
  const stored = new Map<string, TestSession>([['canonical', expired]])
  let calls = 0
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'codex', displayName: 'Test',
    makeOptions: () => ({ preemptMs: 60_000, refresh: async current => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return { ...current, accessToken: 'new', expiresAt: Date.now() + 3_600_000 }
    }, isPermanent: () => true }),
    io: {
      list: () => Promise.resolve([{ key: 'canonical', session: stored.get('canonical')! }]),
      get: key => Promise.resolve(stored.get(key === 'legacy' ? 'canonical' : key ?? 'canonical')),
      save: (_key, value) => { stored.set('canonical', value); return Promise.resolve() },
      remove: () => { stored.delete('canonical'); return Promise.resolve() },
      resolve: key => Promise.resolve(key === 'legacy' ? 'canonical' : key),
    },
  })
  const [legacy, canonical, defaultSession] = await Promise.all([
    tokens.session('legacy'), tokens.session('canonical'), tokens.session(),
  ])
  assert.equal(calls, 1)
  assert.deepEqual([legacy.accessToken, canonical.accessToken, defaultSession.accessToken], ['new', 'new', 'new'])
  assert.equal(stored.has('canonical'), true)
})

test('a permanent refresh failure removes only that account and notifies once', async () => {
  const { tokens, stored, removed, notified } = harness({
    accounts: { a1: session('at-1', 1000), a2: session('at-2') },
    refresh: () => Promise.reject(new Error('invalid_grant')),
    permanent: () => true,
  })
  await assert.rejects(
    tokens.session('a1'),
    (error: unknown) => error instanceof LlmError && error.code === 'INVALID_CREDENTIAL',
  )
  assert.deepEqual(removed, ['a1'])
  assert.deepEqual(notified, ['a1'])
  assert.equal(stored.has('a1'), false)
  assert.equal(stored.has('a2'), true, 'the sibling account is untouched')
  // The survivor still serves.
  assert.equal((await tokens.session('a2')).accessToken, 'at-2')
})

test('makeOptions receives the account key (per-account refresh wiring)', async () => {
  const seen: string[] = []
  const stored = new Map<string, TestSession>([['a1', session('at-1', 1000)]])
  const tokens = new AccountTokenManager<TestSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: (account) => {
      seen.push(account)
      return {
        preemptMs: 60_000,
        refresh: current => Promise.resolve({ ...current, expiresAt: Date.now() + 3_600_000 }),
        isPermanent: () => false,
      }
    },
    io: {
      list: () => Promise.resolve([...stored.entries()].map(([key, s]) => ({ key, session: s }))),
      get: account => Promise.resolve(account === undefined ? undefined : stored.get(account)),
      save: (account, s) => {
        stored.set(account, s)
        return Promise.resolve()
      },
      remove: () => Promise.resolve(),
    },
  })
  await tokens.session('a1')
  assert.deepEqual(seen, ['a1'])
})

test('peek and hasSession read without refreshing', async () => {
  const { tokens, refreshes } = harness({ accounts: { a1: session('at-1', 1000) } })
  assert.equal((await tokens.peek('a1'))?.accessToken, 'at-1')
  assert.equal(await tokens.hasSession('a1'), true)
  assert.equal(await tokens.hasSession('nobody'), false)
  assert.deepEqual(refreshes, [])
})
