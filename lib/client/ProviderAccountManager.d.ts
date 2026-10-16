import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
import type { SubscriptionProvider } from './SubscriptionsSection.js';
import type { SubscriptionsKey } from './locales.js';
interface Props {
    provider: SubscriptionProvider;
    name: string;
    rpc: ConnectionHandle['rpc'];
    t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string;
    onClose: () => void;
}
/** Native top-layer dialog provides keyboard containment, Escape and focus restoration. */
export declare function ProviderAccountManager({ provider, name, rpc, t, onClose }: Props): import("react").JSX.Element;
export {};
