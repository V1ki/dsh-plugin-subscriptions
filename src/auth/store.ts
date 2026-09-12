/**
 * On-disk OAuth session store at `~/.dsh/plugins/subscriptions/auth.json`.
 *
 * The file is a JSON object keyed by provider id, each entry holding that
 * provider's ACCOUNTS: a map of account key → session plus the default
 * account's key. Writes are atomic (tmp file + rename) with mode 0600
 * because they carry bearer tokens. Session shapes live here (not in the
 * provider modules) because this file owns the durable format.
 *
 * Backward compatibility: entries written by single-account versions hold
 * the session fields directly (no `accounts` wrapper); reads migrate them
 * in memory, and the next write persists the new shape — existing logins
 * survive the upgrade untouched.
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Provider routes this plugin can serve. */
export type ProviderId = 'codex' | 'claude' | 'grok' | 'copilot'

/** Every provider route, in display order. */
export const PROVIDER_IDS: readonly ProviderId[] = ['codex', 'claude', 'grok', 'copilot']

/** Stored ChatGPT/Codex subscription session. */
export interface CodexSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** `chatgpt_account_id` claim from the id token; sent as the `chatgpt-account-id` header. */
  accountId: string
  idToken?: string
  /** User email from the id token, when the token carried it. */
  emailAddress?: string
  /** `chatgpt_plan_type` claim from the id token (e.g. `plus`, `pro`), when present. */
  planType?: string
}

/** Stored Claude Pro/Max subscription session. */
export interface ClaudeSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** Scope string the tokens were issued with; echoed on refresh. */
  scopes: string
  emailAddress?: string
  subscriptionType?: string
  /**
   * True when this account was imported from Claude Code's own credential
   * store (Keychain/file): only bound accounts sync refreshes back to it.
   */
  keychainBound?: boolean
}

/** Stored Grok (X Premium / xAI) subscription session. */
export interface GrokSession {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number
  /** Token endpoint from OIDC discovery; retained for refreshes. */
  tokenEndpoint: string
  scopes?: string
  /** Display account: email, username, or subject claim from the id token. */
  account?: string
}

/**
 * Stored GitHub Copilot subscription session. Two token generations are at
 * play: the long-lived GitHub OAuth token from the device flow is kept in
 * `refreshToken`, and `accessToken` carries the short-lived (~30 minutes)
 * Copilot API token exchanged from it. A "refresh" is therefore a fresh
 * exchange against `copilot_internal/v2/token`, not an OAuth grant.
 */
export interface CopilotSession {
  /** Copilot API token; sent as the bearer on api.githubcopilot.com. */
  accessToken: string
  /** Long-lived GitHub OAuth token from the device flow. */
  refreshToken: string
  /** Epoch milliseconds at which the Copilot API token expires. */
  expiresAt: number
  /** GitHub login name, for the status display. */
  account?: string
}

/** One provider's accounts: account key → session, plus the default account. */
export interface ProviderAccounts<S> {
  /** Key of the account direct (non-pool) routes serve; the first login wins. */
  default?: string
  accounts: Record<string, S>
}

/** The durable store shape: per provider, its accounts. */
export interface SessionMap {
  codex?: ProviderAccounts<CodexSession>
  claude?: ProviderAccounts<ClaudeSession>
  grok?: ProviderAccounts<GrokSession>
  copilot?: ProviderAccounts<CopilotSession>
}

/** Any stored session, for provider-agnostic plumbing. */
export type StoredSession = CodexSession | ClaudeSession | GrokSession | CopilotSession

/** The session type one provider stores. */
export type SessionOf<K extends ProviderId> = NonNullable<SessionMap[K]>['accounts'][string]

/** One account entry as returned by {@link listAccounts} (default first). */
export interface AccountEntry<S> {
  key: string
  session: S
}

/**
 * The stable identity of one session's account: codex keys on the always
 * present `accountId` claim, the others on their display identity, falling
 * back to a refresh-token hash for sessions stored before identity fields
 * existed. Logging the same account in again lands on the same key, so a
 * re-login updates in place instead of duplicating. (The hash fallback can
 * miss that dedup once for a legacy session re-logged with a now-known
 * identity — the duplicate is visible on the Settings page and can simply
 * be logged out.)
 * @param provider - the provider route.
 * @param session - the session to key.
 * @returns the account map key.
 */
export function accountKeyOf(provider: ProviderId, session: StoredSession): string {
  switch (provider) {
    case 'codex':
      return (session as CodexSession).accountId
    case 'claude':
      return (session as ClaudeSession).emailAddress ?? tokenHash(session.refreshToken)
    case 'grok':
      return (session as GrokSession).account ?? tokenHash(session.refreshToken)
    case 'copilot':
      return (session as CopilotSession).account ?? tokenHash(session.refreshToken)
  }
}

