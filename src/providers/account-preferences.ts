import { AsyncLocalStorage } from 'node:async_hooks'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import type { ProviderSettingsStore, AccountPreferences } from '../provider-settings.js'
import type { AccountAwareAdapter } from './accounts.js'
import { DISCOVERY_TIMEOUT_MS, withAbortSignal, withTimeout } from './common.js'
import type { PoolAdapter } from './pool.js'
import { streamAccountWithReplay } from './replay.js'

/** Reserved namespace, recognized even when malformed or no longer enabled. */
export const ACCOUNT_MODEL_PREFIX = '~account:'
export function accountModelId(account: string, model: string): string {
  return `${ACCOUNT_MODEL_PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(model)}`
}
export function parseAccountModelId(id: string): { account: string; model: string } | undefined {
  if (!id.startsWith(ACCOUNT_MODEL_PREFIX)) return undefined
  const parts = id.slice(ACCOUNT_MODEL_PREFIX.length).split(':')
  try {
    if (parts.length !== 2) throw new Error()
    const account = decodeURIComponent(parts[0])
    const model = decodeURIComponent(parts[1])
    if (!account || !model || accountModelId(account, model) !== id) throw new Error()
    return { account, model }
  } catch { throw new LlmError('Invalid independent account model id', 'NO_ADAPTER') }
}
export function accountAllowsPool(preferences: AccountPreferences | undefined, model: string): boolean {
  return preferences?.poolEnabled !== false && (preferences?.poolModels?.includes(model) ?? true)
}
/** Discovery diagnostics belong to one routing attempt, including across pool failover. */
interface DiscoveryTrace { failures: unknown[]; usableMember: boolean }
const discoveryTrace = new AsyncLocalStorage<DiscoveryTrace>()

function discoveryFailure(failures: readonly unknown[]): unknown {
  // A denied catalog is actionable and must not be hidden by another timeout.
  return failures.find(error => error instanceof LlmError && error.failure.status === 403) ?? failures[0]
}

interface Options {
  provider: ProviderId
  adapter: AccountAwareAdapter
  settings: ProviderSettingsStore
  accounts: () => Promise<readonly { key: string; label: string }[]>
  pool: () => PoolAdapter | undefined
  /** Per-account discovery bound (defaults to {@link DISCOVERY_TIMEOUT_MS}; tests shorten it). */
  discoveryTimeoutMs?: number
}

