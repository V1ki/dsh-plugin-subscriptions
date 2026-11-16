/** Account-scoped Qwen wire adapters, token refresh, and pool routing. */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { QwenSession, ProviderId } from '../auth/store.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS } from './accounts.js'
import type { AccountAwareAdapter } from './accounts.js'
import { withAbortSignal, withTimeout } from './common.js'
import type { PoolAdapter } from './pool.js'
import { QwenAdapter } from './qwen.js'
import type { QwenAdapterOptions } from './qwen.js'

export interface QwenAccountAdapterOptions {
  tokens: AccountTokenManager<QwenSession>
  streamIdleTimeoutMs: number
  fetchFn?: QwenAdapterOptions['fetchFn']
  resolveAttachments?: QwenAdapterOptions['resolveAttachments']
  userAgent?: string
  /** Late-bound, because pool construction depends on the account adapters. */
  pool?: () => PoolAdapter | undefined
  discoveryTimeoutMs?: number
  /** User preference, validated against Qwen's own advertised efforts. */
  defaultEffortOf?: (model: string) => string | undefined
  onWarn?: (message: string) => void
  onCatalogChanged?: () => void
}

interface AccountAdapter {
  adapter: QwenAdapter
  /** Last successful listing, used for non-network picker and timeout fallback. */
  models?: readonly LlmModelInfo[]
  /** Snapshot of account-specific capabilities used for change detection. */
  capabilitySnapshot?: string
  /** A forced refresh must bypass cached picker rows once. */
  stale?: boolean
  /** A rejected account may not contribute last-known routing information. */
  rejection?: LlmError
  /** Incremented on forced refresh so older fetches cannot mark it fresh. */
  revision: number
  /** Serialize catalog updates so an older response cannot overwrite a newer one. */
  work?: Promise<void>
}

/**
 * QwenAdapter stores model capability metadata in its instance. Never share an
 * instance across account keys, even when one account becomes the default.
 */
export class QwenAccountAdapter extends LlmAdapter implements AccountAwareAdapter {
  private readonly accounts = new Map<string, AccountAdapter>()
  private readonly aliases = new Map<string, string>()
  /** Serializes rejected-token comparison across adapters using this token manager. */
  private static readonly tokenQueues = new WeakMap<AccountTokenManager<QwenSession>, Map<string, Promise<void>>>()
  private readonly tokenWork: Map<string, Promise<void>>

  constructor(private readonly options: QwenAccountAdapterOptions) {
    super()
    let queue = QwenAccountAdapter.tokenQueues.get(options.tokens)
    if (queue === undefined) {
      queue = new Map<string, Promise<void>>()
      QwenAccountAdapter.tokenQueues.set(options.tokens, queue)
    }
    this.tokenWork = queue
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Qwen Subscription' }
  }

  private async canonical(account: string): Promise<string> {
    const key = await this.options.tokens.resolveAccount(account)
    this.aliases.set(account, key)
    this.aliases.set(key, key)
    return key
  }

  private async defaultKey(): Promise<string> {
    const key = await this.options.tokens.defaultAccount()
    if (key === undefined) {
      // Use the manager's standard MISSING_CREDENTIAL error and login hint.
      await this.options.tokens.session()
      throw new LlmError('No Qwen account available', 'MISSING_CREDENTIAL')
    }
    return this.canonical(key)
  }

  private adapterFor(key: string): AccountAdapter {
    let entry = this.accounts.get(key)
    if (entry === undefined) {
      const adapter = new QwenAdapter({
        tokens: { getAccessToken: (signal, rejectedToken) => this.accessToken(key, signal, rejectedToken) },
        streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
        ...this.options.fetchFn === undefined ? {} : { fetchFn: this.options.fetchFn },
        ...this.options.resolveAttachments === undefined ? {} : { resolveAttachments: this.options.resolveAttachments },
        ...this.options.userAgent === undefined ? {} : { userAgent: this.options.userAgent },
        ...this.options.defaultEffortOf === undefined ? {} : { defaultEffortOf: this.options.defaultEffortOf },
      })
      entry = { adapter, revision: 0 }
      this.accounts.set(key, entry)
    }
    return entry
  }

  /**
   * All token reads join the account's queue. A delayed 401 can then compare
   * its rejected token against the current stored session *after* an earlier
   * request has finished rotating it. Do not force-refresh a newer token.
   * A cancelled waiter stops waiting, but an already-started rotation must
   * finish and persist: aborting a rotating refresh could lose the new pair.
   */
  private accessToken(account: string, signal?: AbortSignal, rejectedToken?: string): Promise<string> {
    signal?.throwIfAborted()
    const prior = this.tokenWork.get(account) ?? Promise.resolve()
    const work = prior.then(async () => {
      signal?.throwIfAborted()
      if (rejectedToken === undefined) return (await this.options.tokens.session(account)).accessToken
      // A previously rotated (or re-logged-in) credential must not be spent
      // again merely because an earlier request's 401 arrived late.
      return (await this.options.tokens.sessionAfterRejected(account, rejectedToken)).accessToken
    })
    // Keep the queue alive after an error, and only remove our own tail.
    const tail = work.then(() => undefined, () => undefined)
    this.tokenWork.set(account, tail)
    void tail.then(() => { if (this.tokenWork.get(account) === tail) this.tokenWork.delete(account) })
    return withAbortSignal(() => work, signal)
  }

