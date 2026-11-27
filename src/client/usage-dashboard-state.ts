import type { TrackedProvider } from '../usage/usage-schema.js'
import type { DashboardRange, UsageDashboardResponse } from '../usage/usage-dashboard.js'

export type ProviderFilter = TrackedProvider | 'all'
export type DistributionMode = 'model' | 'provider'

export interface UsageDashboardRequest {
  provider: ProviderFilter
  account: string | 'all'
  range: DashboardRange
}

export interface UsageDashboardState {
  phase: 'loading' | 'shown' | 'error'
  request: UsageDashboardRequest
  distributionMode: DistributionMode
  selectedDate?: string
  /** Incremented whenever a fresh RPC fetch is required. */
  load: number
  /** Last successful dashboard response (retained during subsequent loads so UI stays stable). */
  response?: UsageDashboardResponse
  error?: string
  clearErrors: string[]
}

export type UsageDashboardAction =
  | { type: 'loaded'; response: UsageDashboardResponse }
  | { type: 'failed'; message: string }
  | { type: 'provider'; provider: ProviderFilter }
  | { type: 'account'; account: string | 'all' }
  | { type: 'providerAccount'; provider: TrackedProvider; account: string }
  | { type: 'range'; range: DashboardRange }
  | { type: 'resetFilters' }
  | { type: 'distribution'; mode: DistributionMode }
  | { type: 'selectDate'; date?: string }
  | { type: 'refresh' }
  | { type: 'retry' }
  | { type: 'cleared'; clearErrors: string[] }

export function initialUsageDashboardState(): UsageDashboardState {
  return {
    phase: 'loading',
    request: { provider: 'all', account: 'all', range: '30d' },
    distributionMode: 'model',
    load: 0,
    clearErrors: [],
  }
}

function reload(state: UsageDashboardState, request: UsageDashboardRequest): UsageDashboardState {
  const { error: _error, ...rest } = state
  return { ...rest, phase: 'loading', request, load: state.load + 1 }
}

export function usageDashboardReducer(state: UsageDashboardState, action: UsageDashboardAction): UsageDashboardState {
  switch (action.type) {
    case 'loaded': {
      const { error: _error, selectedDate, ...rest } = state
      const keepDate = selectedDate !== undefined && action.response.heatmap.some(day => day.date === selectedDate)
      return {
        ...rest,
        ...keepDate ? { selectedDate } : {},
        phase: 'shown',
        response: action.response,
      }
    }
    case 'failed':
      return { ...state, phase: 'error', error: action.message }
    case 'provider': {
      if (state.request.provider === action.provider && state.request.account === 'all') return state
      const next = reload(state, { ...state.request, provider: action.provider, account: 'all' })
      // Auto-switch distribution to 'model' when narrowing to a single provider so the chart stays informative.
      return action.provider !== 'all' && state.distributionMode === 'provider'
        ? { ...next, distributionMode: 'model' }
        : next
    }
    case 'account': {
      if (state.request.account === action.account) return state
      return reload(state, { ...state.request, account: action.account })
    }
    case 'providerAccount': {
      if (state.request.provider === action.provider && state.request.account === action.account) return state
      const next = reload(state, { ...state.request, provider: action.provider, account: action.account })
      return state.distributionMode === 'provider' ? { ...next, distributionMode: 'model' } : next
    }
    case 'range': {
      if (state.request.range === action.range) return state
      return reload(state, { ...state.request, range: action.range })
    }
    case 'resetFilters':
      return reload(state, { provider: 'all', account: 'all', range: 'all' })
    case 'distribution':
      return state.distributionMode === action.mode ? state : { ...state, distributionMode: action.mode }
    case 'selectDate': {
      const { selectedDate: current, ...rest } = state
      if (action.date === undefined || action.date === current) return rest
      return { ...rest, selectedDate: action.date }
    }
    case 'refresh':
    case 'retry':
      return reload(state, state.request)
    case 'cleared': {
      const { selectedDate: _date, ...rest } = reload(state, state.request)
      return { ...rest, clearErrors: action.clearErrors }
    }
  }
}

export interface ClearConfirmState {
  phase: 'open' | 'clearing' | 'failed'
  error?: string
}

export type ClearConfirmAction =
  | { type: 'confirm' }
  | { type: 'failed'; message: string }

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
