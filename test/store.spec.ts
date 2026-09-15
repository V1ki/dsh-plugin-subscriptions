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
  saveAccountSession,
  setDefaultAccount,
} from '../src/auth/store.js'
import type { ClaudeSession, CodexSession } from '../src/auth/store.js'

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
