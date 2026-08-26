/**
 * The `/subscriptions-auth` host RPC channel the web Settings page drives. The
 * channel is registered only when a host `connection` service exists (the web
 * profile); headless compositions load the plugin without it. All business
 * outcomes are returned as RpcResult values; handlers never throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { PROVIDER_IDS, type ProviderId } from './store.js'
import { OAuthEndpointError, type ProviderUsage } from '../providers/common.js'
import type { ProxyConfigView, ProxyDraft, ProxyInput, ProxyTestResult } from '../http.js'

/** The RPC channel this plugin registers on the host connection. */
export const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Decoded image bytes returned by the `image` endpoint. */
export interface ImageBytesResult {
  mediaType: string
  dataBase64: string
}

/** Decoded video bytes returned by the `video` endpoint. */
export interface VideoBytesResult {
  mediaType: string
  dataBase64: string
}

/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/

/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value: the session's choice plus the visibility list. */
export interface SpeedState {
  /** The session's current speed tier (default `standard`). */
  tier: SpeedTier
  /** Codex model ids whose catalog advertises a fast tier. */
  fastModels: string[]
}

/** Speed state the RPC handler delegates to (in-memory, per session). */
export interface SpeedController {
  /** Current speed state: the session's tier and the fast-capable codex models. */
  speed(sessionId: string): Promise<SpeedState>
  /** Set one session's speed tier. */
  setSpeed(sessionId: string, tier: SpeedTier): Promise<void>
}

/** Login state of one provider, as rendered by the Settings page. */
export interface ProviderStatus {
  /** Whether a session exists in the store. */
  loggedIn: boolean
  /** Whether a login attempt is currently waiting for its code. */
  busy: boolean
  /** Epoch milliseconds at which the stored access token expires. */
  expiresAt?: number
  /** Account email or account id, when known. */
  account?: string
  /** Subscription detail (plan) or the last login error. */
  detail?: string
}

/** Proxy config operations behind the `proxyGet/proxySet/proxyTest` endpoints. */
export interface ProxyConfigController {
  /** Current proxy configuration (secrets omitted). */
  get(): Promise<ProxyConfigView>
  /** Validate, persist, and apply one config. */
  set(input: ProxyInput): Promise<ProxyConfigView>
  /** Probe one destination through the draft (unsaved) or stored proxy. */
  test(payload: { url?: string; proxy?: ProxyDraft }): Promise<ProxyTestResult>
}

/** Provider-agnostic auth operations the RPC handler delegates to. */
export interface AuthController {
  /** Current status of one provider. */
  status(provider: ProviderId): Promise<ProviderStatus>
  /**
   * Start a background login attempt.
   * @returns the authorize URL for the user's browser; device-flow providers
   *   (copilot) also return the `userCode` the user types at that URL.
   * @throws when an attempt is already running for this provider.
   */
  login(provider: ProviderId): Promise<{ authorizeUrl: string; userCode?: string }>
  /**
   * Feed a pasted callback URL or bare code into the pending attempt.
   * @throws when no attempt is pending or the input is unusable.
   */
  manual(provider: ProviderId, input: string): Promise<void>
  /** Abort the pending attempt; a no-op when none is pending. */
  cancel(provider: ProviderId): Promise<void>
  /** Delete the stored session. */
  logout(provider: ProviderId): Promise<void>
  /**
   * Current subscription usage of one provider.
   * @param signal - caller cancellation from the RPC transport.
   * @returns `{ supported: false }` when the provider has no usage endpoint.
   * @throws when logged out or the usage lookup fails.
   */
  usage(provider: ProviderId, signal: AbortSignal): Promise<ProviderUsage>
  /**
   * Read one image attachment's bytes for inline display.
   * @param ref - the full durable reference (`readImage` verifies against it).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when no attachment service is mounted or the read fails.
   */
  readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult>
  /**
   * Read one generated video's bytes for inline playback.
   * @param name - bare MP4 file name inside the plugin's videos directory
   *   (validated against {@link VIDEO_NAME_PATTERN}; never a path).
   * @param signal - caller cancellation from the RPC transport.
   * @returns the media type and base64-encoded bytes.
   * @throws when the file does not exist or cannot be read.
   */
  readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult>
}

/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
class BadRequest extends Error {}

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown): RpcResult<unknown> {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof BadRequest) {
    // The issues array is zod-shaped upstream; this channel validates by hand.
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
  }
  return { ok: false, error: { code: 'internal', message: withRetryAfter(error, message), details: {} } }
}

