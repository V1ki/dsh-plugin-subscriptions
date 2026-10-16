/** Explain client-side gating; the server independently revalidates before spending. */
export declare function resetActionBlock(usage: {
    windows?: {
        kind: string;
        scope?: string;
        usedPercent: number;
        resetsAt?: number;
    }[];
    resetCredits?: {
        id?: string;
        expiresAt?: number;
    }[];
    resetCreditsError?: string;
}, now?: number): 'resetUseGuard' | 'resetUseRefresh' | 'resetUseRestart' | undefined;
