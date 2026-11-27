import { useSyncExternalStore } from 'react'

/** Display-only preference: no credentials or account history are stored. */
export type UsageBadgeMode = 'recent' | 'hidden'
const MODE_KEY = 'dsh.subscriptions.usageBadgeMode'
const MODE_EVENT = 'dsh:subscriptions:usage-badge-mode'

/** Read the browser preference; blocked storage retains the default display. */
export function readUsageBadgeMode(): UsageBadgeMode {
  if (typeof window === 'undefined') return 'recent'
  try {
    return window.localStorage.getItem(MODE_KEY) === 'hidden' ? 'hidden' : 'recent'
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
    return 'recent'
  }
}

/** Save first, then notify; the settings control reports a rejected write. */
export function setUsageBadgeMode(mode: UsageBadgeMode): void {
  if (mode !== 'recent' && mode !== 'hidden') throw new TypeError('Invalid subscription usage display mode')
  window.localStorage.setItem(MODE_KEY, mode)
  window.dispatchEvent(new Event(MODE_EVENT))
}

/** Same-tab writes need a custom event; other tabs use the storage event. */
export function subscribeUsageBadgeMode(notify: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === MODE_KEY || event.key === null) notify()
  }
  window.addEventListener(MODE_EVENT, notify)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(MODE_EVENT, notify)
    window.removeEventListener('storage', onStorage)
  }
}

/** Shared React snapshot used by the settings control and every mounted badge. */
export function useUsageBadgeMode(): UsageBadgeMode {
  return useSyncExternalStore(subscribeUsageBadgeMode, readUsageBadgeMode, () => 'recent')
}

/** Local-only visual preference; does not alter the provider or fetched usage. */
export type UsageBadgeStyle = 'compact' | 'text'
const STYLE_KEY = 'dsh.subscriptions.usageBadgeStyle'
const STYLE_EVENT = 'dsh:subscriptions:usage-badge-style'

export function readUsageBadgeStyle(): UsageBadgeStyle {
  if (typeof window === 'undefined') return 'text'
  try {
    return window.localStorage.getItem(STYLE_KEY) === 'compact' ? 'compact' : 'text'
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
    return 'text'
  }
}

export function setUsageBadgeStyle(style: UsageBadgeStyle): void {
  if (style !== 'compact' && style !== 'text') throw new TypeError('Invalid subscription usage badge style')
  window.localStorage.setItem(STYLE_KEY, style)
  window.dispatchEvent(new Event(STYLE_EVENT))
}

export function subscribeUsageBadgeStyle(notify: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STYLE_KEY || event.key === null) notify()
  }
  window.addEventListener(STYLE_EVENT, notify)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(STYLE_EVENT, notify)
    window.removeEventListener('storage', onStorage)
  }
}

export function useUsageBadgeStyle(): UsageBadgeStyle {
  return useSyncExternalStore(subscribeUsageBadgeStyle, readUsageBadgeStyle, () => 'text')
}

/** Display-only linear spending guide; OFF is explicit, ON is the default. */
const BUDGET_KEY = 'dsh.subscriptions.budgetTargetLine'
const BUDGET_EVENT = 'dsh:subscriptions:budget-target-line'

export function readBudgetTargetLine(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(BUDGET_KEY) !== 'off'
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
    return true
  }
}

export function setBudgetTargetLine(enabled: boolean): void {
  if (typeof enabled !== 'boolean') throw new TypeError('Invalid budget target preference')
  window.localStorage.setItem(BUDGET_KEY, enabled ? 'on' : 'off')
  window.dispatchEvent(new Event(BUDGET_EVENT))
}

export function subscribeBudgetTargetLine(notify: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === BUDGET_KEY || event.key === null) notify()
  }
  window.addEventListener(BUDGET_EVENT, notify)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(BUDGET_EVENT, notify)
    window.removeEventListener('storage', onStorage)
  }
}

export function useBudgetTargetLine(): boolean {
  return useSyncExternalStore(subscribeBudgetTargetLine, readBudgetTargetLine, () => true)
}

/** Independent of badge visibility; defaults preserve existing used semantics. */
export type QuotaDisplayMode = 'used' | 'remaining'
const QUOTA_KEY = 'dsh.subscriptions.quotaDisplayMode'
const QUOTA_EVENT = 'dsh:subscriptions:quota-display-mode'

/** Read the browser preference; blocked storage retains the default display. */
export function readQuotaDisplayMode(): QuotaDisplayMode {
  if (typeof window === 'undefined') return 'used'
  try {
    return window.localStorage.getItem(QUOTA_KEY) === 'remaining' ? 'remaining' : 'used'
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
    return 'used'
  }
}

/** Save first, then notify; the settings control reports a rejected write. */
export function setQuotaDisplayMode(mode: QuotaDisplayMode): void {
  if (mode !== 'used' && mode !== 'remaining') throw new TypeError('Invalid subscription usage display mode')
  window.localStorage.setItem(QUOTA_KEY, mode)
  window.dispatchEvent(new Event(QUOTA_EVENT))
}

/** Same-tab writes need a custom event; other tabs use the storage event. */
export function subscribeQuotaDisplayMode(notify: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === QUOTA_KEY || event.key === null) notify()
  }
  window.addEventListener(QUOTA_EVENT, notify)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(QUOTA_EVENT, notify)
    window.removeEventListener('storage', onStorage)
  }
}

/** Shared React snapshot used by the settings control and every mounted badge. */
export function useQuotaDisplayMode(): QuotaDisplayMode {
  return useSyncExternalStore(subscribeQuotaDisplayMode, readQuotaDisplayMode, () => 'used')
}
