import type { AccountUsageResponse } from '../usage/usage-rpc.js'
import type { KindOption } from '../usage/window-view.js'

/** What the next `accountUsage` call asks for. */
export interface UsageRequest {
  account?: string
  kind?: KindOption['kind']
  scope?: string
  at?: number
}

export interface UsageDialogState {
  phase: 'loading' | 'shown' | 'error'
  request: UsageRequest
  /** Bumped by every action that needs a new read; the component loads on change. */
  load: number
  /** The last successful response; kept while a refresh loads. */
  response?: AccountUsageResponse
  /** Last automatic expiration read, retained across loading and response changes. */
  lastExpiryReadAt?: number
  error?: string
}

export type UsageDialogAction =
  | { type: 'loaded', response: AccountUsageResponse }
  | { type: 'failed', message: string }
  | { type: 'retry' }
  | { type: 'previous' }
  | { type: 'next' }
  | { type: 'kind', option: KindOption }
  | { type: 'account', account: string }
  /** Re-read the same window, or the current one when no instant is pinned when a reset passes. */
  | { type: 'refresh' }
  | { type: 'clock', now: number }
  /** After a clear: back to the post-clear default view of the same account. */
  | { type: 'cleared' }

/** The dialog opened on `account` (option B: the row the user clicked), default view. */
export function initialUsageDialogState(account?: string): UsageDialogState {
  return { phase: 'loading', request: account === undefined ? {} : { account }, load: 0 }
}

function reload(state: UsageDialogState, request: UsageRequest): UsageDialogState {
  const { error: _error, ...rest } = state
  return { ...rest, phase: 'loading', request, load: state.load + 1 }
}

/** The account the response is about, so a navigation keeps it. */
function accountOf(state: UsageDialogState): Pick<UsageRequest, 'account'> {
  const account = state.response?.account ?? state.request.account
  return account === undefined ? {} : { account }
}

/** The selected kind and scope, so stepping keeps the kind. */
function selectedOf(state: UsageDialogState): Pick<UsageRequest, 'kind' | 'scope'> {
  const selected = state.response?.view.selected
  if (selected === undefined) return {}
  return selected.scope === undefined ? { kind: selected.kind } : { kind: selected.kind, scope: selected.scope }
}

const EXPIRED_RECHECK_MS = 60_000

function currentRequest(state: UsageDialogState): UsageRequest {
  return { ...accountOf(state), ...selectedOf(state) }
}

export function usageDialogReducer(state: UsageDialogState, action: UsageDialogAction): UsageDialogState {
  switch (action.type) {
    case 'loaded': {
      const { error: _error, ...rest } = state
      // The first quota snapshot can replace a pending selection with a
      // concrete kind; subsequent retry/refresh should follow that selection.
      const next = { ...rest, phase: 'shown' as const, response: action.response }
      const selected = next.response.view.selected
      return state.request.kind === 'pending' && selected !== undefined && selected.kind !== 'pending'
        ? { ...next, request: currentRequest(next) }
        : next
    }
    case 'failed':
      return { ...state, phase: 'error', error: action.message }
    case 'retry':
      return reload(state, state.request)
    case 'refresh': {
      // On the current window, refresh asks for "the current window" again, not the instant it was reached by,
      // so a reset that passed meanwhile shows the next window; a past window stays pinned.
      if (state.response?.view.window?.current !== true) return reload(state, state.request)
      return reload(state, currentRequest(state))
    }
    case 'clock': {
      const window = state.response?.view.window
      if (state.phase !== 'shown' || window?.current !== true || window.end === undefined || action.now < window.end) return state
      if (state.lastExpiryReadAt !== undefined && action.now < state.lastExpiryReadAt + EXPIRED_RECHECK_MS) return state
      return { ...reload(state, currentRequest(state)), lastExpiryReadAt: action.now }
    }
    case 'previous':
    case 'next': {
      const at = action.type === 'previous' ? state.response?.view.previousAt : state.response?.view.nextAt
      // At an end the button is disabled; a stray action changes nothing.
      if (at === undefined || state.phase === 'loading') return state
      return reload(state, { ...accountOf(state), ...selectedOf(state), at })
    }
    case 'kind':
      // A kind switch resets to that kind's current window.
      return reload(state, { ...accountOf(state), kind: action.option.kind, ...action.option.scope === undefined ? {} : { scope: action.option.scope } })
    case 'account':
      // An account switch resets to its current window of the first kind.
      return reload(state, { account: action.account })
    case 'cleared':
      return reload(state, accountOf(state))
  }
}

export interface ClearConfirmState {
  phase: 'open' | 'clearing' | 'failed'
  error?: string
}

export type ClearConfirmAction =
  | { type: 'confirm' }
  | { type: 'failed', message: string }

export const CLEAR_CONFIRM_OPEN: ClearConfirmState = { phase: 'open' }

/** Cancel and success close the confirmation, so they are the caller's, not states here. */
export function clearConfirmReducer(state: ClearConfirmState, action: ClearConfirmAction): ClearConfirmState {
  switch (action.type) {
    case 'confirm':
      return state.phase === 'clearing' ? state : { phase: 'clearing' }
    case 'failed':
      return { phase: 'failed', error: action.message }
  }
}
