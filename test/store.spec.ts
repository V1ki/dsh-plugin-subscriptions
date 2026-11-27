/**
 * The session store under concurrency, and its multi-account shape. Every
 * writer does a read-modify-write of one JSON file — logins, logouts and the
 * token refreshes each provider account fires on its own schedule — so two
 * writers overlapping must not cost an account its session. Also covered:
 * the single-account format migrating transparently on read.
 *
 * Each test writes to its own temp path, passed explicitly, so nothing here
 * depends on `$DSH_HOME` or touches a developer's real store.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  accountKeyOf,
  deleteAccountSession,
  getAccountSession,
  listAccounts,
  loadStore,
  resolveAccountKey,
  saveAccountSession,
  setDefaultAccount,
  updateAccountSession,
} from '../src/auth/store.js'
import type { ClaudeSession, CodexSession } from '../src/auth/store.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AccountTokenManager } from '../src/providers/accounts.js'

const TEMP_DIRS: string[] = []

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** A store path inside a temp directory removed when the file finishes. */
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-spec-'))
  TEMP_DIRS.push(dir)
  return join(dir, 'auth.json')
}

const CODEX: CodexSession = {
  accessToken: 'codex-at',
  refreshToken: 'codex-rt',
  expiresAt: Date.now() + 3600_000,
  accountId: 'acct-1',
}

const CLAUDE: ClaudeSession = {
  accessToken: 'claude-at',
  refreshToken: 'claude-rt',
  expiresAt: Date.now() + 3600_000,
  scopes: 'user:inference',
  emailAddress: 'alice@example.com',
}

test('accountKeyOf keys on the stable identity', () => {
  assert.equal(accountKeyOf('codex', CODEX), 'acct-1')
  assert.equal(accountKeyOf('claude', CLAUDE), 'alice@example.com')
  // Sessions without an identity field fall back to a refresh-token hash.
  assert.match(accountKeyOf('claude', { ...CLAUDE, emailAddress: undefined }), /^token-[0-9a-f]{16}$/)
})

