import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROVIDER_IDS,
  accountKeyOf,
  compareAndDeleteQwenAccount,
  compareAndSaveQwenAccount,
  deleteAccountSession,
  deleteAndReturnQwenAccount,
  getAccountSession,
  listAccounts,
  loadStore,
  saveAccountSession,
  setDefaultAccount,
} from '../src/auth/store.js'
import type { ClaudeSession, QwenSession, SessionOf } from '../src/auth/store.js'
import { PROVIDER_TOOLS, ProviderSettingsStore, validatePreferences } from '../src/provider-settings.js'

const qwen: QwenSession = {
  accessToken: 'qwen-access',
  refreshToken: 'qwen-refresh',
  expiresAt: 1_900_000_000_000,
  account: 'alice@example.com',
  plan: 'free',
}

const claude: ClaudeSession = {
  accessToken: 'claude-access',
  refreshToken: 'claude-refresh',
  expiresAt: 1_900_000_000_000,
  scopes: 'user:inference',
  emailAddress: 'alice@example.com',
}

test('Qwen account keys use the identity or a stable refresh-token hash', () => {
  // The mapped session type must expose the Qwen-specific optional fields.
  const session: SessionOf<'qwen-subscription'> = qwen
  assert.ok(PROVIDER_IDS.includes('qwen-subscription'))
  assert.equal(accountKeyOf('qwen-subscription', session), 'alice@example.com')
  const anonymous = { accessToken: 'access', refreshToken: 'secret', expiresAt: 42 }
  const expected = 'token-' + createHash('sha256').update('secret').digest('hex').slice(0, 16)
  assert.equal(accountKeyOf('qwen-subscription', anonymous), expected)
  assert.equal(accountKeyOf('qwen-subscription', { ...anonymous, accessToken: 'new-access' }), expected)
  assert.notEqual(accountKeyOf('qwen-subscription', { ...anonymous, refreshToken: 'different' }), expected)
  assert.ok(!expected.includes('secret'))
})