/** Short stable hash for sessions without an identity field. */
function tokenHash(refreshToken: string): string {
  return `token-${createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)}`
}

/**
 * Absolute path of the auth store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
 */
export function authFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'auth.json')
}

/** Store location used before the plugin was renamed; migrated on first read. */
function legacyAuthFilePath(): string {
  return dshHomePath('plugins', 'router', 'auth.json')
}

/** Check that one durable session carries the fields every session needs. */
function assertSessionShape(provider: ProviderId, account: string, value: unknown): asserts value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`subscriptions auth store: entry "${provider}/${account}" is not an object; fix or delete the store file`)
  }
  const entry = value as Record<string, unknown>
  if (typeof entry.accessToken !== 'string' || entry.accessToken.length === 0
    || typeof entry.refreshToken !== 'string' || entry.refreshToken.length === 0
    || typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) {
    throw new Error(
      `subscriptions auth store: entry "${provider}/${account}" is missing accessToken/refreshToken/expiresAt; fix or delete the store file`,
    )
  }
}

/**
 * Read the whole store. A missing file is an empty store; malformed JSON or a
 * malformed entry throws, because silently discarding tokens would strand the
 * user without a diagnosis. Single-account entries are migrated in memory;
 * the next write persists the new shape.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the parsed session map.
 */
export async function loadStore(path = authFilePath()): Promise<SessionMap> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Migrate the pre-rename store once, preserving existing logins.
    if (path !== authFilePath()) return {}
    try {
      text = await readFile(legacyAuthFilePath(), 'utf8')
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw legacyError
    }
    const migrated = parseStore(text, legacyAuthFilePath())
    await writeStore(migrated, path)
    await rm(legacyAuthFilePath(), { force: true })
    return migrated
  }
  return parseStore(text, path)
}

/**
 * Parse and migrate store JSON read from `path`. An ACCOUNT entry whose shape
 * is invalid (empty or missing tokens — corruption seen in the wild from a
 * broken keychain import) is SKIPPED instead of rejected: one bad entry must
 * not blind every provider's status read, and a session without tokens is
 * unusable by definition, so nothing of value is discarded. The next write
 * persists the store without the skipped entry. Structural failures (invalid
 * JSON, a non-object file) still throw — those say the file itself is broken.
 */