  /** Drop one account's catalog, or all catalogs on a provider-wide auth change. */
  clearAccountCatalog(account?: string): void {
    const clearAll = (): void => {
      for (const entry of this.accounts.values()) entry.adapter.clearCatalog()
      this.accounts.clear()
    }
    if (account === undefined) {
      clearAll()
      this.aliases.clear()
      return
    }
    const key = this.aliases.get(account) ?? account
    const entry = this.accounts.get(key)
    if (entry !== undefined) {
      entry.adapter.clearCatalog()
      this.accounts.delete(key)
    } else if (!this.aliases.has(account)) {
      // An unseen legacy alias may name any cached canonical key. Resolve is
      // async but invalidation is synchronous, so conservatively clear all.
      clearAll()
    }
  }

  /** Force the next discovery while retaining last-known data on transient failures. */
  invalidateAccountCatalog(account?: string): void {
    if (account === undefined) {
      for (const entry of this.accounts.values()) { entry.stale = true; entry.revision++ }
      return
    }
    const key = this.aliases.get(account) ?? account
    const entry = this.accounts.get(key)
    if (entry !== undefined) { entry.stale = true; entry.revision++ }
    else if (!this.aliases.has(account)) {
      // Unknown alias: conservatively refresh all, without losing fallback.
      for (const cached of this.accounts.values()) { cached.stale = true; cached.revision++ }
    }
  }

  private rows(provider: string, models: readonly LlmModelInfo[]): LlmModelInfo[] {
    return models.map(model => ({ ...model, provider }))
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    const own = await this.listOwnModels(provider, undefined, signal, true)
    const pool = this.options.pool?.()
    if (pool === undefined) return own
    const extra = await withAbortSignal(() => pool.modelsForProvider(provider as ProviderId), signal)
    const seen = new Set(own.map(model => model.id))
    return [...own, ...extra.filter(model => !seen.has(model.id))]
  }

