import type { SubscriptionsKey } from './locales.js';
type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string;
/** Browser-local display preference; never changes provider or account settings. */
export declare function UsageBadgeDisplaySetting({ t }: {
    t: Translate;
}): import("react").JSX.Element;
export {};
