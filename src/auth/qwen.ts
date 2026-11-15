/**
 * Qwen 千问AI平台 (QwenCloud China) subscription route.
 *
 * Unlike the other Chinese coding subscriptions, this platform has no public
 * OAuth for model calls: inference is authorized with an API key from
 * `platform.qianwenai.com/home/api-keys`. The route therefore stores the key
 * as a non-expiring credential instead of running a device grant, and picks
 * the endpoint from the key's product type:
 *
 * - `sk-sp-` Token Plan → `token-plan.maas.qianwenaiapi.com`
 * - `sk-ws-` / `sk-` pay-as-you-go → `maas.qianwenaiapi.com`
 *
 * The OpenAI-compatible endpoint has no `GET /models`; the catalog is static.
 * Quota is not readable with an inference key (the platform exposes it only to
 * a logged-in console session), so usage stays unsupported here.
 */
import { arch, platform } from 'node:os'
import type { QwenSession } from './store.js'

/** Token Plan (monthly credits) OpenAI-compatible base. */
export const QWEN_TOKEN_PLAN_BASE = 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1'
/** Pay-as-you-go OpenAI-compatible base. */
export const QWEN_STANDARD_BASE = 'https://maas.qianwenaiapi.com/compatible-mode/v1'
/** Refresh window used by the shared token manager; the key itself does not expire. */
export const QWEN_PREEMPT_MS = 5 * 60_000
/**
 * User agent the Qwen gateway expects. A non-browser, non-QwenCode agent is
 * WAF-blocked before it reaches the endpoint.
 */
export const QWEN_USER_AGENT = `QwenCode/0.27.3 (${platform()}; ${arch()})`

/** Label used for the account key and the status card. */
const TOKEN_PLAN_LABEL = 'Token Plan'
const STANDARD_LABEL = '按量计费'

/** A validated platform key and the facts that follow from its product type. */
export interface QwenApiKey {
  key: string
  /** OpenAI-compatible base URL (no trailing slash). */
  baseURL: string
  /** Display plan name. */
  plan: string
}

/**
 * Validate a 千问AI平台 API key and classify its product type.
 *
 * `sk-sp-` is shared by Token Plan and Alibaba ModelStudio keys, but this
 * route is explicitly the 千问AI平台; a key that is not one of these prefixes
 * would fail at the first request, so reject it before storing it.
 * @throws when the value is not a platform API key.
 */
export function parseQwenApiKey(value: unknown): QwenApiKey {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error('Invalid Qwen API key')
  }
  const key = value.trim()
  if (key.length < 1 || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error('Invalid Qwen API key')
  }
  if (key.startsWith('sk-sp-')) {
    return { key, baseURL: QWEN_TOKEN_PLAN_BASE, plan: TOKEN_PLAN_LABEL }
  }
  if (key.startsWith('sk-ws-') || key.startsWith('sk-')) {
    return { key, baseURL: QWEN_STANDARD_BASE, plan: STANDARD_LABEL }
  }
  throw new Error('Qwen 千问AI平台 needs an sk-sp- (Token Plan) or sk-ws-/sk- (pay-as-you-go) API key')
}

/**
 * Build the stored session for one platform key. The key never expires; the
 * far-future timestamp only satisfies the shared token-store shape, and the
 * status card omits it for this route.
 */
export function qwenSessionFromKey(value: unknown): QwenSession {
  const { key, baseURL, plan } = parseQwenApiKey(value)
  return {
    accessToken: key,
    refreshToken: key,
    expiresAt: Date.now() + 100 * 365 * 24 * 60 * 60_000,
    account: plan,
    plan,
    baseURL,
  }
}

/** A static key cannot be refreshed; serving it unchanged is the refresh. */
export function refreshQwen(session: QwenSession): Promise<QwenSession> {
  return Promise.resolve(session)
}

/** A static key never becomes permanently invalid through a refresh grant. */
export function isQwenPermanentRefreshError(): boolean {
  return false
}
