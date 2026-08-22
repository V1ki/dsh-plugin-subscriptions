/**
 * Plumbing shared by the three subscription adapters: HTTP error mapping, a
 * stream idle watchdog, fetch failure classification, OAuth endpoint errors,
 * and the per-provider {@link TokenManager} that owns session freshness.
 * Concurrent refreshes for one provider coalesce behind a single in-flight
 * promise (`inflight`), so a rotating refresh token is never spent twice.
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { rateLimitDiagnostics, retryAfterInstant, waitFromReset } from './rate-limit.js'
import type { RateLimitResetReader } from './rate-limit.js'

/** One configured model catalog entry. */
export interface ModelEntry {
  /** Wire model id; must be non-empty. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
  /** Accepted request modalities; when set, wins over the provider default. */
  inputModalities?: ('text' | 'image')[]
}

/**
 * Validate a configured model catalog (mirrors llm-deepseek's resolveModels).
 * @param models - raw configured entries.
 * @param label - diagnostic prefix naming the provider.
 * @returns the validated entries.
 */
export function validateModels(models: readonly ModelEntry[], label: string): ModelEntry[] {
  const seen = new Set<string>()
  return models.map((model) => {
    if (model.id.length === 0) throw new Error(`${label}: catalog model ids must be non-empty`)
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`${label}: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`${label}: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`${label}: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (model.inputModalities !== undefined
      && (model.inputModalities.length === 0
        || model.inputModalities.some(modality => modality !== 'text' && modality !== 'image'))) {
      throw new Error(`${label}: catalog model "${model.id}" inputModalities must be a non-empty list of "text"/"image"`)
    }
    if (seen.has(model.id)) throw new Error(`${label}: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
    }
  })
}

/** Optional per-call hooks {@link httpLlmError} uses to read a rate-limit window. */
export interface HttpLlmErrorOptions {
  /**
   * The calling provider's reader for the instant its rate-limit window
   * reopens. Consulted on a 429 only, and there ahead of the generic
   * `retry-after` header, because a provider's own field names the window while
   * `retry-after` often names a short backoff.
   */
  rateLimitReset?: RateLimitResetReader
  /** Diagnostic sink for a 429 that disclosed no reset instant this code recognizes. */
  onWarn?: (message: string) => void
}

/**
 * Build an LlmError from a non-2xx provider response, mapping the status to a
 * stable code and, for a rate-limited request, the disclosed reset instant to
 * the `providerRetryAfterMs` the retry plugin waits out.
 *
 * A 429 classifies as `RATE_LIMIT` on the strength of the status alone, ahead
 * of the quota-wording check. On these routes there is no terminal quota to
 * distinguish: a subscription has no balance to top up, only a window that
 * reopens, and providers announce an exhausted window with wording
 * (`usage_limit_reached`) the shared classifier reads as permanent.
 * @param response - the failed response.
 * @param label - diagnostic prefix naming the provider API.
 * @param options - the calling provider's rate-limit reader and warning sink.
 * @returns the classified error.
 */
export async function httpLlmError(
  response: Response,
  label: string,
  options: HttpLlmErrorOptions = {},
): Promise<LlmError> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    // Only swallow error-body reading: the HTTP status still identifies the failure.
  }
  // Truncated for display only; the readers below need the whole body to parse it.
  const shown = body.slice(0, 500)
  const message = shown.length > 0
    ? `${label} error (HTTP ${String(response.status)}): ${shown}`
    : `${label} error (HTTP ${String(response.status)})`
  let code: string
  if (response.status === 401 || response.status === 403) code = 'AUTH'
  else if (response.status === 429) code = 'RATE_LIMIT'
  else if (isQuotaExceededError(shown)) code = QUOTA_EXCEEDED_CODE
  else if (response.status === 400 && isContextWindowExceededError(shown)) code = CONTEXT_WINDOW_EXCEEDED_CODE
  else if (response.status === 408 || response.status === 504) code = 'TIMEOUT'
  else if (response.status >= 500) code = 'SERVER'
  else code = `HTTP_${String(response.status)}`
  const now = Date.now()
  // The provider's reader runs on a 429 and nowhere else. Providers attach
  // their rate-limit headers to every response, so reading them on a transient
  // 500 would report the current window's rollover — hours out — as the delay
  // before retrying a failure that has nothing to do with the window, and the
  // retry plugin honours `providerRetryAfterMs` for every retryable code.
  // `retry-after` stays readable on any status: there it is a real backoff the
  // provider asked for (a 503 shedding load), not a window snapshot.
  //
  // On a 429 the provider's own field wins outright rather than being raced
  // against `retry-after`: a rejected window often carries both, and the
  // generic header then names a short backoff that would burn the retry budget
  // re-hitting the same closed window.
  const rateLimited = response.status === 429
  const reset = rateLimited
    ? options.rateLimitReset?.(response, body, now) ?? retryAfterInstant(response, now)
    : retryAfterInstant(response, now)
  if (reset === undefined && rateLimited) {
    options.onWarn?.(`${label}: ${rateLimitDiagnostics(response, body)}`)
  }
  return new LlmError(message, code, {
    status: response.status,
    ...reset === undefined ? {} : { providerRetryAfterMs: waitFromReset(reset, now) },
  })
}

