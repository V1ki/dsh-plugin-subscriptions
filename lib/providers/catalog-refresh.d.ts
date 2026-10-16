/** Model catalogs refresh at startup, then one hour after each run completes. */
export declare const CATALOG_REFRESH_INTERVAL_MS: number;
/** Start a non-overlapping, disposable loop; failures wait for the next interval. */
export declare function startCatalogRefresh(refresh: (signal: AbortSignal) => Promise<unknown>, onError?: (error: unknown) => void): () => void;
