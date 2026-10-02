import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
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
  override providerInfo(provider: string) { return this.options.adapter.providerInfo(provider) }
  override providerRetryPolicy(provider: string) { return this.options.adapter.providerRetryPolicy(provider) }
  private preference(account: string): AccountPreferences | undefined {
    const accounts = this.options.settings.get(this.options.provider).accounts
    return accounts && Object.hasOwn(accounts, account) ? accounts[account] : undefined
  }
  private async models(account: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    const models = await withAbortSignal(() => withTimeout(
      signal => this.options.adapter.listOwnModels(this.options.provider, account, signal),
      this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
    ), signal)
    if (models !== undefined) return models
    // Discovery timed out: the catalog this account listed last time beats
    // "no models", which would fail the turn with "No eligible account".
    return await withAbortSignal(async () => this.options.adapter.lastKnownOwnModels?.(this.options.provider, account), signal) ?? []
  }
  private async requireAccount(account: string, model: string, independent: boolean, signal?: AbortSignal): Promise<void> {
    if (!(await withAbortSignal(this.options.accounts, signal)).some(entry => entry.key === account)
      || (independent ? this.preference(account)?.independentEntry !== true : !accountAllowsPool(this.preference(account), model))
      || !(await this.models(account, signal)).some(entry => entry.id === model)) {
      throw new LlmError(`Account route unavailable: ${this.options.provider}/${account}/${model}`, 'NO_ADAPTER')
    }
  }
  private async fallback(model: string, signal?: AbortSignal): Promise<string> {
    for (const { key } of await withAbortSignal(this.options.accounts, signal)) {
      if (!accountAllowsPool(this.preference(key), model)) continue
      try { await this.requireAccount(key, model, false, signal); return key } catch { signal?.throwIfAborted() }
    }
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
    return new Proxy(raw, { get: (target, property) => {
      if (property === 'streamAccount') return async function* (options: GenerateOptions, account: string) {
        let key: string
        try { key = await keyFor(account, options.model, options.signal) } catch (cause) {
          options.signal?.throwIfAborted()
          // Skip policy-excluded members without poisoning account health. The
          // pool treats TRANSPORT as switch-without-cooldown; raw is never called.
          throw new LlmError('Pool member unavailable under account preferences', 'TRANSPORT', { cause })
        }
        yield* raw.streamAccount(options, key)
      }
      if (property === 'resolveOwnModel') return async (provider: string, model: string, account?: string) =>
        raw.resolveOwnModel(provider, model, await keyFor(account, model))
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const result = new Map<string, LlmModelInfo>()
    const catalogs = await Promise.all((await this.options.accounts()).map(async account => ({ ...account, models: await this.models(account.key).catch(() => []) })))
    for (const { key, label, models } of catalogs) {
      const preferences = this.preference(key)
      for (const model of models) {
        if (model.id.startsWith(ACCOUNT_MODEL_PREFIX)) continue
        if (accountAllowsPool(preferences, model.id) && this.options.settings.visible(this.options.provider, model.id) && !result.has(model.id)) result.set(model.id, model)
        if (preferences?.independentEntry === true && this.options.settings.visible(this.options.provider, model.id)) {
          const id = accountModelId(key, model.id)
          result.set(id, { ...model, id, name: `${preferences.alias || label} · ${model.name}` })
        }
      }
    }
    for (const model of await this.options.pool()?.modelsForProvider(this.options.provider) ?? []) {
      if (model.id.startsWith(ACCOUNT_MODEL_PREFIX) || !this.options.settings.visible(this.options.provider, model.id)) continue
      try { await this.options.pool()!.resolveModel(provider, model.id); result.set(model.id, model) } catch { /* excluded tier */ }
    }
    const priority = (model: LlmModelInfo): number => (model as LlmModelInfo & { priority?: number }).priority ?? Number.MAX_SAFE_INTEGER
    return [...result.values()].sort((left, right) => priority(left) - priority(right))
  }
  override async resolveModel(provider: string, id: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return (await this.prepareCall(provider, id, signal)).model
  }
  override async prepareCall(provider: string, id: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const independent = parseAccountModelId(id)
    const pool = this.options.pool()
    if (!independent && pool && await withAbortSignal(() => pool.owns(this.options.provider, id), signal)) {
      return pool.prepareCall(provider, id, signal)
    }
    const account = independent?.account ?? await this.fallback(id, signal)
    const model = independent?.model ?? id
    if (independent) await this.requireAccount(account, model, true, signal)
    const info = await withAbortSignal(() => this.options.adapter.resolveOwnModel(provider, model, account), signal)
    const label = independent ? (await withAbortSignal(this.options.accounts, signal)).find(entry => entry.key === account)?.label ?? account : undefined
    const owner = this
    return {
      model: independent ? { ...info, id, name: `${this.preference(account)?.alias || label} · ${info.name}` } : info,
      async *stream(options) {
        // Keep the capability-bearing account; revoked permission must fail instead of rerouting.
        await owner.requireAccount(account, model, independent !== undefined, options.signal)
        options.signal?.throwIfAborted()
        yield* streamAccountWithReplay(owner.options.adapter, options, account, model)
      },
    }
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
      yield* pool.stream(options)
      return
    }
    const account = await this.fallback(options.model, options.signal)
    options.signal?.throwIfAborted()
    yield* streamAccountWithReplay(this.options.adapter, options, account)
  }
}
