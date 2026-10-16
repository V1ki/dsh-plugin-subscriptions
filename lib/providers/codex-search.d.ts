import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import type { CodexSession } from '../auth/store.js';
import type { AccountTokenManager } from '../providers/accounts.js';
export declare const CODEX_SEARCH_PROVIDER_ID = "codex";
export declare const CODEX_SEARCH_URL = "https://chatgpt.com/backend-api/codex/alpha/search";
export declare const CODEX_SEARCH_MODEL = "gpt-5.6-terra";
export interface CodexWebSearchOptions {
    tokens: Pick<AccountTokenManager<CodexSession>, 'session'>;
    /**
     * Current state of the Codex `web_search` tool switch. Absent counts as
     * enabled. Read on every {@link CodexWebSearchProvider.available} call so
     * turning the switch off releases the seam to another search provider
     * instead of denying the host's tool.
     */
    enabled?: () => boolean;
    fetchFn?: typeof fetch;
    requestId?: () => string;
    retryBaseMs?: number;
}
/** Search provider registered behind DSH's stock web_search tool and citation UI. */
export declare class CodexWebSearchProvider implements WebSearchProvider {
    private readonly options;
    readonly id = "codex";
    constructor(options: CodexWebSearchOptions);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    private dispatch;
}
export declare function normalizeCodexSearchResponse(value: unknown): WebSearchResult;