function parseStore(text: string, path: string): SessionMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`subscriptions auth store at ${path} is not valid JSON; fix or delete the file`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`)
  }
  const raw = parsed as Record<string, unknown>
  const store: SessionMap = {}
  for (const provider of PROVIDER_IDS) {
    const entry = raw[provider]
    if (entry === undefined) continue
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      console.warn(`subscriptions auth store: entry "${provider}" is not an object; skipped`)
      continue
    }
    const record = entry as Record<string, unknown>
    if (typeof record.accessToken === 'string') {
      // Single-account format: wrap the bare session, preserving every field.
      if (!isValidSessionShape(record)) {
        console.warn(`subscriptions auth store: legacy entry "${provider}" has no usable tokens; skipped`)
        continue
      }
      const session = record as unknown as StoredSession
      const key = accountKeyOf(provider, session)
      ;(store as Record<string, unknown>)[provider] = { default: key, accounts: { [key]: session } }
      continue
    }
    const accounts = record.accounts
    if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) {
      console.warn(`subscriptions auth store: entry "${provider}" has no accounts map; skipped`)
      continue
    }
    if (record.default !== undefined && typeof record.default !== 'string') {
      console.warn(`subscriptions auth store: entry "${provider}" default is not a string; skipped`)
      continue
    }
    const kept: Record<string, StoredSession> = {}
    for (const [account, session] of Object.entries(accounts)) {
      if (isValidSessionShape(session)) {
        kept[account] = session as StoredSession
      } else {
        console.warn(
          `subscriptions auth store: entry "${provider}/${account}" has no usable accessToken/refreshToken/expiresAt; skipped`,
        )
      }
    }
    if (Object.keys(kept).length === 0) continue
    const validDefault = record.default === undefined || record.default in kept
      ? record.default as string | undefined
      : Object.keys(kept)[0]
    ;(store as Record<string, unknown>)[provider] = { ...record, default: validDefault, accounts: kept }
  }
  return store
}

/** Whether a value carries the fields every stored session needs (non-empty tokens). */
function isValidSessionShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.accessToken === 'string' && entry.accessToken.length > 0
    && typeof entry.refreshToken === 'string' && entry.refreshToken.length > 0
    && typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
}

/** Persist the whole store atomically with owner-only permissions. */
async function writeStore(store: SessionMap, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
    // An existing destination keeps its old mode through rename on some
    // filesystems; enforce 0600 on the source before the swap.
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * One write chain per store path. Every mutation is a read-modify-write of a
 * single JSON file, and the plugin has several independent writers — a login,
 * a logout, and one token refresh per provider account, each on its own
 * schedule. Overlapping them unserialized costs whichever account read the
 * store first its entry.
 *
 * A chain is dropped once nothing is queued behind it, so the map holds an
 * entry only while writes are in flight.
 */
const writeChains = new Map<string, Promise<unknown>>()

/**
 * Run one read-modify-write of a store path after every write already queued
 * for it. Callers join the chain synchronously, so call order is write order.
 * @param path - the store file being mutated.
 * @param action - the read-modify-write to run.
 * @returns whatever `action` returns.
 */
async function serialize<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  // Both handlers: a failed write must not strand everything queued behind it.
  const next = previous.then(action, action)
  const tail = next.then(() => undefined, () => undefined)
  writeChains.set(path, tail)
  try {
    return await next
  } finally {
    if (writeChains.get(path) === tail) writeChains.delete(path)
  }
}

/**
 * List one provider's accounts, default first.
 * @param provider - the provider route.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the account entries in stable order (empty when logged out).
 */
export async function listAccounts<K extends ProviderId>(
  provider: K,
  path = authFilePath(),
): Promise<AccountEntry<SessionOf<K>>[]> {
  const entry = (await loadStore(path))[provider]
  if (entry === undefined) return []
  const accounts = Object.entries(entry.accounts).map(([key, session]) => ({ key, session }))
  accounts.sort((a, b) => Number(b.key === entry.default) - Number(a.key === entry.default))
  return accounts
}

/**
 * Read one account's session.
 * @param provider - the provider route.
 * @param account - the account key; defaults to the provider's default account.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the stored session, or `undefined` when absent.
 */
export async function getAccountSession<K extends ProviderId>(
  provider: K,
  account?: string,
  path = authFilePath(),
): Promise<SessionOf<K> | undefined> {
  const entry = (await loadStore(path))[provider]
  if (entry === undefined) return undefined
  const key = account ?? entry.default
  if (key === undefined) return undefined
  return entry.accounts[key] as SessionOf<K> | undefined
}

/**
 * Write one account's session, preserving the others. The first account of a
 * provider becomes its default.
 *
 * The session is validated before it lands: a corrupt entry written here
 * would fail every later read of the whole store (one bad entry breaks all
 * providers' status), so the write path must be as strict as the read path.
 * @param provider - the provider route.
 * @param account - the account key (see {@link accountKeyOf}).
 * @param session - the fresh session from a login or refresh.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @throws when the session is missing accessToken/refreshToken/expiresAt.
 */
export async function saveAccountSession<K extends ProviderId>(
  provider: K,
  account: string,
  session: SessionOf<K>,
  path = authFilePath(),
): Promise<void> {
  assertSessionShape(provider, account, session)
  return serialize(path, async () => {
    const store = await loadStore(path)
    const entry = store[provider] as ProviderAccounts<SessionOf<K>> | undefined
    ;(store as Record<string, unknown>)[provider] = {
      default: entry?.default ?? account,
      accounts: { ...entry?.accounts, [account]: session },
    } satisfies ProviderAccounts<SessionOf<K>>
    await writeStore(store, path)
  })
}

/**
 * Delete one account's session (logout). Deleting the default moves the badge
 * to the next remaining account.
 * @param provider - the provider route.
 * @param account - the account key.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function deleteAccountSession(
  provider: ProviderId,
  account: string,
  path = authFilePath(),
): Promise<void> {
  return serialize(path, async () => {
    const store = await loadStore(path)
    const entry = store[provider]
    if (entry === undefined || !(account in entry.accounts)) return
    const accounts = { ...entry.accounts }
    delete accounts[account]
    if (Object.keys(accounts).length === 0) {
      delete store[provider]
    } else {
      ;(store as Record<string, unknown>)[provider] = {
        ...entry.default === account ? { default: Object.keys(accounts)[0] } : { default: entry.default },
        accounts,
      }
    }
    await writeStore(store, path)
  })
}

/**
 * Pin the account direct (non-pool) routes serve.
 * @param provider - the provider route.
 * @param account - the account key; must exist.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function setDefaultAccount(
  provider: ProviderId,
  account: string,
  path = authFilePath(),
): Promise<void> {
  return serialize(path, async () => {
    const store = await loadStore(path)
    const entry = store[provider]
    if (entry === undefined || !(account in entry.accounts)) {
      throw new Error(`no ${provider} account "${account}" is logged in`)
    }
    ;(store as Record<string, unknown>)[provider] = { ...entry, default: account }
    await writeStore(store, path)
  })
}
