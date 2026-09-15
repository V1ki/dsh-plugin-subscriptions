/**
 * Multi-account token plumbing: one {@link AccountTokenManager} per provider
 * owns a lazily-built {@link TokenManager} per account, so refresh coalescing
 * (`inflight`) and permanent-failure removal stay scoped to ONE account —
 * a revoked account deletes itself without touching its siblings.
 *
 * {@link AccountAwareAdapter} is the internal interface the pool uses to
 * stream through a specific account. A catalog model listed by several
 * accounts failovers; one listed by a single account is pinned to it.
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TokenManager, withTimeout } from './common.js'
import type { TokenManagerOptions } from './common.js'
import {
  deleteAccountSession,
  getAccountSession,
  listAccounts,
  saveAccountSession,
  resolveAccountKey,
} from '../auth/store.js'
import type { AccountEntry, ProviderId } from '../auth/store.js'

export { DISCOVERY_TIMEOUT_MS } from './common.js'

/** Minimal session shape the token managers need (mirrors common.ts). */
interface TimedSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** An adapter that can stream through a named account (the pool's seam). */
export interface AccountAwareAdapter extends LlmAdapter {
  /** Stream using the given account's credentials instead of the default. */
  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk>
  /**
   * The provider's own catalog: one account when `account` is set, otherwise
   * the union of every logged-in account (default first; later duplicates
   * dropped). The picker uses the union; pool assembly lists each account.
   */
  listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]>
  /**
   * Capability resolution of the provider's OWN models, bypassing the pool
   * delegation. The pool resolves its members through this — an account pool
   * reuses the catalog wire id (e.g. `gpt-5.4`), so resolveModel would
   * otherwise bounce straight back into the pool forever. The optional account
   * lets adapters with account-specific limits resolve that member conservatively.
   */
  resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo>
  /** Drop cached catalogs: one account, or every account when omitted (login/logout). */
  clearAccountCatalog(account?: string): void
}

/** Options for {@link unionAccountCatalogs}. */
export interface UnionAccountCatalogsOptions {
  /** Per-account bound; a hang sits that account out instead of blocking the picker. */
  timeoutMs?: number
  /** Caller cancellation; aborting drops the whole union. */
  signal?: AbortSignal
}

/** Catalog sort hint when the provider advertised one (Codex `priority`). */
function catalogPriority(model: LlmModelInfo): number {
  const ranked = model as LlmModelInfo & { priority?: number }
  return typeof ranked.priority === 'number' ? ranked.priority : Number.MAX_SAFE_INTEGER
}

/**
 * Merge per-account catalogs, keeping the first occurrence of each model id.
 * Rows that carry a numeric `priority` (Codex discovery) are then ordered by
 * it so a model only the second account lists — e.g. `gpt-5.6-sol` — still
 * sits with its generation instead of being appended after the default
 * account's older ids.
 */
export async function unionAccountCatalogs(
  accounts: readonly string[],
  listOne: (account: string, signal?: AbortSignal) => Promise<readonly LlmModelInfo[]>,
  options?: UnionAccountCatalogsOptions,
): Promise<LlmModelInfo[]> {
  const timeoutMs = options?.timeoutMs
  const caller = options?.signal
  const catalogs = await Promise.all(accounts.map(async account => {
    try {
      if (timeoutMs === undefined) return await listOne(account, caller)
      const models = await withTimeout(
        timeoutSignal => listOne(
          account,
          caller === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, caller]),
        ),
        timeoutMs,
      )
      return models ?? []
    } catch (error: unknown) {
      // One expired or failing account must not hide models the others list.
      if (caller?.aborted === true) throw error
      return []
    }
  }))
  const seen = new Set<string>()
  const models: LlmModelInfo[] = []
  for (const catalog of catalogs) {
    for (const model of catalog) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }
  models.sort((left, right) => catalogPriority(left) - catalogPriority(right))
  return models
}