/** An idle watchdog: aborts its signal when no SSE activity arrives within the timeout. */
export interface IdleWatchdog {
  /** Signal to pass to fetch and body reads; aborts on caller cancel or idle expiry. */
  readonly signal: AbortSignal
  /** Reset the idle timer (call on every received SSE event). */
  pulse(): void
  /** Stop the timer and detach from the caller signal. */
  stop(): void
  /** Whether the last abort came from idle expiry rather than caller cancellation. */
  timedOut(): boolean
}

/**
 * Create an idle watchdog chained to the caller's signal.
 * @param caller - the request's own abort signal, when present.
 * @param timeoutMs - maximum idle interval while a stream read is outstanding.
 * @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
 */
export function idleWatchdog(caller: AbortSignal | undefined, timeoutMs: number): IdleWatchdog {
  const controller = new AbortController()
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      expired = true
      controller.abort(new Error(`stream idle timeout after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timer.unref()
  }
  const onCallerAbort = (): void => controller.abort(caller?.reason)
  if (caller?.aborted === true) controller.abort(caller.reason)
  else caller?.addEventListener('abort', onCallerAbort, { once: true })
  arm()
  return {
    signal: controller.signal,
    pulse: arm,
    stop() {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
    timedOut: () => expired,
  }
}

/**
 * Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
 * expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
 * TRANSPORT with the cause chained.
 * @param label - diagnostic prefix naming the provider API.
 * @param error - the thrown value.
 * @param watchdog - the request's idle watchdog.
 * @param caller - the request's own abort signal, when present.
 * @returns the classified error.
 */
export function mapFetchFailure(
  label: string,
  error: unknown,
  watchdog: IdleWatchdog,
  caller: AbortSignal | undefined,
): LlmError {
  if (watchdog.timedOut()) return new LlmError(`${label} stream idle timeout`, 'TIMEOUT', { cause: error })
  if (caller?.aborted === true) return new LlmError(`${label} request aborted by caller`, 'ABORTED', { cause: error })
  if (error instanceof LlmError) return error
  return new LlmError(`${label} request failed`, 'TRANSPORT', { cause: error })
}

/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
export class OAuthEndpointError extends Error {
  /** HTTP status of the token endpoint response. */
  readonly status: number
  /** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
  readonly oauthCode: string | undefined

  constructor(message: string, status: number, oauthCode?: string) {
    super(message)
    this.name = 'OAuthEndpointError'
    this.status = status
    this.oauthCode = oauthCode
  }
}

/**
 * Read an OAuth JSON error body into an {@link OAuthEndpointError}.
 * @param response - the failed token-endpoint response.
 * @param label - diagnostic prefix naming the provider.
 * @returns the error to throw.
 */
export async function oauthEndpointError(response: Response, label: string): Promise<OAuthEndpointError> {
  let oauthCode: string | undefined
  let detail = ''
  try {
    const parsed = await response.json() as { error?: string; error_description?: string }
    oauthCode = typeof parsed.error === 'string' ? parsed.error : undefined
    detail = typeof parsed.error_description === 'string' ? parsed.error_description : (oauthCode ?? '')
  } catch {
    // Only swallow error-body parsing: the HTTP status still identifies the failure.
  }
  const message = detail.length > 0
    ? `${label} token endpoint error (HTTP ${String(response.status)}): ${detail}`
    : `${label} token endpoint error (HTTP ${String(response.status)})`
  return new OAuthEndpointError(message, response.status, oauthCode)
}

/** A session fresh enough to serve a request without a refresh. */
interface TimedSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** Provider hooks the token manager needs. */
export interface TokenManagerOptions<S extends TimedSession> {
  /** Human-readable provider name for error messages. */
  displayName: string
  /** Refresh this long before `expiresAt`. */
  preemptMs: number
  load(): Promise<S | undefined>
  save(session: S): Promise<void>
  remove(): Promise<void>
  /** Perform the provider's refresh-token grant. */
  refresh(session: S): Promise<S>
  /** Whether a refresh failure is permanent (re-login required). */
  isPermanent(error: unknown): boolean
  /** Called after a permanent refresh failure deleted the stored session. */
  onRemoved?(): void
}

/**
 * Per-provider session freshness: loads the stored session, refreshes
 * proactively inside the preempt window or on demand after a 401, and
 * coalesces concurrent refreshes behind one in-flight promise. Permanent
 * refresh failures delete the stored session and surface INVALID_CREDENTIAL
 * with a re-login hint; transient failures fall back to a still-valid token.
 */
export class TokenManager<S extends TimedSession> {
  private inflight: Promise<S> | undefined

  constructor(private readonly options: TokenManagerOptions<S>) {
    this.options = options
  }

  /**
   * Read the stored session without any refresh side effect. Catalog queries
   * (`listModels`) use this to decide whether the provider is logged in.
   * @returns the stored session, or `undefined` when logged out.
   */
  peek(): Promise<S | undefined> {
    return this.options.load()
  }

  /**
   * Whether a session is currently stored (cheap; never refreshes).
   * @returns true when logged in.
   */
  async hasSession(): Promise<boolean> {
    return (await this.options.load()) !== undefined
  }

  /**
   * Resolve a usable session, refreshing proactively or on demand.
   * @param forceRefresh - refresh regardless of expiry (used after a 401).
   * @returns the persisted session to send.
   * @throws LlmError MISSING_CREDENTIAL when logged out, INVALID_CREDENTIAL
   *   when the refresh grant is permanently rejected.
   */
  async session(forceRefresh = false): Promise<S> {
    const session = await this.options.load()
    if (session === undefined) {
      throw new LlmError(
        `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; `
        + 'log in via Settings → Subscriptions in the dsh web app',
        'MISSING_CREDENTIAL',
      )
    }
    if (!forceRefresh && session.expiresAt - Date.now() > this.options.preemptMs) {
      return session
    }
    this.inflight ??= this.doRefresh(session).finally(() => {
      this.inflight = undefined
    })
    try {
      return await this.inflight
    } catch (error) {
      if (this.options.isPermanent(error)) {
        await this.options.remove()
        this.options.onRemoved?.()
        throw new LlmError(
          `${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`,
          'INVALID_CREDENTIAL',
          { cause: error },
        )
      }
      if (!forceRefresh && session.expiresAt > Date.now()) {
        // Transient refresh failure with a still-valid token: use it.
        return session
      }
      throw error instanceof LlmError
        ? error
        : new LlmError(`${this.options.displayName} token refresh failed`, 'AUTH', { cause: error })
    }
  }

  private async doRefresh(session: S): Promise<S> {
    // A concurrent caller may have refreshed while this one waited: re-read
    // the store and skip the round trip when the stored session is fresh.
    const current = await this.options.load()
    if (current !== undefined
      && current.accessToken !== session.accessToken
      && current.expiresAt - Date.now() > this.options.preemptMs) {
      return current
    }
    const next = await this.options.refresh(current ?? session)
    await this.options.save(next)
    return next
  }
}

/** Fetch signature adapters accept for discovery calls (injectable for tests). */
export type FetchFn = typeof fetch

/** One rate-limit window reported by a provider's usage endpoint. */
export interface UsageWindow {
  /** Window kind: `session` for the short rolling window, `weekly` for the 7-day one. */
  kind: 'session' | 'weekly' | 'other'
  /** Model scope for model-specific windows (e.g. `Opus`), when the provider names one. */
  scope?: string
  /** Percent of the window already consumed (0–100). */
  usedPercent: number
  /** Epoch milliseconds at which the window resets, when the provider discloses it. */
  resetsAt?: number
}

/** Subscription usage of one provider, as served by the `usage` RPC endpoint. */
export interface ProviderUsage {
  /** False when the provider has no usage endpoint (grok); windows are absent then. */
  supported: boolean
  /** Usage windows in display order. */
  windows?: UsageWindow[]
  /** Plan name the usage endpoint reported, when present. */
  plan?: string
}

/** One model discovered from a provider's live model-list endpoint. */
export interface DiscoveredModel {
  /** Wire model id. */
  id: string
  /** Human-readable display name. */
  name: string
  description?: string
  /** Advertised combined context capacity in tokens. */
  contextWindow?: number
  /** Provider sort hint; lower sorts earlier. */
  priority?: number
  /** Advertised reasoning efforts, when the provider discloses them. */
  reasoning?: {
    efforts: { id: ReasoningEffortId; name: string; description?: string }[]
    defaultEffort?: ReasoningEffortId
  }
  /** Claude-specific: which extended-thinking wire shape this model accepts. */
  thinkingType?: 'enabled' | 'adaptive'
  /** Codex-specific: the catalog advertises a fast (priority) service tier. */
  fastTier?: boolean
}

/** How long a discovered catalog is trusted before re-fetching. */
export const DISCOVERY_TTL_MS = 5 * 60_000

/** A durable snapshot of one provider's discovered catalog. */
export interface CatalogSnapshot {
  /** Epoch milliseconds of the successful fetch that produced it. */
  at: number
  models: DiscoveredModel[]
}

/** The durable half of a {@link ModelCatalogCache} (the models.json store). */
export interface CatalogPersistence {
  /** The last persisted snapshot, or undefined when absent or unusable. */
  load(): Promise<CatalogSnapshot | undefined>
  /** Persist a fresh snapshot (write-through after every successful fetch). */
  save(snapshot: CatalogSnapshot): Promise<void>
  /** Drop the persisted snapshot (a 401 proved the credential changed). */
  clear(): Promise<void>
}

/**
 * Cache for one provider's discovered model catalog. The TTL only decides
 * when to REFRESH; it never makes the cache forget: capability metadata
 * (reasoning efforts) must stay stable for a session that selected an effort,
 * or mid-conversation calls fail UNSUPPORTED_REASONING_EFFORT the moment the
 * cache goes stale. `listModels` awaits freshness via {@link get};
 * `resolveModel` uses {@link resolve}, which serves the last-known catalog
 * while a stale entry refreshes in the background, and only awaits the fetch
 * when nothing is known yet. An optional {@link CatalogPersistence} seeds the
 * last-known state across restarts and receives every successful fetch. A 401
 * during a fetch must call {@link invalidate}.
 */
export class ModelCatalogCache {
  private entry: CatalogSnapshot | undefined
  private inflight: Promise<DiscoveredModel[]> | undefined
  /** Settles once the persisted snapshot (when any) has been considered. */
  private seeded: Promise<void> | undefined
  /** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
  private seedDisabled = false

  constructor(
    private readonly persistence?: CatalogPersistence,
    private readonly ttlMs = DISCOVERY_TTL_MS,
  ) {}

  /**
   * The cached catalog when fresh, without fetching.
   * @returns the cached models, or `undefined` when absent or stale.
   */
  cached(): readonly DiscoveredModel[] | undefined {
    if (this.entry === undefined || Date.now() - this.entry.at >= this.ttlMs) return undefined
    return this.entry.models
  }

  /** Load the persisted snapshot once; a fetch or invalidate that landed first wins. */
  private ensureSeeded(): Promise<void> {
    if (this.persistence === undefined) return Promise.resolve()
    this.seeded ??= this.persistence.load().then(
      (snapshot) => {
        if (snapshot !== undefined && this.entry === undefined && !this.seedDisabled) {
          this.entry = snapshot
        }
      },
      () => undefined,
    )
    return this.seeded
  }

  /** Run (or join) the single in-flight fetch, updating memory and disk on success. */
  private refresh(fetcher: () => Promise<DiscoveredModel[]>): Promise<DiscoveredModel[]> {
    this.inflight ??= fetcher()
      .then((models) => {
        const snapshot: CatalogSnapshot = { at: Date.now(), models }
        this.entry = snapshot
        // Write-through is fire-and-forget: a failed save only costs durability.
        void this.persistence?.save(snapshot).catch(() => undefined)
        return models
      })
      .finally(() => { this.inflight = undefined })
    return this.inflight
  }

  /**
   * Return the cached catalog when fresh, otherwise fetch and cache it.
   * @param fetcher - performs the provider's model-list request.
   * @returns the discovered models.
   * @throws the fetcher's failure (the `listModels` caller warns and falls back).
   */
  async get(fetcher: () => Promise<DiscoveredModel[]>): Promise<readonly DiscoveredModel[]> {
    await this.ensureSeeded()
    return this.cached() ?? this.refresh(fetcher)
  }

  /**
   * The models for capability resolution. A fresh cache answers directly; a
   * stale one answers immediately from the last-known catalog while a
   * background refresh runs (a mid-conversation `resolveModel` must neither
   * block on nor fail with the network); a cold cache awaits one fetch.
   * @param fetcher - performs the provider's model-list request.
   * @returns the models, or `undefined` when nothing is known (the caller
   *   falls back to its static metadata). Never throws.
   */
  async resolve(fetcher: () => Promise<DiscoveredModel[]>): Promise<readonly DiscoveredModel[] | undefined> {
    await this.ensureSeeded()
    const fresh = this.cached()
    if (fresh !== undefined) return fresh
    const known = this.entry?.models
    if (known !== undefined) {
      // Stale-while-revalidate: the refresh outcome serves the NEXT resolve.
      this.refresh(fetcher).catch(() => undefined)
      return known
    }
    try {
      return await this.refresh(fetcher)
    } catch {
      return undefined
    }
  }

  /** Drop the cached catalog (e.g. after a 401 proved the credential changed). */
  invalidate(): void {
    this.entry = undefined
    this.seedDisabled = true
    void this.persistence?.clear().catch(() => undefined)
  }
}