/**
 * Append the provider's retry delay to a failure message when it sent one.
 *
 * The delay belongs in structured data, but the `internal` RpcResult branch
 * types `details` as an empty object upstream (`z.object({})` in
 * dsh-host-apiproxy's rpc schema), so a field added here would be stripped in
 * validation rather than reaching the page. The message is the only channel
 * that survives, so the suffix is a stable, parseable one — a browser caller
 * that backs off on a 429 can honour the interval the provider actually asked
 * for instead of inventing its own.
 *
 * @param error - the thrown failure, which may carry a parsed `Retry-After`.
 * @param message - the failure message as it stands.
 * @returns the message, with ` (retry-after: <seconds>s)` appended when known.
 */
function withRetryAfter(error: unknown, message: string): string {
  if (!(error instanceof OAuthEndpointError) || error.retryAfterMs === undefined) return message
  const seconds = Math.max(1, Math.round(error.retryAfterMs / 1000))
  return `${message} (retry-after: ${String(seconds)}s)`
}

function readProvider(payload: unknown): ProviderId {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const provider = (payload as Record<string, unknown>).provider
  if (typeof provider !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(', ')}`)
  }
  return provider as ProviderId
}

function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`payload.${field} must be a non-empty string`)
  }
  return value
}

/** Validate the `setSpeed` endpoint's tier. */
function readSpeedTier(payload: unknown): SpeedTier {
  const tier = (payload as Record<string, unknown>).tier
  if (tier !== 'standard' && tier !== 'fast') {
    throw new BadRequest('payload.tier must be "standard" or "fast"')
  }
  return tier
}

/** Validate the `image` endpoint's payload into a full attachment reference. */
function readImageRef(payload: unknown): ImageAttachmentRef {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const record = payload as Record<string, unknown>
  const attachmentId = record.attachmentId
  if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
    throw new BadRequest('payload.attachmentId must be a non-empty string')
  }
  const mediaType = record.mediaType
  if (typeof mediaType !== 'string' || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new BadRequest(`payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`)
  }
  for (const field of ['bytes', 'width', 'height'] as const) {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new BadRequest(`payload.${field} must be a positive integer`)
    }
  }
  const name = record.name
  if (name !== undefined && typeof name !== 'string') {
    throw new BadRequest('payload.name must be a string when present')
  }
  return {
    attachmentId: AttachmentId(attachmentId),
    mediaType: mediaType as ImageAttachmentRef['mediaType'],
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...name === undefined ? {} : { name: name as string },
  }
}

/**
 * Validate the `video` endpoint's payload into a bare file name. Rejecting
 * anything with a path separator (the pattern allows none) pins every read
 * inside the plugin's videos directory.
 */
function readVideoName(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const name = (payload as Record<string, unknown>).name
  if (typeof name !== 'string' || !VIDEO_NAME_PATTERN.test(name)) {
    throw new BadRequest('payload.name must be a bare .mp4 file name')
  }
  return name
}

/** Validate the session id both speed endpoints carry. */
function readSessionId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  return readString(payload, 'sessionId')
}

/** Validate a `proxySet` payload into a shape `ProxyInput` accepts. */
function readProxyInput(payload: unknown): ProxyInput {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const record = payload as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') throw new BadRequest('payload.enabled must be a boolean')
  if (typeof record.url !== 'string') throw new BadRequest('payload.url must be a string')
  let username: string | undefined
  if (record.username !== undefined) {
    if (typeof record.username !== 'string') throw new BadRequest('payload.username must be a string when present')
    username = record.username
  }
  let password: string | null | undefined
  if (record.password !== undefined) {
    if (record.password !== null && typeof record.password !== 'string') {
      throw new BadRequest('payload.password must be a string or null when present')
    }
    password = record.password
  }
  let bypass: string[] | undefined
  if (record.bypass !== undefined) {
    if (!Array.isArray(record.bypass) || record.bypass.some(entry => typeof entry !== 'string')) {
      throw new BadRequest('payload.bypass must be an array of strings when present')
    }
    bypass = record.bypass
  }
  return {
    enabled: record.enabled,
    url: record.url,
    ...username === undefined ? {} : { username },
    ...password === undefined ? {} : { password },
    ...bypass === undefined ? {} : { bypass },
  }
}

/** Validate a `proxyTest` payload (the destination URL and an optional draft). */
function readProxyTestPayload(payload: unknown): { url?: string; proxy?: ProxyDraft } {
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as Record<string, unknown>
  const url = record.url
  if (url === undefined && record.proxy === undefined) return {}
  if (url !== undefined && (typeof url !== 'string' || url.length === 0)) {
    throw new BadRequest('payload.url must be a non-empty string when present')
  }
  let proxy: ProxyDraft | undefined
  if (record.proxy !== undefined) {
    if (typeof record.proxy !== 'object' || record.proxy === null) {
      throw new BadRequest('payload.proxy must be an object when present')
    }
    const draftRecord = record.proxy as Record<string, unknown>
    if (typeof draftRecord.url !== 'string' || draftRecord.url.length === 0) {
      throw new BadRequest('payload.proxy.url must be a non-empty string')
    }
    let username: string | undefined
    if (draftRecord.username !== undefined) {
      if (typeof draftRecord.username !== 'string') {
        throw new BadRequest('payload.proxy.username must be a string when present')
      }
      username = draftRecord.username
    }
    let password: string | undefined
    if (draftRecord.password !== undefined) {
      if (typeof draftRecord.password !== 'string') {
        throw new BadRequest('payload.proxy.password must be a string when present')
      }
      password = draftRecord.password
    }
    proxy = {
      url: draftRecord.url,
      ...username === undefined ? {} : { username },
      ...password === undefined ? {} : { password },
    }
  }
  return {
    ...url === undefined ? {} : { url },
    ...proxy === undefined ? {} : { proxy },
  }
}

async function dispatch(
  controller: AuthController,
  speed: SpeedController,
  proxy: ProxyConfigController | undefined,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<RpcResult<unknown>> {
  switch (endpoint) {
    case 'status': {
      const entries = await Promise.all(PROVIDER_IDS.map(
        async provider => [provider, await controller.status(provider)] as const,
      ))
      return ok({ providers: Object.fromEntries(entries) })
    }
    case 'login':
      return ok(await controller.login(readProvider(payload)))
    case 'manual': {
      const provider = readProvider(payload)
      await controller.manual(provider, readString(payload, 'input'))
      return ok({ ok: true })
    }
    case 'cancel':
      await controller.cancel(readProvider(payload))
      return ok({ ok: true })
    case 'logout':
      await controller.logout(readProvider(payload))
      return ok({ ok: true })
    case 'usage':
      return ok(await controller.usage(readProvider(payload), signal))
    case 'image':
      return ok(await controller.readImage(readImageRef(payload), signal))
    case 'video':
      return ok(await controller.readVideo(readVideoName(payload), signal))
    case 'speed':
      return ok(await speed.speed(readSessionId(payload)))
    case 'setSpeed':
      await speed.setSpeed(readSessionId(payload), readSpeedTier(payload))
      return ok({ ok: true })
    case 'proxyGet':
      if (proxy === undefined) throw new BadRequest('proxy configuration is unavailable')
      return ok(await proxy.get())
    case 'proxySet':
      if (proxy === undefined) throw new BadRequest('proxy configuration is unavailable')
      return ok(await proxy.set(readProxyInput(payload)))
    case 'proxyTest':
      if (proxy === undefined) throw new BadRequest('proxy configuration is unavailable')
      return ok(await proxy.test(readProxyTestPayload(payload)))
    default:
      throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`)
  }
}

/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param controller - the auth operations backing the endpoints.
 * @param speed - the per-session speed-tier state backing the Speed toggle.
 * @param proxy - optional proxy-config controller backing `proxyGet`/`proxySet`/`proxyTest`.
 */
export function registerAuthRpc(
  ctx: Context,
  controller: AuthController,
  speed: SpeedController,
  proxy: ProxyConfigController | undefined = undefined,
): void {
  // `connection` is not in this plugin's inject list (headless compositions
  // lack it), so its startup order is unconstrained: defer registration until
  // the service exists instead of probing once at apply time.
  ctx.inject(['connection'], (ctx) => {
    const connection = ctx.get('connection') as HostConnectionHandle
    ctx.effect(
      () => connection.rpc.handle(
        SUBSCRIPTIONS_AUTH_CHANNEL,
        async (endpoint, payload, signal) => {
          try {
            return await dispatch(controller, speed, proxy, endpoint, payload, signal)
          } catch (error) {
            return failure(error)
          }
        },
        { authority: 'loopback' },
      ),
      'dsh-plugin-subscriptions: /subscriptions-auth rpc channel',
    )
  })
}
