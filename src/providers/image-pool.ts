/** Account scheduling shared by image generation and editing, independent of chat catalogs/quota. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AccountTokenManager } from './accounts.js'
import { ACCOUNT_SUSPENDED_CODE, httpLlmError } from './common.js'
import type { RateLimitResetReader } from './rate-limit.js'
import { AUTH_COOLDOWN_MS, DEFAULT_QUOTA_COOLDOWN_MS, TRANSIENT_COOLDOWN_MS, PoolHealthRegistry, memberKey } from './pool-health.js'

type ImageProvider = 'codex' | 'grok'
interface ImageSession { accessToken: string; refreshToken: string; expiresAt: number }

export interface ImageAccountRequest<S extends ImageSession> {
  provider: ImageProvider
  tokens: AccountTokenManager<S>
  signal: AbortSignal
  /** Session object identity provides bounded-lifetime affinity, also across generate/edit. */
  owner?: object | undefined
  rateLimitReset: RateLimitResetReader
  send: (session: S) => Promise<Response>
}

export class ImageAccountPool {
  // Deliberately separate from chat health: image quotas/entitlements need not match chat.
  private readonly health = new PoolHealthRegistry()
  private sticky = new WeakMap<object, Map<ImageProvider, string>>()

  constructor(private readonly options: { enabled?: boolean; onWarn?: (message: string) => void } = {}) {}

  /** Login/logout clears cooling image members and stale session affinity. */
  clear(provider: ImageProvider, account?: string): void {
    this.health.clear(provider, account)
    this.sticky = new WeakMap()
  }

  async request<S extends ImageSession>(request: ImageAccountRequest<S>): Promise<Response> {
    const { provider, tokens, signal, owner, send, rateLimitReset } = request
    signal.throwIfAborted()
    const accounts = await tokens.list()
    if (accounts.length === 0) {
      await tokens.session() // standard provider-specific login hint
      throw new LlmError('image_generate: no image account is logged in', 'MISSING_CREDENTIAL')
    }
    const pooling = this.options.enabled !== false
    const members = (pooling ? accounts : accounts.slice(0, 1)).map(entry => entry.key)
    const sticky = pooling && owner !== undefined ? this.sticky.get(owner)?.get(provider) : undefined
    const ordered = sticky !== undefined && members.includes(sticky)
      ? [sticky, ...members.filter(key => key !== sticky)] : members
    let lastError: unknown
    for (const account of ordered) {
      signal.throwIfAborted()
      const key = memberKey(provider, account, 'images')
      if (pooling && !this.health.isAvailable(key)) continue
      let failure: LlmError
      try {
        let session = await tokens.session(account)
        signal.throwIfAborted()
        let response = await send(session)
        // Only a definitive unauthorized rejection permits retrying this account.
        if (response.status === 401) {
          await response.body?.cancel()
          session = await tokens.session(account, true)
          signal.throwIfAborted()
          response = await send(session)
        }
        signal.throwIfAborted()
        if (response.ok) {
          if (pooling && owner !== undefined) {
            let affinity = this.sticky.get(owner)
            if (affinity === undefined) { affinity = new Map(); this.sticky.set(owner, affinity) }
            affinity.set(provider, account)
          }
          return response
        }
        // Images can be produced despite timeouts/server failures. Switch only on
        // explicit auth/quota/entitlement rejection, never ambiguous transport/5xx.
        failure = await httpLlmError(response, 'image_generate', { rateLimitReset })
        if (![401, 402, 403, 404, 429].includes(response.status)) throw failure
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof LlmError) || ![ACCOUNT_SUSPENDED_CODE, 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'RATE_LIMIT', 'HTTP_402', 'HTTP_404'].includes(error.code)) throw error
        failure = error
      }
      if (!pooling) throw failure
      const delay = failure.failure.providerRetryAfterMs ?? (failure.code === 'RATE_LIMIT'
        ? DEFAULT_QUOTA_COOLDOWN_MS
        : [ACCOUNT_SUSPENDED_CODE, 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'].includes(failure.code) ? AUTH_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS)
      this.health.markUnavailable(key, delay, failure.code)
      this.options.onWarn?.(`image pool ${provider}: account ${members.indexOf(account) + 1}/${members.length} rejected (${failure.code}); checking remaining accounts`)
      lastError = failure
    }
    if (lastError !== undefined) throw lastError
    const recovery = this.health.earliestRecovery(new Set(members.map(account => memberKey(provider, account, 'images'))))
    throw new LlmError(`image_generate: all ${provider} image accounts are cooling down`, 'RATE_LIMIT', {
      ...recovery === undefined ? {} : { providerRetryAfterMs: Math.max(0, recovery - Date.now()) },
    })
  }
}