function codexUser(user: string, field = 'chatgpt_user_id'): CodexSession {
  const payload = { 'https://api.openai.com/auth': { [field]: user } }
  return { ...CODEX, idToken: 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature' }
}

test('Codex keys distinguish workspace users, remain stable and tolerate legacy claims', () => {
  const alice = codexUser('alice')
  assert.notEqual(accountKeyOf('codex', alice), accountKeyOf('codex', codexUser('bob')))
  assert.equal(accountKeyOf('codex', alice), accountKeyOf('codex', codexUser('alice', 'user_id')))
  assert.equal(accountKeyOf('codex', alice), accountKeyOf('codex', { ...alice, refreshToken: 'rotated', emailAddress: 'new@example.com' }))
  assert.notEqual(accountKeyOf('codex', alice), accountKeyOf('codex', { ...alice, accountId: 'other-workspace' }))
  assert.equal(accountKeyOf('codex', { ...CODEX, idToken: 'malformed' }), CODEX.accountId)
  assert.equal(accountKeyOf('codex', { ...CODEX, emailAddress: ' ALICE@example.com ' }), accountKeyOf('codex', { ...CODEX, emailAddress: 'alice@example.com' }))
})

test('updateAccountSession only writes while the account still matches', async () => {
  const path = storePath()
  await saveAccountSession('codex', CODEX.accountId, CODEX, path)
  const stale = CODEX
  assert.equal(await updateAccountSession('codex', CODEX.accountId, current =>
    current.accessToken === stale.accessToken ? { ...current, refreshToken: 'rotated' } : undefined, path), true)
  assert.equal((await getAccountSession('codex', CODEX.accountId, path))?.refreshToken, 'rotated')
  // A stale snapshot no longer matches the stored credentials: skipped.
  assert.equal(await updateAccountSession('codex', CODEX.accountId, current =>
    current.accessToken === stale.accessToken && current.refreshToken === stale.refreshToken
      ? current
      : undefined, path), false)
  assert.equal((await getAccountSession('codex', CODEX.accountId, path))?.refreshToken, 'rotated')
  // A removed account is not recreated by a late writer.
  await deleteAccountSession('codex', CODEX.accountId, path)
  assert.equal(await updateAccountSession('codex', CODEX.accountId, current => current, path), false)
  assert.equal(await getAccountSession('codex', CODEX.accountId, path), undefined)
})

test('Codex legacy migration preserves default, references, refresh and workspace siblings', async () => {
  const path = storePath()
  const alice = codexUser('alice')
  const bob = codexUser('bob')
  const a = accountKeyOf('codex', alice)
  const b = accountKeyOf('codex', bob)
  writeFileSync(path, JSON.stringify({ codex: { default: CODEX.accountId, accounts: { [CODEX.accountId]: alice } } }))
  assert.equal((await loadStore(path)).codex?.default, a)
  await saveAccountSession('codex', b, bob, path)
  await saveAccountSession('codex', CODEX.accountId, { ...alice, refreshToken: 'rotated' }, path)
  assert.equal((await getAccountSession('codex', a, path))?.refreshToken, 'rotated')
  assert.equal((await getAccountSession('codex', b, path))?.refreshToken, bob.refreshToken)
  assert.deepEqual((await listAccounts('codex', path)).map(x => x.key), [a, b])
  await setDefaultAccount('codex', b, path)
  await setDefaultAccount('codex', CODEX.accountId, path)
  assert.equal((await loadStore(path)).codex?.default, a)
  await deleteAccountSession('codex', CODEX.accountId, path)
  assert.equal(await getAccountSession('codex', CODEX.accountId, path), undefined)
  assert.equal((await listAccounts('codex', path))[0]?.key, b)
})

test('Codex email fallback upgrades to user identity on re-login and refresh', async () => {
  for (const via of ['login', 'refresh'] as const) {
    const path = storePath()
    const emailSession = { ...CODEX, emailAddress: ' Alice@example.com ', accessToken: 'old-expired' }
    const emailKey = accountKeyOf('codex', emailSession)
    await saveAccountSession('codex', emailKey, emailSession, path)
    const userSession = { ...codexUser('alice-user'), emailAddress: 'alice@example.com', accessToken: via }
    const userKey = accountKeyOf('codex', userSession)
    await saveAccountSession('codex', via === 'refresh' ? emailKey : userKey, userSession, path)
    const entry = (await loadStore(path)).codex!
    assert.deepEqual(Object.keys(entry.accounts), [userKey])
    assert.equal(entry.default, userKey)
    assert.equal(entry.accounts[userKey].accessToken, via)
    assert.equal((await getAccountSession('codex', emailKey, path))?.accessToken, via)
  }

  const legacyPath = storePath()
  const legacyEmail = { ...CODEX, emailAddress: 'alice@example.com' }
  writeFileSync(legacyPath, JSON.stringify({ codex: { default: CODEX.accountId, accounts: { [CODEX.accountId]: legacyEmail } } }))
  await saveAccountSession('codex', accountKeyOf('codex', codexUser('alice-user')), {
    ...codexUser('alice-user'), emailAddress: 'alice@example.com', accessToken: 'upgraded',
  }, legacyPath)
  assert.equal((await getAccountSession('codex', CODEX.accountId, legacyPath))?.accessToken, 'upgraded')
  assert.equal((await loadStore(legacyPath)).codex?.default, accountKeyOf('codex', codexUser('alice-user')))
})

test('rekeyed Codex manager survives last-account logout and canonical re-login', async () => {
  const path = storePath()
  const emailSession = { ...CODEX, emailAddress: 'alice@example.com', expiresAt: 0 }
  const emailKey = accountKeyOf('codex', emailSession)
  const upgraded = { ...codexUser('alice-user'), emailAddress: emailSession.emailAddress }
  const userKey = accountKeyOf('codex', upgraded)
  await saveAccountSession('codex', emailKey, emailSession, path)
  let refreshes = 0
  let revoked = false
  const saved: string[] = []
  const removed: string[] = []
  const notified: string[] = []
  const tokens = new AccountTokenManager<CodexSession>({
    provider: 'codex', displayName: 'Codex',
    makeOptions: () => ({
      preemptMs: 60_000,
      refresh: async () => {
        refreshes += 1
        if (revoked) throw new Error('invalid_grant')
        return { ...upgraded, accessToken: 'refreshed-' + refreshes }
      },
      isPermanent: error => error instanceof Error && error.message === 'invalid_grant',
    }),
    onAccountRemoved: account => { notified.push(account) },
    io: {
      list: () => listAccounts('codex', path),
      get: account => getAccountSession('codex', account, path),
      save: async (account, value) => {
        saved.push(account)
        await saveAccountSession('codex', account, value, path)
      },
      remove: async account => {
        removed.push(account)
        await deleteAccountSession('codex', account, path)
      },
      resolve: account => resolveAccountKey('codex', account, path),
    },
  })
  const originalManager = tokens.tokensFor(emailKey)
  await tokens.session()
  assert.equal(refreshes, 1)
  assert.equal(tokens.tokensFor(userKey), originalManager, 'rekey preserves the manager and its refresh lock')
  assert.equal(await resolveAccountKey('codex', emailKey, path), userKey)

  await deleteAccountSession('codex', userKey, path)
  assert.equal((await loadStore(path)).codex, undefined, 'last logout removes provider and aliases')
  await saveAccountSession('codex', userKey, { ...upgraded, accessToken: 'fresh-login' }, path)
  assert.equal((await listAccounts('codex', path)).length, 1)
  assert.equal(await getAccountSession('codex', emailKey, path), undefined)
  assert.equal((await tokens.session()).accessToken, 'fresh-login')
  assert.equal((await originalManager.peek())?.accessToken, 'fresh-login')

  // Force concurrent calls to exercise the same refresh lock after rekeying.
  const refreshed = await Promise.all([tokens.session(undefined, true), tokens.session(userKey, true)])
  assert.deepEqual(refreshed.map(value => value.accessToken), ['refreshed-2', 'refreshed-2'])
  assert.equal(refreshes, 2)
  assert.deepEqual(saved, [emailKey, userKey], 'subsequent saves use the current identity')

  revoked = true
  await assert.rejects(tokens.session(userKey, true),
    (error: unknown) => error instanceof LlmError && error.code === 'INVALID_CREDENTIAL')
  assert.deepEqual(removed, [userKey])
  assert.deepEqual(notified, [userKey])
  assert.deepEqual(await listAccounts('codex', path), [])
})

test('Codex migration does not overwrite a colliding canonical entry', async () => {
  const path = storePath()
  const alice = codexUser('alice')
  const key = accountKeyOf('codex', alice)
  writeFileSync(path, JSON.stringify({ codex: { default: CODEX.accountId, accounts: { [CODEX.accountId]: alice, [key]: { ...alice, refreshToken: 'other' } } } }))
  const entry = (await loadStore(path)).codex!
  assert.equal(Object.keys(entry.accounts).length, 2)
  assert.equal(entry.default, CODEX.accountId)
  assert.equal(entry.accounts[key].refreshToken, 'other')
})

test('two providers refreshing at once both keep their session', async () => {
  // The shape of a real double refresh: each adapter saves its own provider,
  // neither knows about the other. Unserialized, both read the same store and
  // the second write drops the first provider's entry.
  const path = storePath()
  await Promise.all([
    saveAccountSession('codex', 'acct-1', CODEX, path),
    saveAccountSession('claude', 'alice@example.com', CLAUDE, path),
  ])
  const store = await loadStore(path)
  assert.equal(store.codex?.accounts['acct-1']?.accessToken, CODEX.accessToken, 'the codex session survived')
  assert.equal(store.claude?.accounts['alice@example.com']?.accessToken, CLAUDE.accessToken, 'the claude session survived')
})

test('a logout concurrent with another provider’s save loses neither', async () => {
  const path = storePath()
  await saveAccountSession('codex', 'acct-1', CODEX, path)
  await Promise.all([
    deleteAccountSession('codex', 'acct-1', path),
    saveAccountSession('claude', 'alice@example.com', CLAUDE, path),
  ])
  const store = await loadStore(path)
  assert.equal(store.codex, undefined, 'the logout was not undone')
  assert.equal(store.claude?.accounts['alice@example.com']?.accessToken, CLAUDE.accessToken, 'the concurrent save was not lost')
})

test('two accounts of one provider refreshing at once both survive', async () => {
  const path = storePath()
  await saveAccountSession('claude', 'alice@example.com', CLAUDE, path)
  await Promise.all([
    saveAccountSession('claude', 'alice@example.com', { ...CLAUDE, accessToken: 'alice-new' }, path),
    saveAccountSession('claude', 'bob@example.com', { ...CLAUDE, emailAddress: 'bob@example.com' }, path),
  ])
  const accounts = await listAccounts('claude', path)
  assert.deepEqual(accounts.map(entry => entry.key), ['alice@example.com', 'bob@example.com'])
  assert.equal(accounts[0].session.accessToken, 'alice-new')
})

test('writes to one path settle in call order', async () => {
  const path = storePath()
  const writes = [
    saveAccountSession('claude', 'alice@example.com', { ...CLAUDE, accessToken: 'first' }, path),
    saveAccountSession('claude', 'alice@example.com', { ...CLAUDE, accessToken: 'second' }, path),
    saveAccountSession('claude', 'alice@example.com', { ...CLAUDE, accessToken: 'third' }, path),
  ]
  await Promise.all(writes)
  const store = await loadStore(path)
  assert.equal(store.claude?.accounts['alice@example.com']?.accessToken, 'third', 'the last caller wins')
})

test('the first account is the default; deleting it shifts the badge', async () => {
  const path = storePath()
  await saveAccountSession('claude', 'alice@example.com', CLAUDE, path)
  await saveAccountSession('claude', 'bob@example.com', { ...CLAUDE, emailAddress: 'bob@example.com' }, path)
  assert.equal((await listAccounts('claude', path))[0]?.key, 'alice@example.com')
  assert.equal((await getAccountSession('claude', undefined, path))?.accessToken, CLAUDE.accessToken)

  await setDefaultAccount('claude', 'bob@example.com', path)
  assert.equal((await listAccounts('claude', path))[0]?.key, 'bob@example.com')

  await deleteAccountSession('claude', 'bob@example.com', path)
  assert.equal((await listAccounts('claude', path))[0]?.key, 'alice@example.com')

  await setDefaultAccount('claude', 'nobody@example.com', path).then(
    () => assert.fail('setDefault of an unknown account must throw'),
    (error: unknown) => assert.match(String(error), /no claude account/),
  )
})

test('a single-account store migrates on read, preserving every field', async () => {
  const path = storePath()
  // The pre-multi-account durable shape: the bare session keyed by provider.
  writeFileSync(path, JSON.stringify({
    codex: { ...CODEX, emailAddress: 'alice@example.com', planType: 'pro' },
    claude: CLAUDE,
  }), { mode: 0o600 })
  const store = await loadStore(path)
  assert.deepEqual(store.codex, {
    default: accountKeyOf('codex', { ...CODEX, emailAddress: 'alice@example.com' }),
    aliases: { 'acct-1': accountKeyOf('codex', { ...CODEX, emailAddress: 'alice@example.com' }) },
    accounts: { [accountKeyOf('codex', { ...CODEX, emailAddress: 'alice@example.com' })]: { ...CODEX, emailAddress: 'alice@example.com', planType: 'pro' } },
  })
  assert.deepEqual(store.claude, {
    default: 'alice@example.com',
    accounts: { 'alice@example.com': CLAUDE },
  })
  // The migrated shape drives the new API directly.
  assert.equal((await getAccountSession('codex', undefined, path))?.accessToken, CODEX.accessToken)
  // …and the next write persists the new shape on disk.
  await saveAccountSession('codex', 'acct-1', CODEX, path)
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { accounts?: unknown }>
  assert.ok(onDisk.codex?.accounts !== undefined, 'the file now uses the accounts shape')
})

test('saveAccountSession rejects an empty-token session before it can poison the store', async () => {
  const path = storePath()
  await saveAccountSession('codex', 'acct-1', CODEX, path)
  const corrupt = { ...CLAUDE, accessToken: '', refreshToken: '', expiresAt: 0 }
  await saveAccountSession('claude', 'corrupt', corrupt, path).then(
    () => assert.fail('saving an empty-token session must throw'),
    (error: unknown) => assert.match(String(error), /missing accessToken\/refreshToken\/expiresAt/),
  )
  // The store survives intact: the earlier valid account is still readable.
  assert.equal((await getAccountSession('codex', undefined, path))?.accessToken, CODEX.accessToken)
})

test('one corrupt provider entry does not blind the other providers', async () => {
  const path = storePath()
  // The exact corruption seen in the wild: empty tokens under a claude key.
  writeFileSync(path, JSON.stringify({
    codex: { default: 'acct-1', accounts: { 'acct-1': CODEX } },
    claude: { default: 'corrupt', accounts: { corrupt: { accessToken: '', refreshToken: '', expiresAt: 0 } } },
  }), { mode: 0o600 })
  // Codex keeps its account; the corrupt claude entry is skipped, not fatal.
  assert.equal((await listAccounts('codex', path)).length, 1)
  assert.equal((await listAccounts('claude', path)).length, 0)
  // …and the next write persists the store without the corrupt entry.
  await saveAccountSession('codex', 'acct-1', CODEX, path)
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  assert.equal(onDisk.claude, undefined, 'the corrupt entry is dropped on the next write')
})

test('a valid account survives alongside a corrupt sibling of the same provider', async () => {
  const path = storePath()
  writeFileSync(path, JSON.stringify({
    codex: {
      default: 'acct-1',
      accounts: {
        'acct-1': CODEX,
        corrupt: { accessToken: '', refreshToken: '', expiresAt: 0 },
      },
    },
  }), { mode: 0o600 })
  const entries = await listAccounts('codex', path)
  assert.deepEqual(entries.map((entry) => entry.key), ['acct-1'], 'only the valid account is listed')
})

test('Codex config references resolve by unique email or workspace ID, never ambiguously', async () => {
  const path = storePath()
  const alice = { ...codexUser('alice-user'), emailAddress: 'Alice@Example.com' }
  const aliceKey = accountKeyOf('codex', alice)
  await saveAccountSession('codex', aliceKey, alice, path)
  assert.equal(await resolveAccountKey('codex', 'alice@example.com', path), aliceKey, 'login email resolves')
  assert.equal(await resolveAccountKey('codex', CODEX.accountId, path), aliceKey, 'sole workspace user resolves')
  assert.equal(await resolveAccountKey('codex', aliceKey, path), aliceKey, 'a real key is untouched')
  assert.equal(await resolveAccountKey('codex', 'nobody@example.com', path), 'nobody@example.com')

  const bob = { ...codexUser('bob-user'), emailAddress: 'bob@example.com' }
  await saveAccountSession('codex', accountKeyOf('codex', bob), bob, path)
  assert.equal(await resolveAccountKey('codex', CODEX.accountId, path), CODEX.accountId,
    'a shared workspace ID is ambiguous and stays unresolved')
  assert.equal(await resolveAccountKey('codex', 'bob@example.com', path), accountKeyOf('codex', bob))
  assert.equal(await resolveAccountKey('claude', 'alice@example.com', path), 'alice@example.com', 'other providers unchanged')
})
