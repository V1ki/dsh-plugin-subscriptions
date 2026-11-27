/**
 * Kimi Code (Moonshot AI) OAuth login.
 *
 * Kimi Code's public CLI client registers a standard RFC 8628 device grant:
 * the user approves a short code in the browser and the token endpoint hands
 * back an access/refresh pair that is a drop-in Bearer credential for the
 * `api.kimi.com/coding/v1` Chat Completions endpoint. That makes the
 * subscription usable from a browser login instead of a pasted console key.
 *
 * The grant is form-encoded and carries the registered client's device
 * identity headers; the official clients rotate the refresh token on every
 * refresh, so a stale copy invalidates the login.
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, hostname, platform, release } from 'node:os'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { proxiedFetch } from '../http.js'
import { decodeJwtPayload } from './jwt.js'
import type { DeviceFlowSpec, DeviceTokenSet } from './device-flow.js'
import type { KimiSession } from './store.js'

/** Registered public client id of the Kimi Code CLI (no client secret). */
export const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
export const KIMI_OAUTH_HOST = 'https://auth.kimi.com'
export const KIMI_API_BASE = 'https://api.kimi.com/coding/v1'
/** Refresh when the access token has less than this much life left. */
export const KIMI_PREEMPT_MS = 5 * 60_000
/**
 * Client version advertised on the registered OAuth client. The OAuth backend
 * issues tokens to this client registration; an empty value is rejected.
 */
const KIMI_CLIENT_VERSION = '2.6.1'

/** Strip control/non-ASCII characters the device headers reject. */
function headerSafe(value: string): string {
  const safe = value.replace(/[^\x20-\x7e]/g, '').trim()
  return safe.length > 0 ? safe.slice(0, 200) : 'unknown'
}

/** One resolved device id per process; requests must not hit the disk each turn. */
let deviceIdPromise: Promise<string> | undefined

/**
 * Stable per-install device id, persisted with owner-only permissions.
 * @returns the cached id when this process already resolved one.
 */
function deviceId(): Promise<string> {
  deviceIdPromise ??= loadDeviceId()
  return deviceIdPromise
}

async function loadDeviceId(): Promise<string> {
  const path = dshHomePath('plugins', 'subscriptions', 'kimi-device-id')
  try {
    const stored = (await readFile(path, 'utf8')).trim()
    if (/^[0-9a-fA-F-]{32,36}$/.test(stored)) return stored
  } catch {
    // Missing or unreadable id: mint a new one below.
  }
  const value = randomUUID()
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, value, { mode: 0o600 })
    await chmod(path, 0o600)
  } catch {
    // A read-only home still gets a usable (if unstable) id.
  }
  return value
}

/**
 * Device identity + client headers the OAuth backend expects. The same set is
 * sent on inference requests, where the official clients include it too.
 */
export async function kimiHeaders(): Promise<Record<string, string>> {
  return {
    'user-agent': `KimiCLI/${KIMI_CLIENT_VERSION}`,
    'x-msh-platform': 'kimi_code_cli',
    'x-msh-version': KIMI_CLIENT_VERSION,
    'x-msh-device-name': headerSafe(hostname()),
    'x-msh-device-model': headerSafe(`${platform()} ${release()} ${arch()}`),
    'x-msh-os-version': headerSafe(release()),
    'x-msh-device-id': await deviceId(),
  }
}

/** Device-flow facts for the auth controller's DeviceFlowManager. */
export async function kimiDeviceFlow(): Promise<DeviceFlowSpec> {
  return {
    clientId: KIMI_CLIENT_ID,
    // Kimi never sends a scope; the registered client decides the grant.
    deviceCodeUrl: `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`,
    tokenUrl: `${KIMI_OAUTH_HOST}/api/oauth/token`,
    headers: await kimiHeaders(),
    preferCompleteUri: true,
  }
}

/** Display identity from the access token, when it is a JWT. */
function accountOf(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken)
  const claim = payload?.email ?? payload?.preferred_username ?? payload?.name ?? payload?.sub
  return typeof claim === 'string' && claim.length > 0 ? claim : undefined
}

/**
 * Build a stored session from a completed device grant.
 * @throws when the provider did not issue a refresh token (the session would
 *   silently die at the access token's expiry).
 */
