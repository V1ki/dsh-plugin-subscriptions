import type { FetchFn } from './common.js';
/**
 * Compare two stable `major.minor.patch` versions numerically.
 * @returns negative when `a` is older, positive when newer, 0 when equal.
 */
export declare function compareVersions(a: string, b: string): number;
/** Where a presented CLI version came from; shown in Settings so a stale one is visible. */
export type CliVersionSource = 'npm' | 'local' | 'fallback' | 'config';
/** The CLI version a route presents, and where it came from. */
export interface CliVersion {
    version: string;
    source: CliVersionSource;
}
export interface NpmCliVersionOptions {
    /** Registry metadata of the package's `latest` dist-tag; public, so never send credentials. */
    url: string;
    /** Names the CLI in lookup errors. */
    label: string;
    /**
     * The version served until a lookup succeeds, and the floor a looked-up
     * version may never go below. Read once, on first use, so a costly probe
     * (a local CLI's `--version`) never runs for an unused provider.
     */
    floor: () => CliVersion;
    fetchFn?: FetchFn;
    now?: () => number;
    timeoutMs?: number;
}
/**
 * Lazy, shared-per-plugin lookup of an official CLI's newest stable version
 * on npm. Subscription endpoints gate new models on the client version they
 * see, so presenting the released CLI's version keeps new models usable
 * without a plugin release for every CLI bump.
 */
export declare class NpmCliVersionCache {
    private readonly options;
    private presented;
    /** Whether a lookup has finished yet, successfully or not. */
    private settled;
    private expiresAt;
    private pending;
    private readonly fetchFn;
    private readonly now;
    private readonly timeoutMs;
    constructor(options: NpmCliVersionOptions);
    /** A manual catalog refresh also checks for a newly released CLI. */
    invalidate(): void;
    resolve(): Promise<string>;
    /**
     * The version presented right now, without waiting on the registry;
     * undefined until the first lookup finishes, so a lookup still in flight
     * is never reported as a failed one.
     */
    current(): CliVersion | undefined;
    private refresh;
}