  /** The live per-account catalog, or the default-first union of all accounts. */
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal, preferCached = false): Promise<readonly LlmModelInfo[]> {
    signal?.throwIfAborted()
    if (account === undefined) {
      const accounts = (await withAbortSignal(() => this.options.tokens.list(), signal)).map(entry => entry.key)
      const results = await Promise.all(accounts.map(async key => {
        try {
          const models = await withAbortSignal(() => withTimeout(
            timeoutSignal => this.listOwnModels(provider, key,
              signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]), preferCached),
            this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
          ), signal)
          if (models === undefined) return { error: new LlmError('Qwen model discovery timed out', 'TIMEOUT') }
          return { models }
        } catch (error: unknown) {
          signal?.throwIfAborted()
          return { error }
        }
      }))
      signal?.throwIfAborted()
      const seen = new Set<string>()
      const union: LlmModelInfo[] = []
      let succeeded = false
      let failure: unknown
      for (const result of results) {
        if ('models' in result) {
          succeeded = true
          for (const model of result.models ?? []) {
            if (!seen.has(model.id)) { seen.add(model.id); union.push(model) }
          }
        } else if (failure === undefined) failure = result.error
      }
      // One account's failure must not hide a sibling's catalog, but an
      // entirely failed discovery is an error rather than a silent logout.
      if (!succeeded && failure !== undefined) throw failure
      return union
    }
    const key = await withAbortSignal(() => this.canonical(account), signal)
    if (!await withAbortSignal(() => this.options.tokens.hasSession(key), signal)) {
      // A login/logout may race a union snapshot; this account did not
      // successfully list anything and must not mask a sibling's failure.
      await withAbortSignal(() => this.options.tokens.session(key), signal)
      throw new LlmError('No Qwen account available', 'MISSING_CREDENTIAL')
    }
    const entry = this.adapterFor(key)
    if (preferCached && entry.models !== undefined && entry.stale !== true) return this.rows(provider, entry.models)
    const prior = entry.work ?? Promise.resolve()
    const work = prior.then(async () => {
      signal?.throwIfAborted()
      if (this.accounts.get(key) !== entry) return []
      if (preferCached && entry.models !== undefined && entry.stale !== true) return this.rows(provider, entry.models)
      try {
        while (true) {
          const revision = entry.revision
          const result = await withAbortSignal(() => entry.adapter.listModelsResult(provider, signal), signal)
          signal?.throwIfAborted()
          // An auth change destroys the instance; a force refresh that raced
          // this fetch must trigger another fetch before publishing its data.
          // A transient failure on that retry may use the preceding successful
          // fetch as a last-known fallback, but only within this same login.
          if (this.accounts.get(key) !== entry) return []
          if (entry.revision !== revision) continue
          const models = result.models
          // list rows alone omit context windows; compare resolved metadata as
          // well so pool capability changes trigger invalidation/notification.
          const capabilities = await withAbortSignal(
            () => Promise.all(models.map(model => entry.adapter.resolveModel(provider, model.id))), signal,
          )
          signal?.throwIfAborted()
          if (this.accounts.get(key) !== entry) return []
          if (entry.revision !== revision) continue
          const snapshot = JSON.stringify(capabilities)
          const changed = entry.models === undefined || JSON.stringify(entry.models) !== JSON.stringify(models)
            || entry.capabilitySnapshot !== snapshot
          entry.models = models
          entry.capabilitySnapshot = snapshot
          delete entry.rejection
          entry.stale = result.fallback
          if (changed) this.options.onCatalogChanged?.()
          return this.rows(provider, models)
        }
      } catch (error: unknown) {
        // QwenAdapter checks the signal before publishing a catalog, including
        // for fetch implementations that ignore abort. Preserve last-known
        // metadata so pool routing can fall back after a discovery timeout.
        signal?.throwIfAborted()
        if (this.accounts.get(key) !== entry) return []
        // The backend has already retried a 401 once. Never route with stale
        // permissions when the retry, a 403, or a refresh proves auth failed.
        if (error instanceof LlmError && ['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(error.code)) {
          const changed = entry.models !== undefined
          entry.adapter.clearCatalog()
          delete entry.models
          delete entry.capabilitySnapshot
          entry.stale = true
          entry.rejection = error
          if (changed) this.options.onCatalogChanged?.()
        }
        this.options.onWarn?.('qwen model discovery failed for ' + key + ' (' + (error instanceof Error ? error.message : String(error)) + ')')
        throw error
      }
    })
    const tail = work.then(() => undefined, () => undefined)
    entry.work = tail
    void tail.then(() => { if (entry.work === tail) delete entry.work })
    return withAbortSignal(() => work, signal)
  }

  async lastKnownOwnModels(provider: string, account: string): Promise<readonly LlmModelInfo[] | undefined> {
    const key = await this.canonical(account)
    if (!await this.options.tokens.hasSession(key)) return undefined
    const entry = this.accounts.get(key)
    if (entry?.rejection !== undefined) throw entry.rejection
    return entry?.models === undefined ? undefined : this.rows(provider, entry.models)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await withAbortSignal(() => pool.owns(provider as ProviderId, model), signal)) {
      return withAbortSignal(() => pool.resolveModel(provider, model, signal), signal)
    }
    return this.resolveOwnModel(provider, model, undefined, signal)
  }

  /** Resolve capability metadata from the selected member, never through the pool. */
  async resolveOwnModel(provider: string, model: string, account?: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    if (account !== undefined) {
      const key = await withAbortSignal(() => this.canonical(account), signal)
      const models = await this.listOwnModels(provider, key, signal, true)
      if (!models.some(entry => entry.id === model)) throw new LlmError('Qwen model unavailable for account "' + key + '"', 'NO_ADAPTER')
      return withAbortSignal(() => this.adapterFor(key).adapter.resolveModel(provider, model), signal)
    }
    const keys = (await withAbortSignal(() => this.options.tokens.list(), signal)).map(entry => entry.key)
    if (keys.length === 0) await withAbortSignal(() => this.defaultKey(), signal)
    // Discover the union first: if all accounts failed, retain their real
    // error instead of disguising a 403 or network failure as an unknown id.
    const union = await this.listOwnModels(provider, undefined, signal, true)
    if (!union.some(entry => entry.id === model)) throw new LlmError('Qwen model unavailable: "' + model + '"', 'NO_ADAPTER')
    // Metadata for a secondary-only model must come from the account that
    // advertised it; default first wins when multiple accounts list the id.
    for (const key of keys) {
      const canonical = await withAbortSignal(() => this.canonical(key), signal)
      const entry = this.accounts.get(canonical)
      if (entry?.rejection === undefined && entry?.models?.some(row => row.id === model)) {
        return withAbortSignal(() => entry.adapter.resolveModel(provider, model), signal)
      }
    }
    throw new LlmError('Qwen model unavailable: "' + model + '"', 'NO_ADAPTER')
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await withAbortSignal(() => pool.owns(options.provider as ProviderId, options.model), options.signal)) {
      yield* pool.stream(options)
      return
    }
    const key = await withAbortSignal(() => this.defaultKey(), options.signal)
    options.signal?.throwIfAborted()
    yield* this.adapterFor(key).adapter.stream(options)
  }

  /** Pool seam: use the exact account and bypass pool delegation. */
  async *streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    const key = await withAbortSignal(() => this.canonical(account), options.signal)
    options.signal?.throwIfAborted()
    yield* this.adapterFor(key).adapter.stream(options)
  }
}
