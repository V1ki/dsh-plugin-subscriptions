/**
 * The controller behind the `accountUsage` and `clearUsageHistory` endpoints
 *. `src/auth/rpc.ts` validates the payload shape
 * and the provider; this module resolves the account, checks the kind and
 * scope against what the provider reports, and calls the usage service.
 * It lives here rather than in `index.ts` so it can be tested without a
 * cordis boot; `index.ts` only supplies the account list.
 */
import type { TrackedProvider } from './constants.js'
import type { AccountUsageQuery, ClearResult, StoredSummary, UsageService } from './service.js'
import type { UsageView, ViewKind } from './window-view.js'

/** One account the dialog can switch to. */
export interface UsageAccount {
  key: string
  /** Display identity (email or login) of a logged-in account; a removed account shows its key. */
  label?: string
  /** False: history only, read-only, no live quota. */
  loggedIn: boolean
  isDefault: boolean
}

/** A logged-in account as the auth store lists it, default first. */
export interface LoggedInAccount {
  key: string
  label?: string
}

export interface AccountUsagePayload {
  provider: TrackedProvider
  account?: string
  kind?: ViewKind
  scope?: string
  at?: number
}

export interface AccountUsageResponse {
  provider: TrackedProvider
  /** Absent when the provider has no logged-in account and no stored history. */
  account?: string
  /** Logged-in accounts in the card's order (default first), then accounts with stored history only. */
  accounts: UsageAccount[]
  view: UsageView
  /** The provider's stored history, for the clear confirmation. */
  stored: StoredSummary
  errors: string[]
}

export interface UsageHistoryController {
  accountUsage(payload: AccountUsagePayload): Promise<AccountUsageResponse>
  clearUsageHistory(provider: TrackedProvider): Promise<ClearResult>
}

/** A payload naming a kind or scope the provider does not report. */
export class UsageQueryRejected extends Error {}

/**
 * An account key no stored entry can have: the view of it is the provider's
 * empty state with its provider total, which §4 shows when there is no
 * account at all.
 */
const NO_ACCOUNT = ''

const REJECTIONS = {
  kind: (kind: string) => `kind "${kind}" is not reported for this account`,
  scope: (kind: string, scope: string | undefined) => scope === undefined
    ? `kind "${kind}" is reported only with a scope; name one`
    : `scope "${scope}" is not reported for kind "${kind}"`,
} as const

/** The dialog's account list: logged-in first, in the card's order, then stored-only accounts in key order. */
function usageAccounts(loggedIn: readonly LoggedInAccount[], stored: readonly string[]): UsageAccount[] {
  const keys = new Set(loggedIn.map(account => account.key))
  return [
    ...loggedIn.map((account, index) => ({
      key: account.key,
      ...account.label === undefined ? {} : { label: account.label },
      loggedIn: true,
      isDefault: index === 0,
    })),
    ...stored.filter(key => !keys.has(key)).map(key => ({ key, loggedIn: false, isDefault: false })),
  ]
}

/**
 * Reject a kind or scope the view does not list, as an exact option: a kind
 * reported only with scopes (per-model windows) needs one of them. Checked
 * after reading, because only the view knows what is reported.
 */
function checkReported(view: UsageView, payload: AccountUsagePayload): void {
  if (payload.kind === undefined) return
  // An open pending dialog can retry after the first snapshot classifies
  // its usage. The view has already selected a currently valid kind.
  if (payload.kind === 'pending' && payload.scope === undefined
      && !view.kinds.some(option => option.kind === 'pending')) return
  if (!view.kinds.some(option => option.kind === payload.kind)) throw new UsageQueryRejected(REJECTIONS.kind(payload.kind))
  if (!view.kinds.some(option => option.kind === payload.kind && option.scope === payload.scope)) {
    throw new UsageQueryRejected(REJECTIONS.scope(payload.kind, payload.scope))
  }
}

/**
 * @param service - the usage reader.
 * @param loggedInAccounts - the provider's logged-in accounts, default first; a store read, no token refresh.
 */
export function createUsageHistoryController(
  service: Pick<UsageService, 'read' | 'accounts' | 'summary' | 'clear'>,
  loggedInAccounts: (provider: TrackedProvider) => Promise<LoggedInAccount[]>,
): UsageHistoryController {
  return {
    async accountUsage(payload) {
      const [loggedIn, storedAccounts] = await Promise.all([loggedInAccounts(payload.provider), service.accounts(payload.provider)])
      const accounts = usageAccounts(loggedIn, storedAccounts)
      const account = payload.account ?? accounts[0]?.key
      const query: AccountUsageQuery = {
        provider: payload.provider,
        account: account ?? NO_ACCOUNT,
          ...payload.kind === undefined ? {} : { kind: payload.kind },
        ...payload.scope === undefined ? {} : { scope: payload.scope },
        ...payload.at === undefined ? {} : { at: payload.at },
      }
      const [{ view, errors }, stored] = await Promise.all([service.read(query), service.summary(payload.provider)])
      checkReported(view, payload)
      return { provider: payload.provider, ...account === undefined ? {} : { account }, accounts, view, stored, errors }
    },
    clearUsageHistory: provider => service.clear(provider),
  }
}
