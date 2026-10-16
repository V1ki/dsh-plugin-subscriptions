import type { FetchFn } from './common.js';
import { NpmCliVersionCache } from './npm-cli-version.js';
/** Public metadata only: never send subscription credentials to this endpoint. */
export declare const CODEX_VERSION_URL = "https://registry.npmjs.org/@openai%2fcodex/latest";
/** Lazy, shared-per-plugin lookup of the official CLI's stable version. */
export declare class CodexClientVersionCache extends NpmCliVersionCache {
    constructor(fetchFn?: FetchFn, now?: () => number, timeoutMs?: number);
}