/** Keeps the registered route separate from raw adapters and pool member seams. */
export class AccountPreferencesAdapter extends LlmAdapter {
  constructor(private readonly options: Options) { super() }
  override providerInfo(provider: string): LlmProviderInfo {
    const info = this.options.adapter.providerInfo(provider)
    // Native model groups read provider metadata, separately from model names.
    return { ...info, name: this.options.settings.get(this.options.provider).displayName ?? info.name }
  }
  override providerRetryPolicy(provider: string) { return this.options.adapter.providerRetryPolicy(provider) }
  private preference(account: string): AccountPreferences | undefined {
    const accounts = this.options.settings.get(this.options.provider).accounts
    return accounts && Object.hasOwn(accounts, account) ? accounts[account] : undefined
  }
  private async models(account: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    try {
      const models = await withAbortSignal(() => withTimeout(
        signal => this.options.adapter.listOwnModels(this.options.provider, account, signal, true),
        this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
      ), signal)
      if (models !== undefined) return models
      // Discovery timed out: a previously authorized catalog may still be used.
      // lastKnownOwnModels can itself reject after an authentication failure.
      const known = await withAbortSignal(async () => this.options.adapter.lastKnownOwnModels?.(this.options.provider, account), signal)
      if (known !== undefined) return known
      if (this.options.provider === 'qwen') throw new LlmError('Qwen model discovery timed out', 'TIMEOUT')
      return []
    } catch (error: unknown) {
      if (this.options.provider === 'qwen') {
        signal?.throwIfAborted()
        discoveryTrace.getStore()?.failures.push(error)
      }
      throw error
    }
  }
  private async requireAccount(account: string, model: string, independent: boolean, signal?: AbortSignal): Promise<void> {
    if (!(await withAbortSignal(this.options.accounts, signal)).some(entry => entry.key === account)
      || (independent ? this.preference(account)?.independentEntry !== true : !accountAllowsPool(this.preference(account), model))
      || !(await this.models(account, signal)).some(entry => entry.id === model)) {
      throw new LlmError(`Account route unavailable: ${this.options.provider}/${account}/${model}`, 'NO_ADAPTER')
    }
  }
  private async fallback(model: string, signal?: AbortSignal): Promise<string> {
    if (this.options.provider !== 'qwen') {
      for (const { key } of await withAbortSignal(this.options.accounts, signal)) {
        if (!accountAllowsPool(this.preference(key), model)) continue
        try { await this.requireAccount(key, model, false, signal); return key } catch { signal?.throwIfAborted() }
      }
      throw new LlmError(`No eligible account for ${this.options.provider}/${model}`, 'NO_ADAPTER')
    }
    const trace: DiscoveryTrace = { failures: [], usableMember: false }
    for (const { key } of await withAbortSignal(this.options.accounts, signal)) {
      if (!accountAllowsPool(this.preference(key), model)) continue
      try {
        await discoveryTrace.run(trace, () => this.requireAccount(key, model, false, signal))
        return key
      } catch { signal?.throwIfAborted() }
    }
    if (trace.failures.length > 0) throw discoveryFailure(trace.failures)
    throw new LlmError(`No eligible account for ${this.options.provider}/${model}`, 'NO_ADAPTER')
  }
  /** Pool-only facade: explicit families/tiers must obey the same policy as auto pools. */
  poolMember(): AccountAwareAdapter {
    const raw = this.options.adapter
    const keyFor = async (account: string | undefined, model: string, signal?: AbortSignal): Promise<string> => {
      if (model.startsWith(ACCOUNT_MODEL_PREFIX)) throw new LlmError('Independent entries cannot be pool members', 'NO_ADAPTER')
      const key = account ?? (await withAbortSignal(this.options.accounts, signal))[0]?.key
      if (!key) throw new LlmError('No account available', 'NO_ADAPTER')
      await this.requireAccount(key, model, false, signal)
      return key
    }
    const isQwen = this.options.provider === 'qwen'
    return new Proxy(raw, { get: (target, property) => {
      if (property === 'streamAccount') return async function* (options: GenerateOptions, account: string) {
        let key: string
        try { key = await keyFor(account, options.model, options.signal) } catch (cause) {
          options.signal?.throwIfAborted()
          // Skip policy-excluded members without poisoning account health. The
          // pool treats TRANSPORT as switch-without-cooldown; raw is never called.
          throw new LlmError('Pool member unavailable under account preferences', 'TRANSPORT', { cause })
        }
        const trace = discoveryTrace.getStore()
        if (trace !== undefined) trace.usableMember = true
        yield* raw.streamAccount(options, key)
      }
      if (property === 'resolveOwnModel' && !isQwen) return async (provider: string, model: string, account?: string) => {
        const resolved = await raw.resolveOwnModel(provider, model, await keyFor(account, model))
        const trace = discoveryTrace.getStore()
        if (trace !== undefined) trace.usableMember = true
        return resolved
      }
      if (property === 'resolveOwnModel') return async (provider: string, model: string, account?: string) => {
        const key = await keyFor(account, model)
        let result: LlmResolvedModelInfo
        try { result = await raw.resolveOwnModel(provider, model, key) } catch (error: unknown) {
          const trace = discoveryTrace.getStore()
          // The wrapper may recheck the catalog between keyFor and resolution.
          if (trace !== undefined && error instanceof LlmError
            && ['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(error.code)) trace.failures.push(error)
          throw error
        }
        const trace = discoveryTrace.getStore()
        if (trace !== undefined) trace.usableMember = true
        return result
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const result = new Map<string, LlmModelInfo>()
    const catalogs = await Promise.all((await this.options.accounts()).map(async account => {
      try { return { ...account, models: await this.models(account.key) } }
      catch (error: unknown) { return { ...account, error } }
    }))
    const failed = catalogs.filter(catalog => 'error' in catalog)
    // Other providers historically swallow discovery errors; Qwen reports the
    // real failure only when no account answered, even if the answer was empty.
    if (this.options.provider === 'qwen' && failed.length > 0 && failed.length === catalogs.length) {
      throw discoveryFailure(failed.map(catalog => catalog.error))
    }
    for (const catalog of catalogs) {
      const { key, label } = catalog
      const models = 'models' in catalog ? catalog.models : []
      const preferences = this.preference(key)
      for (const model of models) {
        if (model.id.startsWith(ACCOUNT_MODEL_PREFIX)) continue
        if (accountAllowsPool(preferences, model.id) && this.options.settings.visible(this.options.provider, model.id) && !result.has(model.id)) result.set(model.id, model)
        if (preferences?.independentEntry === true && this.options.settings.visible(this.options.provider, model.id)) {
          const id = accountModelId(key, model.id)
          result.set(id, { ...model, id, name: `${preferences.alias || label} · ${this.options.settings.modelName(this.options.provider, model.id, model.name)}` })
        }
      }
    }
    for (const model of await this.options.pool()?.modelsForProvider(this.options.provider) ?? []) {
      if (model.id.startsWith(ACCOUNT_MODEL_PREFIX) || !this.options.settings.visible(this.options.provider, model.id)) continue
      try { await this.options.pool()!.resolveModel(provider, model.id); result.set(model.id, model) } catch { /* excluded tier */ }
    }
    const priority = (model: LlmModelInfo): number => (model as LlmModelInfo & { priority?: number }).priority ?? Number.MAX_SAFE_INTEGER
    return [...result.values()].map(model => ({ ...model,
      name: this.options.settings.modelName(this.options.provider, model.id, model.name),
    })).sort((left, right) => priority(left) - priority(right))
  }
  override async resolveModel(provider: string, id: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return (await this.prepareCall(provider, id, signal)).model
  }
  override async prepareCall(provider: string, id: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const independent = parseAccountModelId(id)
    const pool = this.options.pool()
    if (!independent && pool && await withAbortSignal(() => pool.owns(this.options.provider, id), signal)) {
      if (this.options.provider !== 'qwen') {
        const prepared = await pool.prepareCall(provider, id, signal)
        return { ...prepared, model: this.present(id, prepared.model) }
      }
      const trace: DiscoveryTrace = { failures: [], usableMember: false }
      let prepared: PreparedAdapterCall
      try { prepared = await discoveryTrace.run(trace, () => pool.prepareCall(provider, id, signal)) }
      catch (error: unknown) { this.throwPoolFailure(error, trace, signal) }
      return { ...prepared, model: this.present(id, prepared.model),
        stream: options => this.streamPool(prepared.stream(options), options.signal) }
    }
    const account = independent?.account ?? await this.fallback(id, signal)
    const model = independent?.model ?? id
    if (independent) await this.requireAccount(account, model, true, signal)
    const info = await withAbortSignal(() => this.options.adapter.resolveOwnModel(provider, model, account), signal)
    const label = independent ? (await withAbortSignal(this.options.accounts, signal)).find(entry => entry.key === account)?.label ?? account : undefined
    const owner = this
    const named = this.present(model, info)
    return {
      model: independent ? { ...named, id, name: `${this.preference(account)?.alias || label} · ${named.name}` } : named,
      async *stream(options) {
        // Keep the capability-bearing account; revoked permission must fail instead of rerouting.
        await owner.requireAccount(account, model, independent !== undefined, options.signal)
        options.signal?.throwIfAborted()
        yield* streamAccountWithReplay(owner.options.adapter, options, account, model)
      },
    }
  }
  /** Only unwrap Qwen discovery when no pool member could actually be used. */
  private throwPoolFailure(error: unknown, trace: DiscoveryTrace, signal?: AbortSignal): never {
    signal?.throwIfAborted()
    if (this.options.provider === 'qwen' && !trace.usableMember && trace.failures.length > 0) throw discoveryFailure(trace.failures)
    throw error
  }
  /** Keep one async context through each iterator step; concurrent calls cannot share failures. */
  private async *streamPool(stream: AsyncIterable<StreamChunk>, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const trace: DiscoveryTrace = { failures: [], usableMember: false }
    const iterator = stream[Symbol.asyncIterator]()
    let done = false
    try {
      while (true) {
        const next = await discoveryTrace.run(trace, () => iterator.next())
        if (next.done) { done = true; return }
        yield next.value
      }
    } catch (error: unknown) {
      this.throwPoolFailure(error, trace, signal)
    } finally {
      if (!done) { try { await discoveryTrace.run(trace, () => iterator.return?.()) } catch { /* preserve the original outcome */ } }
    }
  }
  /** Presentation only: routing still uses the original model id. */
  private present(id: string, info: LlmResolvedModelInfo): LlmResolvedModelInfo {
    return { ...info, name: this.options.settings.modelName(this.options.provider, id, info.name) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const independent = parseAccountModelId(options.model)
    if (independent) {
      await this.requireAccount(independent.account, independent.model, true, options.signal)
      options.signal?.throwIfAborted()
      yield* streamAccountWithReplay(this.options.adapter, options, independent.account, independent.model)
      return
    }
    const pool = this.options.pool()
    if (pool && await withAbortSignal(() => pool.owns(this.options.provider, options.model), options.signal)) {
      if (this.options.provider === 'qwen') yield* this.streamPool(pool.stream(options), options.signal)
      else yield* pool.stream(options)
      return
    }
    const account = await this.fallback(options.model, options.signal)
    options.signal?.throwIfAborted()
    yield* streamAccountWithReplay(this.options.adapter, options, account)
  }
}
