import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaudeSession } from './store.js'

const PRIMARY_SERVICE = 'Claude Code-credentials'

interface RawCreds {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scopes?: string[] | string
  subscriptionType?: string
  emailAddress?: string
}

interface CredentialBlob {
  claudeAiOauth?: RawCreds
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scopes?: string[] | string
  subscriptionType?: string
  emailAddress?: string
}

const DEFAULT_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers'

function toSession(data: RawCreds): ClaudeSession | undefined {
  // Empty-string tokens (seen from a corrupted Keychain item left by a Claude
  // Code logout) pass the typeof gate but are useless and would poison the
  // auth store — a single such entry fails every provider's status read.
  if (typeof data.accessToken !== 'string' || data.accessToken.length === 0
    || typeof data.refreshToken !== 'string' || data.refreshToken.length === 0
    || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) {
    return undefined
  }
  const scopes = Array.isArray(data.scopes) ? data.scopes.join(' ') : typeof data.scopes === 'string' ? data.scopes : DEFAULT_SCOPES
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Math.trunc(data.expiresAt),
    scopes,
    ...typeof data.emailAddress === 'string' ? { emailAddress: data.emailAddress } : {},
    ...typeof data.subscriptionType === 'string' ? { subscriptionType: data.subscriptionType } : {},
  }
}

function parseBlob(raw: string): ClaudeSession | undefined {
  let parsed: CredentialBlob
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return toSession(parsed.claudeAiOauth ?? parsed)
}

function credentialsFilePath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json')
}

function readKeychainRaw(): string | undefined {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', PRIMARY_SERVICE, '-w'], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return undefined
  }
}

function readFileRaw(): string | undefined {
  try {
    return readFileSync(credentialsFilePath(), 'utf8')
  } catch {
    return undefined
  }
}

/** Read the current Claude Code session from its source of truth: macOS Keychain, falling back to the credentials file. */
export function readClaudeCodeCredentials(): ClaudeSession | undefined {
  if (process.platform === 'darwin') {
    const raw = readKeychainRaw()
    const session = raw !== undefined ? parseBlob(raw) : undefined
    if (session) return session
  }
  const raw = readFileRaw()
  return raw !== undefined ? parseBlob(raw) : undefined
}

function blobMatches(raw: string, expectedAccessToken: string): boolean {
  return parseBlob(raw)?.accessToken === expectedAccessToken
}

function getKeychainAccountName(): string | undefined {
  try {
    const output = execFileSync('/usr/bin/security', ['find-generic-password', '-s', PRIMARY_SERVICE], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return /"acct"<blob>="([^"]*)"/.exec(output)?.[1]
  } catch {
    return undefined
  }
}

/** Merge fresh tokens into an existing raw blob, preserving unrelated fields. */
function mergeIntoBlob(existingRaw: string, next: ClaudeSession): string | undefined {
  let parsed: CredentialBlob
  try {
    parsed = JSON.parse(existingRaw)
  } catch {
    return undefined
  }
  const target = (parsed.claudeAiOauth ?? parsed) as RawCreds
  target.accessToken = next.accessToken
  target.refreshToken = next.refreshToken
  target.expiresAt = next.expiresAt
  return JSON.stringify(parsed)
}

/**
 * Write a refreshed session back to Claude Code's own credential store, so
 * the `claude` CLI and any other consumer of the same account see the token
 * we just rotated. A stale-blob mismatch (something else rotated it first)
 * is a no-op — the caller already has that other rotation via readClaudeCodeCredentials.
 * @param next - the freshly refreshed session to persist.
 * @param expectedPriorAccessToken - the access token this refresh started from.
 * @returns whether the write-back succeeded.
 */
export function writeBackClaudeCodeCredentials(next: ClaudeSession, expectedPriorAccessToken: string): boolean {
  if (process.platform === 'darwin') {
    const raw = readKeychainRaw()
    if (raw === undefined || !blobMatches(raw, expectedPriorAccessToken)) return false
    const updated = mergeIntoBlob(raw, next)
    if (updated === undefined) return false
    const account = getKeychainAccountName() ?? PRIMARY_SERVICE
    try {
      execFileSync('/usr/bin/security', ['add-generic-password', '-s', PRIMARY_SERVICE, '-a', account, '-w', updated, '-U'], {
        timeout: 2000,
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }
  const path = credentialsFilePath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  if (!blobMatches(raw, expectedPriorAccessToken)) return false
  const updated = mergeIntoBlob(raw, next)
  if (updated === undefined) return false
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(path, updated, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
    return true
  } catch {
    return false
  }
}

/**
 * Refresh a Claude session, first checking whether Claude Code's own store
 * already holds a fresher token (rotated by the `claude` CLI or another
 * consumer) before hitting the OAuth endpoint ourselves — and writing our own
 * refresh back to that store so every consumer of the account stays synced.
 * @param session - the session TokenManager wants refreshed.
 * @param doRefresh - the actual OAuth refresh-token grant (network call).
 * @returns the freshest available session.
 */
export async function refreshClaudeSynced(
  session: ClaudeSession,
  doRefresh: (session: ClaudeSession) => Promise<ClaudeSession>,
): Promise<ClaudeSession> {
  const fromSource = readClaudeCodeCredentials()
  const base = fromSource !== undefined && fromSource.accessToken !== session.accessToken ? fromSource : session
  if (base.expiresAt > Date.now() + 60_000) return base
  const next = await doRefresh(base)
  writeBackClaudeCodeCredentials(next, base.accessToken)
  return next
}
