/**
 * Qwen Code OAuth login ("Qwen Account with Subscription").
 *
 * Qwen Code authorizes its CLI through a device grant against auth.qwen.ai;
 * the resulting access token is a Bearer credential for the OpenAI-compatible
 * `api.qwen.ai/compatible-mode/v1` endpoint. This is the chat.qwen.ai Plus/Pro
 * subscription, NOT the Alibaba Cloud (Bailian) Coding Plan — the latter has
 * no OAuth and only accepts its dedicated `sk-sp-` key.
 */
import { arch, platform } from 'node:os'
import { proxiedFetch } from '../http.js'
import type { DeviceFlowSpec, DeviceTokenSet } from './device-flow.js'
import type { QwenSession } from './store.js'

/** OAuth host and the Qwen Code public client id. */
export const QWEN_OAUTH_HOST = 'https://auth.qwen.ai'
export const QWEN_CLIENT_ID = 'qwen-code-cli'
/** OpenAI-compatible subscription endpoint. */
export const QWEN_API_BASE = 'https://api.qwen.ai/compatible-mode/v1'
/** Scope the Qwen Code client requests. */
const QWEN_SCOPE = 'model:invoke profile:read'
/** Refresh when the access token has less than this much life left. */
export const QWEN_PREEMPT_MS = 5 * 60_000
/**
 * User agent the Qwen gateway expects. A non-browser, non-QwenCode agent is
 * WAF-blocked before it reaches the OAuth endpoint.
 */
export const QWEN_USER_AGENT = `QwenCode/0.27.3 (${platform()}; ${arch()})`

/** Device-flow facts for the auth controller's DeviceFlowManager. */
export function qwenDeviceFlow(): DeviceFlowSpec {
  return {
    clientId: QWEN_CLIENT_ID,
    scope: QWEN_SCOPE,
    deviceCodeUrl: `${QWEN_OAUTH_HOST}/api/oauth/device/code`,
    tokenUrl: `${QWEN_OAUTH_HOST}/api/oauth/token`,
    encoding: 'form',
    preferCompleteUri: true,
    headers: { 'user-agent': QWEN_USER_AGENT },
  }
}

/** User info returned by `GET /api/oauth/userinfo`. */
interface QwenUserInfo {
  sub?: string
  name?: string
  email?: string
  member_type?: string
}

/**
 * Read the account identity for the status card. A failure must not fail the
 * login: the session is already usable, it simply shows no display name.
 */
export async function fetchQwenUserInfo(
  accessToken: string,
  fetchFn: typeof fetch = proxiedFetch,
): Promise<QwenUserInfo | undefined> {
  try {
    const response = await fetchFn(`${QWEN_OAUTH_HOST}/api/oauth/userinfo`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': QWEN_USER_AGENT,
      },
    })
    if (!response.ok) return undefined
    const body = await response.json() as QwenUserInfo
    return typeof body === 'object' && body !== null ? body : undefined
  } catch {
    return undefined
  }
}

/** Build a stored session from a completed device grant plus userinfo. */
export async function completeQwenLogin(
  tokens: DeviceTokenSet,
  fetchFn: typeof fetch = proxiedFetch,
): Promise<QwenSession> {
  if (tokens.refreshToken === undefined || tokens.refreshToken.length === 0) {
    throw new Error('Qwen login returned no refresh token')
  }
  const info = await fetchQwenUserInfo(tokens.accessToken, fetchFn)
  const account = text(info?.email) ?? text(info?.name) ?? text(info?.sub)
  const plan = text(info?.member_type)
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
    ...account === undefined ? {} : { account },
    ...plan === undefined ? {} : { plan },
  }
}

function text(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Token response of a refresh grant. */
interface QwenTokenWire {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

/** Refresh a Qwen session; the grant rotates the refresh token. */
export async function refreshQwen(
  session: QwenSession,
  fetchFn: typeof fetch = proxiedFetch,
): Promise<QwenSession> {
  const response = await fetchFn(`${QWEN_OAUTH_HOST}/api/oauth/token`, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': QWEN_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: QWEN_CLIENT_ID,
      refresh_token: session.refreshToken,
    }).toString(),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => undefined) as { error?: string } | undefined
    // `invalid_grant` is the OAuth way of saying the session is dead.
    const dead = response.status === 401 || response.status === 403 || error?.error === 'invalid_grant'
    throw new QwenAuthError(`Qwen token refresh failed (HTTP ${String(response.status)})`, dead ? 401 : response.status)
  }
  const wire = await response.json() as QwenTokenWire
  if (typeof wire.access_token !== 'string' || wire.access_token.length === 0
    || typeof wire.refresh_token !== 'string' || wire.refresh_token.length === 0) {
    throw new QwenAuthError('Qwen token refresh returned an incomplete token set')
  }
  return {
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token,
    expiresAt: Date.now() + (typeof wire.expires_in === 'number' && wire.expires_in > 0 ? wire.expires_in : 3600) * 1000,
    ...session.account === undefined ? {} : { account: session.account },
    ...session.plan === undefined ? {} : { plan: session.plan },
  }
}

/** Whether a refresh failure means the login is permanently gone. */
export function isQwenPermanentRefreshError(error: unknown): boolean {
  return error instanceof QwenAuthError && (error.status === 401 || error.status === 403)
}

/** An OAuth endpoint rejection carrying the HTTP status. */
export class QwenAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'QwenAuthError'
  }
}

/** One discovered Qwen model. */
export interface QwenModel {
  id: string
  name: string
  contextWindow?: number
  inputModalities: ('text' | 'image')[]
}

/** Wire model entry of `GET /compatible-mode/v1/models`. */
interface QwenWireModel {
  id?: string
  input_modalities?: string[]
  context_window_tokens?: number
  context_window?: number
}

/** Fetch the subscription's model catalog. */
export async function fetchQwenModels(
  session: QwenSession,
  fetchFn: typeof fetch = proxiedFetch,
  signal?: AbortSignal,
): Promise<QwenModel[]> {
  const response = await fetchFn(`${QWEN_API_BASE}/models`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${session.accessToken}`,
      'user-agent': QWEN_USER_AGENT,
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) {
    throw new QwenAuthError(`Qwen model discovery failed (HTTP ${String(response.status)})`, response.status)
  }
  const body = await response.json() as { data?: unknown }
  const rows = Array.isArray(body.data) ? body.data : []
  const models: QwenModel[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const wire = row as QwenWireModel
    if (typeof wire.id !== 'string' || wire.id.length === 0) continue
    const input = Array.isArray(wire.input_modalities)
      ? wire.input_modalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
      : ['text' as const]
    const contextWindow = positive(wire.context_window_tokens) ?? positive(wire.context_window)
    models.push({
      id: wire.id,
      name: wire.id,
      inputModalities: input.length > 0 ? input : ['text'],
      ...contextWindow === undefined ? {} : { contextWindow },
    })
  }
  if (models.length === 0) throw new QwenAuthError('Qwen model discovery returned an empty catalog')
  return models
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