export function completeKimiLogin(tokens: DeviceTokenSet): KimiSession {
  if (tokens.refreshToken === undefined || tokens.refreshToken.length === 0) {
    throw new Error('Kimi Code login returned no refresh token')
  }
  const account = accountOf(tokens.accessToken)
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
    ...account === undefined ? {} : { account },
  }
}

/** Token response of a refresh grant (same shape as the device grant). */
interface KimiTokenWire {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

/**
 * Refresh a Kimi session. Kimi rotates the refresh token on every grant, so
 * the returned session must be persisted immediately.
 */
export async function refreshKimi(
  session: KimiSession,
  fetchFn: typeof fetch = proxiedFetch,
): Promise<KimiSession> {
  const response = await fetchFn(`${KIMI_OAUTH_HOST}/api/oauth/token`, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      ...await kimiHeaders(),
    },
    body: new URLSearchParams({
      client_id: KIMI_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    }).toString(),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => undefined) as { error?: string } | undefined
    const dead = response.status === 401 || response.status === 403 || error?.error === 'invalid_grant'
    throw new KimiAuthError(`Kimi Code token refresh failed (HTTP ${String(response.status)})`, dead ? 401 : response.status)
  }
  const wire = await response.json() as KimiTokenWire
  if (typeof wire.access_token !== 'string' || wire.access_token.length === 0
    || typeof wire.refresh_token !== 'string' || wire.refresh_token.length === 0) {
    throw new KimiAuthError('Kimi Code token refresh returned an incomplete token set')
  }
  return {
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token,
    expiresAt: Date.now() + (typeof wire.expires_in === 'number' && wire.expires_in > 0 ? wire.expires_in : 3600) * 1000,
    ...session.account === undefined ? {} : { account: session.account },
  }
}

/** Whether a refresh failure means the login is permanently gone. */
export function isKimiPermanentRefreshError(error: unknown): boolean {
  return error instanceof KimiAuthError && (error.status === 401 || error.status === 403)
}

/** An OAuth endpoint rejection carrying the HTTP status. */
export class KimiAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'KimiAuthError'
  }
}

/** One discovered model, reduced to what the adapter needs. */
export interface KimiModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  inputModalities: ('text' | 'image')[]
  /** Advertised reasoning efforts, when the catalog reports them. */
  efforts?: { id: string; name: string }[]
  /** Default effort the catalog reports, when any. */
  defaultEffort?: string
}

/** Wire model entry subset of `GET /coding/v1/models`. */
interface KimiWireModel {
  id?: string
  display_name?: string
  context_length?: number
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[] }
  reasoning?: { effort?: { valid?: string[]; default?: string } }
}

/** Fetch the live model catalog with the logged-in account's token. */
export async function fetchKimiModels(
  session: KimiSession,
  fetchFn: typeof fetch = proxiedFetch,
  signal?: AbortSignal,
): Promise<KimiModel[]> {
  const response = await fetchFn(`${KIMI_API_BASE}/models`, {
    headers: { accept: 'application/json', authorization: `Bearer ${session.accessToken}`, ...await kimiHeaders() },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) {
    throw new KimiAuthError(`Kimi Code model discovery failed (HTTP ${String(response.status)})`, response.status)
  }
  const body = await response.json() as { data?: unknown }
  const rows = Array.isArray(body.data) ? body.data : []
  const models: KimiModel[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const wire = row as KimiWireModel
    if (typeof wire.id !== 'string' || wire.id.length === 0) continue
    const input = Array.isArray(wire.modalities?.input)
      ? wire.modalities.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
      : ['text' as const]
    const efforts = Array.isArray(wire.reasoning?.effort?.valid)
      ? [...new Set(wire.reasoning.effort.valid.filter(value => typeof value === 'string' && value.length > 0))]
        .map(id => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }))
      : []
    const defaultEffort = wire.reasoning?.effort?.default
    const contextWindow = watchedNumber(wire.limit?.context) ?? watchedNumber(wire.context_length)
    const maxTokens = watchedNumber(wire.limit?.output)
    models.push({
      id: wire.id,
      name: wire.display_name ?? wire.id,
      inputModalities: input.length > 0 ? input : ['text'],
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...efforts.length === 0 ? {} : { efforts },
      ...typeof defaultEffort === 'string' && defaultEffort.length > 0 && efforts.some(entry => entry.id === defaultEffort)
        ? { defaultEffort } : {},
    })
  }
  if (models.length === 0) throw new KimiAuthError('Kimi Code model discovery returned an empty catalog')
  return models
}

function watchedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
