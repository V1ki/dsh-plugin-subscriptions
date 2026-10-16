import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { SubscriptionsKey } from './locales.js';
export type { SubscriptionsSectionInjected, SubscriptionsSectionProps } from './SubscriptionsSection.js';
export type { ImageGenerateToolviewInjected, ImageGenerateToolviewProps } from './ImageGenerateToolview.js';
export type { VideoGenerateToolviewInjected, VideoGenerateToolviewProps } from './VideoGenerateToolview.js';
export type { SpeedSelectInjected, SpeedSelectProps, SpeedState, SpeedTier } from './SpeedSelect.js';
export type { SubscriptionUsageBadgeInjected, SubscriptionUsageBadgeProps } from './SubscriptionUsageBadge.js';
export type { SubscriptionsKey } from './locales.js';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The Subscriptions settings page copy. */
        'settings.subscriptions': SubscriptionsKey;
    }
}
/**
 * Required services (cordis fiber inject): `slots` carries the registration
 * seat, `connection` the `/subscriptions-auth` RPC caller, and `locale` the copy
 * dictionaries.
 */
export declare const inject: string[];
/**
 * Register the Subscriptions section once the `settings.section` declaration
 * is on the ledger (the shell's apply order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`).
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
