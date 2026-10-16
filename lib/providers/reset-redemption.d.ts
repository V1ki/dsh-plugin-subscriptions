import type { ProviderUsage } from './common.js';
export interface ResetConfirmation {
    ticket: string;
    expiresAt: number;
    creditExpiresAt?: number;
    weeklyUsedPercent: number;
}
/** Manual-only redemption. Tickets are single-use; uncertain submissions park the account. */
export declare class ResetRedemption {
    private readonly read;
    private readonly consume;
    private readonly invalidate;
    private tickets;
    private busy;
    private uncertain;
    constructor(read: (account: string, signal: AbortSignal) => Promise<ProviderUsage>, consume: (account: string, creditId: string, requestId: string, signal: AbortSignal) => Promise<void>, invalidate: (account: string) => void);
    private eligible;
    prepare(account: string, signal: AbortSignal): Promise<ResetConfirmation>;
    redeem(account: string, ticket: string, signal: AbortSignal): Promise<void>;
}
