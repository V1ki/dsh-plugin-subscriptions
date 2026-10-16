import type { SubscriptionProvider } from './SubscriptionsSection.js';
/** Notify mounted views after a successful save, without another quota request. */
export declare const DISPLAY_NAME_CHANGED = "dsh-subscriptions-display-name-changed";
export interface DisplayNameChange {
    provider: SubscriptionProvider;
    displayName?: string;
}
export declare function notifyDisplayNameChange(provider: SubscriptionProvider, displayName?: string): void;
