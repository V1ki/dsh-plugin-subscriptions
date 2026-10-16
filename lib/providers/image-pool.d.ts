import type { AccountTokenManager } from './accounts.js';
import type { RateLimitResetReader } from './rate-limit.js';
type ImageProvider = 'codex' | 'grok';
interface ImageSession {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}
export interface ImageAccountRequest<S extends ImageSession> {
    provider: ImageProvider;
    tokens: AccountTokenManager<S>;
    signal: AbortSignal;
    /** Session object identity provides bounded-lifetime affinity, also across generate/edit. */
    owner?: object | undefined;
    rateLimitReset: RateLimitResetReader;
    send: (session: S) => Promise<Response>;
}
export declare class ImageAccountPool {
    private readonly options;
    private readonly health;
    private sticky;
    constructor(options?: {
        enabled?: boolean;
        onWarn?: (message: string) => void;
    });
    /** Login/logout clears cooling image members and stale session affinity. */
    clear(provider: ImageProvider, account?: string): void;
    request<S extends ImageSession>(request: ImageAccountRequest<S>): Promise<Response>;
}
export {};