test('Qwen accounts persist independently and preserve default across token rotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-store-'))
  const path = join(dir, 'auth.json')
  try {
    const aliceKey = accountKeyOf('qwen-subscription', qwen)
    const bob: QwenSession = { accessToken: 'bob-access', refreshToken: 'bob-refresh', expiresAt: 42, account: 'bob@example.com' }
    const bobKey = accountKeyOf('qwen-subscription', bob)
    await Promise.all([
      saveAccountSession('qwen-subscription', aliceKey, qwen, path),
      saveAccountSession('qwen-subscription', bobKey, bob, path),
      saveAccountSession('claude', 'alice@example.com', claude, path),
    ])
    assert.deepEqual(await listAccounts('qwen-subscription', path), [
      { key: aliceKey, session: qwen },
      { key: bobKey, session: bob },
    ])
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.deepEqual(await getAccountSession('qwen-subscription', undefined, path), qwen)
    assert.deepEqual(await getAccountSession('claude', undefined, path), claude)

    await setDefaultAccount('qwen-subscription', bobKey, path)
    const rotated = { ...bob, accessToken: 'rotated-access', refreshToken: 'rotated-refresh', plan: 'pro' }
    await saveAccountSession('qwen-subscription', bobKey, rotated, path)
    assert.deepEqual(await getAccountSession('qwen-subscription', undefined, path), rotated)
    assert.deepEqual((await listAccounts('qwen-subscription', path)).map(entry => entry.key), [bobKey, aliceKey])
    await deleteAccountSession('qwen-subscription', bobKey, path)
    assert.deepEqual(await getAccountSession('qwen-subscription', undefined, path), qwen)
    assert.deepEqual(await getAccountSession('claude', undefined, path), claude)
    await deleteAccountSession('qwen-subscription', aliceKey, path)
    assert.equal((await loadStore(path))['qwen-subscription'], undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy Qwen sessions migrate and invalid writes cannot poison the store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-migration-'))
  const path = join(dir, 'auth.json')
  try {
    await writeFile(path, JSON.stringify({ qwen, claude }), { mode: 0o600 })
    assert.deepEqual((await loadStore(path))['qwen-subscription'], {
      default: 'alice@example.com',
      accounts: { 'alice@example.com': qwen },
    })
    for (const invalid of [
      { ...qwen, accessToken: '' },
      { ...qwen, refreshToken: '' },
      { ...qwen, expiresAt: NaN },
    ]) {
      await assert.rejects(saveAccountSession('qwen-subscription', 'bad', invalid, path), /missing accessToken\/refreshToken\/expiresAt/)
    }
    await saveAccountSession('qwen-subscription', 'alice@example.com', qwen, path)
    const disk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    assert.deepEqual(disk['qwen-subscription'], { default: 'alice@example.com', accounts: { 'alice@example.com': qwen } })
    assert.deepEqual(await getAccountSession('claude', undefined, path), claude)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy and current Qwen stores merge without losing credentials or resurrecting logout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-coexist-'))
  const path = join(dir, 'auth.json')
  const oldAlice = qwen
  const newAlice = { ...qwen, accessToken: 'new-access', refreshToken: 'new-refresh' }
  const bob = { ...qwen, account: 'bob', refreshToken: 'bob-refresh' }
  const carol = { ...qwen, account: 'carol', refreshToken: 'carol-refresh' }
  const other = { some: 'unrelated data' }
  const input = {
    qwen: { default: 'alice', accounts: { alice: oldAlice, bob }, aliases: { oldAlice: 'alice', shared: 'bob' } },
    'qwen-subscription': { default: 'carol', accounts: { alice: newAlice, carol }, aliases: { shared: 'carol' } },
    claude: { default: 'alice@example.com', accounts: { 'alice@example.com': claude } },
    anotherProvider: other,
  }
  try {
    await writeFile(path, JSON.stringify(input), { mode: 0o600 })
    const entry = (await loadStore(path))['qwen-subscription']!
    assert.equal(entry.default, 'carol')
    assert.deepEqual(entry.accounts.alice, newAlice)
    assert.deepEqual(entry.accounts['alice (legacy qwen)'], oldAlice)
    assert.deepEqual(entry.accounts.bob, bob)
    assert.equal(entry.aliases?.oldAlice, 'alice (legacy qwen)')
    assert.equal(entry.aliases?.shared, 'carol')
    assert.deepEqual(await getAccountSession('qwen-subscription', 'oldAlice', path), oldAlice)
    assert.deepEqual(await getAccountSession('qwen-subscription', 'shared', path), carol)
    await assert.rejects(
      saveAccountSession('qwen-subscription', accountKeyOf('qwen-subscription', oldAlice), { ...oldAlice, refreshToken: 'another-login' }, path),
      /identity is ambiguous/,
    )
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), input, 'read or rejected ambiguous login never rewrites the source')
    await deleteAccountSession('qwen-subscription', 'alice', path)
    const disk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    assert.equal(disk.qwen, undefined)
    assert.deepEqual(disk.anotherProvider, other)
    assert.deepEqual(disk.claude, input.claude)
    assert.equal(await getAccountSession('qwen-subscription', 'alice', path), undefined)
    assert.deepEqual(await getAccountSession('qwen-subscription', 'oldAlice', path), oldAlice)
    const relogged = { ...oldAlice, refreshToken: 'logged-in-again' }
    await saveAccountSession('qwen-subscription', accountKeyOf('qwen-subscription', relogged), relogged, path)
    assert.deepEqual(await getAccountSession('qwen-subscription', 'oldAlice', path), relogged)
    assert.equal(await getAccountSession('qwen-subscription', 'alice', path), undefined)
    await deleteAccountSession('qwen-subscription', 'oldAlice', path)
    assert.equal(await getAccountSession('qwen-subscription', 'oldAlice', path), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('legacy Qwen settings and history migrate on next write without changing other providers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-settings-migrate-'))
  const path = join(dir, 'settings.json')
  const legacy = { displayName: 'Legacy', visibleModels: ['qwen-real-model'], modelDisplayNames: { old: 'Old', same: 'Old name' }, accounts: { alice: { alias: 'Old account', poolEnabled: false } } }
  const current = { displayName: 'Current', modelDisplayNames: { same: 'New name' }, accounts: { alice: { independentEntry: true }, bob: { alias: 'Bob' } } }
  const codex = { displayName: 'Codex', tools: { web_search: false } }
  try {
    const input = { providers: { qwen: legacy, 'qwen-subscription': current, codex, unknown: { value: 1 } }, toolHistory: [{ at: 1, provider: 'qwen', tools: {} }, { at: 2, provider: 'codex', tools: { web_search: false } }] }
    await writeFile(path, JSON.stringify(input))
    const store = new ProviderSettingsStore(path)
    const qwenSettings = store.get('qwen-subscription')
    assert.equal(qwenSettings.displayName, 'Current')
    assert.deepEqual(qwenSettings.visibleModels, ['qwen-real-model'])
    assert.deepEqual(qwenSettings.modelDisplayNames, { old: 'Old', same: 'New name' })
    assert.deepEqual(qwenSettings.accounts?.alice, { alias: 'Old account', poolEnabled: false, independentEntry: true })
    assert.deepEqual(qwenSettings.accounts?.bob, { alias: 'Bob' })
    assert.equal(store.toolEnabled('codex', 'web_search', 3), false)
    await store.set('claude', { displayName: 'Claude' })
    const disk = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(disk.providers.qwen, undefined)
    assert.deepEqual(disk.providers.unknown, { value: 1 })
    assert.deepEqual(disk.providers.codex, codex)
    assert.deepEqual(disk.legacyQwenPreferences, legacy)
    assert.deepEqual(disk.toolHistory, [{ at: 1, provider: 'qwen-subscription', tools: {} }, { at: 2, provider: 'codex', tools: { web_search: false } }])
    assert.deepEqual(new ProviderSettingsStore(path).get('qwen-subscription'), qwenSettings)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Qwen compare-and-save serializes competing refreshes and returns the winner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-compare-save-'))
  const path = join(dir, 'auth.json')
  const key = accountKeyOf('qwen-subscription', qwen)
  const first = { ...qwen, accessToken: 'first-access', refreshToken: 'first-refresh' }
  const second = { ...qwen, accessToken: 'second-access', refreshToken: 'second-refresh' }
  try {
    await saveAccountSession('qwen-subscription', key, qwen, path)
    const [firstResult, secondResult] = await Promise.all([
      compareAndSaveQwenAccount(key, qwen.refreshToken, first, path),
      compareAndSaveQwenAccount(key, qwen.refreshToken, second, path),
    ])
    assert.deepEqual(firstResult, first)
    assert.deepEqual(secondResult, first, 'the losing refresh observes the already-committed session')
    assert.deepEqual(await getAccountSession('qwen-subscription', key, path), first)
    const before = await readFile(path, 'utf8')
    assert.deepEqual(await compareAndSaveQwenAccount(key, qwen.refreshToken, second, path), first)
    assert.equal(await readFile(path, 'utf8'), before, 'a failed comparison does not write')
    await assert.rejects(compareAndSaveQwenAccount(key, first.refreshToken, { ...first, refreshToken: '' }, path), /missing accessToken\/refreshToken\/expiresAt/)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, path), first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Qwen refresh cannot resurrect logout or overwrite a newer login', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-compare-login-'))
  const path = join(dir, 'auth.json')
  const key = accountKeyOf('qwen-subscription', qwen)
  const refreshed = { ...qwen, accessToken: 'refresh-access', refreshToken: 'refresh-rotated' }
  const relogged = { ...qwen, accessToken: 'login-access', refreshToken: 'login-refresh', plan: 'pro' }
  try {
    await saveAccountSession('qwen-subscription', key, qwen, path)
    const [, afterLogout] = await Promise.all([
      deleteAccountSession('qwen-subscription', key, path),
      compareAndSaveQwenAccount(key, qwen.refreshToken, refreshed, path),
    ])
    assert.equal(afterLogout, undefined)
    assert.equal(await getAccountSession('qwen-subscription', key, path), undefined)
    const [, afterRelogin] = await Promise.all([
      saveAccountSession('qwen-subscription', key, relogged, path),
      compareAndSaveQwenAccount(key, qwen.refreshToken, refreshed, path),
    ])
    assert.deepEqual(afterRelogin, relogged)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, path), relogged)
    // A refresh queued before logout may complete, but logout still wins.
    await Promise.all([
      compareAndSaveQwenAccount(key, relogged.refreshToken, refreshed, path),
      deleteAccountSession('qwen-subscription', key, path),
    ])
    assert.equal(await getAccountSession('qwen-subscription', key, path), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Qwen compare-and-delete never removes a newer login after a stale invalid_grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-compare-delete-'))
  const path = join(dir, 'auth.json')
  const key = accountKeyOf('qwen-subscription', qwen)
  const relogged = { ...qwen, accessToken: 'new-access', refreshToken: 'new-refresh' }
  const bob: QwenSession = { accessToken: 'bob-access', refreshToken: 'bob-refresh', expiresAt: 42, account: 'bob@example.com' }
  try {
    await saveAccountSession('qwen-subscription', key, qwen, path)
    await saveAccountSession('qwen-subscription', bob.account!, bob, path)
    await saveAccountSession('claude', 'alice@example.com', claude, path)
    const [, deletedStale] = await Promise.all([
      saveAccountSession('qwen-subscription', key, relogged, path),
      compareAndDeleteQwenAccount(key, qwen.refreshToken, path),
    ])
    assert.equal(deletedStale, false)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, path), relogged)
    assert.equal(await compareAndDeleteQwenAccount('missing', qwen.refreshToken, path), false)
    assert.equal(await compareAndDeleteQwenAccount(key, relogged.refreshToken, path), true)
    assert.deepEqual(await getAccountSession('qwen-subscription', undefined, path), bob, 'default advances to the remaining account')
    assert.deepEqual(await getAccountSession('claude', undefined, path), claude)
    assert.equal(await compareAndDeleteQwenAccount(bob.account!, bob.refreshToken, path), true)
    assert.equal((await loadStore(path))['qwen-subscription'], undefined)
    assert.equal(await compareAndDeleteQwenAccount(key, relogged.refreshToken, path), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Qwen compare-and-save and compare-and-delete resolve recorded aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-compare-alias-'))
  const path = join(dir, 'auth.json')
  const refreshed = { ...qwen, accessToken: 'new-access', refreshToken: 'new-refresh' }
  try {
    await writeFile(path, JSON.stringify({ qwen: { default: 'alice', accounts: { alice: qwen }, aliases: { old: 'alice' } } }), { mode: 0o600 })
    assert.deepEqual(await compareAndSaveQwenAccount('old', qwen.refreshToken, refreshed, path), refreshed)
    assert.deepEqual(await getAccountSession('qwen-subscription', 'alice', path), refreshed)
    assert.equal(await compareAndDeleteQwenAccount('old', refreshed.refreshToken, path), true)
    assert.equal((await loadStore(path))['qwen-subscription'], undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Qwen logout removes and returns whichever session won the transaction queue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-logout-transaction-'))
  const path = join(dir, 'auth.json')
  const key = accountKeyOf('qwen-subscription', qwen)
  const refreshed = { ...qwen, accessToken: 'rotated-access', refreshToken: 'rotated-refresh' }
  const relogged = { ...qwen, accessToken: 'new-login', refreshToken: 'new-login-refresh' }
  const bob: QwenSession = { accessToken: 'bob-access', refreshToken: 'bob-refresh', expiresAt: 42, account: 'bob@example.com' }
  try {
    await saveAccountSession('qwen-subscription', key, qwen, path)
    await saveAccountSession('qwen-subscription', bob.account!, bob, path)
    await saveAccountSession('claude', 'alice@example.com', claude, path)
    const [rotationResult, removedAfterRotation] = await Promise.all([
      compareAndSaveQwenAccount(key, qwen.refreshToken, refreshed, path),
      deleteAndReturnQwenAccount(key, path),
    ])
    assert.deepEqual(rotationResult, refreshed)
    assert.deepEqual(removedAfterRotation, refreshed, 'logout returns the rotated token actually removed')
    assert.equal(await getAccountSession('qwen-subscription', key, path), undefined)
    assert.deepEqual(await getAccountSession('qwen-subscription', undefined, path), bob, 'default moves to the remaining account')
    assert.deepEqual(await getAccountSession('claude', undefined, path), claude)
    assert.equal(await deleteAndReturnQwenAccount(key, path), undefined)

    await saveAccountSession('qwen-subscription', key, qwen, path)
    const [removedBeforeRotation, staleRotation] = await Promise.all([
      deleteAndReturnQwenAccount(key, path),
      compareAndSaveQwenAccount(key, qwen.refreshToken, refreshed, path),
    ])
    assert.deepEqual(removedBeforeRotation, qwen)
    assert.equal(staleRotation, undefined, 'a late refresh cannot resurrect the logged-out account')

    await saveAccountSession('qwen-subscription', key, qwen, path)
    const [, removedAfterLogin] = await Promise.all([
      saveAccountSession('qwen-subscription', key, relogged, path),
      deleteAndReturnQwenAccount(key, path),
    ])
    assert.deepEqual(removedAfterLogin, relogged, 'returns the intervening login, not a prior snapshot')
    await saveAccountSession('qwen-subscription', key, qwen, path)
    const [removedBeforeLogin] = await Promise.all([
      deleteAndReturnQwenAccount(key, path),
      saveAccountSession('qwen-subscription', key, relogged, path),
    ])
    assert.deepEqual(removedBeforeLogin, qwen)
    assert.deepEqual(await getAccountSession('qwen-subscription', key, path), relogged, 'later login survives logout')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Qwen transactional logout resolves aliases and removes the last provider entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-logout-alias-'))
  const path = join(dir, 'auth.json')
  try {
    await writeFile(path, JSON.stringify({ qwen: { default: 'alice', accounts: { alice: qwen }, aliases: { old: 'alice' } } }), { mode: 0o600 })
    assert.equal(await deleteAndReturnQwenAccount('missing', path), undefined)
    assert.deepEqual(await deleteAndReturnQwenAccount('old', path), qwen)
    assert.equal((await loadStore(path))['qwen-subscription'], undefined)
    assert.equal(await deleteAndReturnQwenAccount('old', path), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Qwen settings survive reload and reject unsupported subscription tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-settings-'))
  const path = join(dir, 'settings.json')
  try {
    assert.deepEqual(PROVIDER_TOOLS['qwen-subscription'], [])
    assert.throws(() => validatePreferences('qwen-subscription', { tools: { web_search: true } }), /unsupported tool setting: qwen-subscription\/web_search/)
    const settings = new ProviderSettingsStore(path)
    await settings.set('qwen-subscription', { displayName: 'Qwen Work', visibleModels: ['qwen-coder'], tools: {} })
    const restored = new ProviderSettingsStore(path)
    assert.deepEqual(restored.get('qwen-subscription'), { displayName: 'Qwen Work', visibleModels: ['qwen-coder'], tools: {} })
    assert.equal(restored.visible('qwen-subscription', 'qwen-coder'), true)
    assert.equal(restored.visible('qwen-subscription', 'another'), false)
    const disk = JSON.parse(await readFile(path, 'utf8')) as { toolHistory: unknown[] }
    assert.deepEqual(disk.toolHistory, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