/** Store I/O behind {@link AccountTokenManager} (injectable for tests). */
export interface AccountStoreIo<S> {
  list(): Promise<AccountEntry<S>[]>
  get(account?: string): Promise<S | undefined>
  save(account: string, session: S): Promise<void>
  remove(account: string): Promise<void>
  /** Resolve a legacy alias to the canonical account key. */
  resolve?(account: string): Promise<string>
}

export interface AccountTokenManagerOptions<S extends TimedSession> {
  provider: ProviderId
  /** Human-readable provider name for error messages. */
  displayName: string
  /** Provider hooks shared by every account (load/save/remove are bound per account). */
  makeOptions: (account: string) => Omit<TokenManagerOptions<S>, 'load' | 'save' | 'remove' | 'onRemoved' | 'displayName'>
  /** Called after a permanent refresh failure deleted one account's session. */
  onAccountRemoved?: (account: string) => void
  /** Store backend; defaults to the durable auth store. */
  io?: AccountStoreIo<S>
}

export class AccountTokenManager<S extends TimedSession> {
  private readonly managers = new Map<string, TokenManager<S>>()
  private readonly io: AccountStoreIo<S>

  constructor(private readonly options: AccountTokenManagerOptions<S>) {
    const provider = options.provider
    this.io = options.io ?? {
      list: () => listAccounts(provider) as Promise<AccountEntry<S>[]>,
      get: account => getAccountSession(provider, account) as Promise<S | undefined>,
      save: (account, session) => saveAccountSession(provider, account, session as never),
      remove: account => deleteAccountSession(provider, account),
      resolve: account => resolveAccountKey(provider, account),
    }
  }

  /** The provider's accounts, default first (straight from the store). */
  list(): Promise<AccountEntry<S>[]> {
    return this.io.list()
  }

  /** The default account's key, or undefined when logged out. */
  async defaultAccount(): Promise<string | undefined> {
    return (await this.list())[0]?.key
  }

  /**
   * Resolve a usable session for one account (default when omitted),
   * refreshing proactively or on demand.
   * @param account - the account key; the default account when undefined.
   * @param forceRefresh - refresh regardless of expiry (used after a 401).
   * @returns the persisted session to send.
   * @throws LlmError MISSING_CREDENTIAL when the account is not logged in.
   */
  async session(account?: string, forceRefresh = false): Promise<S> {
    const requested = account ?? await this.defaultAccount()
    if (requested === undefined) throw this.missingCredential()
    const key = await this.resolveAccount(requested)
    return this.tokensFor(key).session(forceRefresh)
  }

  /** Resolve a legacy alias before it reaches any per-account manager or cache. */
  resolveAccount(account: string): Promise<string> {
    return this.io.resolve?.(account) ?? Promise.resolve(account)
  }

  /** Read an account's stored session without any refresh side effect. */
  async peek(account?: string): Promise<S | undefined> {
    return this.io.get(account === undefined ? undefined : await this.resolveAccount(account))
  }

  /** Whether a session is stored for the account (cheap; never refreshes). */
  async hasSession(account?: string): Promise<boolean> {
    return (await this.peek(account)) !== undefined
  }

  /** The TokenManager bound to one account (created lazily, then cached). */
  tokensFor(account: string): TokenManager<S> {
    let manager = this.managers.get(account)
    if (manager === undefined) {
      const io = this.io
      manager = new TokenManager<S>({
        displayName: this.options.displayName,
        ...this.options.makeOptions(account),
        load: () => io.get(account),
        save: async session => {
          await io.save(account, session)
          const canonical = await this.resolveAccount(account)
          if (canonical !== account) {
            this.managers.set(canonical, manager!)
            if (this.managers.get(account) === manager) this.managers.delete(account)
          }
        },
        remove: () => io.remove(account),
        onRemoved: () => { this.options.onAccountRemoved?.(account) },
      })
      this.managers.set(account, manager)
    }
    return manager
  }

  /** The logged-out error, mirroring TokenManager's own message. */
  private missingCredential(): LlmError {
    return new LlmError(
      `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; `
      + 'log in via Settings → Subscriptions in the dsh web app',
      'MISSING_CREDENTIAL',
    )
  }
}
