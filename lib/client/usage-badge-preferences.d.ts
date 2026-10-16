/** Display-only preference: no credentials or account history are stored. */
export type UsageBadgeMode = 'recent' | 'hidden';
/** Read the browser preference; blocked storage retains the default display. */
export declare function readUsageBadgeMode(): UsageBadgeMode;
/** Save first, then notify; the settings control reports a rejected write. */
export declare function setUsageBadgeMode(mode: UsageBadgeMode): void;
/** Same-tab writes need a custom event; other tabs use the storage event. */
export declare function subscribeUsageBadgeMode(notify: () => void): () => void;
/** Shared React snapshot used by the settings control and every mounted badge. */
export declare function useUsageBadgeMode(): UsageBadgeMode;
