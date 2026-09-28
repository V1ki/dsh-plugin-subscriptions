import type { SubscriptionProvider } from './SubscriptionsSection.js'

/** Notify mounted views after a successful save, without another quota request. */
export const DISPLAY_NAME_CHANGED = 'dsh-subscriptions-display-name-changed'
export interface DisplayNameChange { provider: SubscriptionProvider; displayName?: string }
export function notifyDisplayNameChange(provider: SubscriptionProvider, displayName?: string) {
  window.dispatchEvent(new CustomEvent<DisplayNameChange>(DISPLAY_NAME_CHANGED, {
    detail: { provider, ...(displayName?.trim() ? { displayName: displayName.trim() } : {}) },
  }))
}
