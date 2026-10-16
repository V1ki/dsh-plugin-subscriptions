/**
 * On-disk OAuth session store at `~/.dsh/plugins/subscriptions/auth.json`.
 *
 * The file is a JSON object keyed by provider id, each entry holding that
 * provider's ACCOUNTS: a map of account key → session plus the default
 * account's key. Writes are atomic (tmp file + rename) with mode 0600
 * because they carry bearer tokens. Session shapes live here (not in the
 * provider modules) because this file owns the durable format.
 *
 * Backward compatibility: entries written by single-account versions hold
 * the session fields directly (no `accounts` wrapper); reads migrate them
 * in memory, and the next write persists the new shape — existing logins
 * survive the upgrade untouched.
 */
/** Provider routes this plugin can serve. */
export type ProviderId = 'codex' | 'claude' | 'grok' | 'copilot' | 'antigravity';
/** Every provider route, in display order. */
export declare const PROVIDER_IDS: readonly ProviderId[];
/** Stored ChatGPT/Codex subscription session. */
export interface CodexSession {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds at which the access token expires. */
    expiresAt: number;
    /** `chatgpt_account_id` claim from the id token; sent as the `chatgpt-account-id` header. */
    accountId: string;
    idToken?: string;
    /** User email from the id token, when the token carried it. */
    emailAddress?: string;
    /** `chatgpt_plan_type` claim from the id token (e.g. `plus`, `pro`), when present. */
    planType?: string;
}
/** Stored Claude Pro/Max subscription session. */
export interface ClaudeSession {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds at which the access token expires. */
    expiresAt: number;
    /** Scope string the tokens were issued with; echoed on refresh. */
    scopes: string;
    emailAddress?: string;
    subscriptionType?: string;
    /**
     * True when this account was imported from Claude Code's own credential
     * store (Keychain/file): only bound accounts sync refreshes back to it.
     */
    keychainBound?: boolean;
}
/** Stored Grok (X Premium / xAI) subscription session. */
export interface GrokSession {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds at which the access token expires. */
    expiresAt: number;
    /** Token endpoint from OIDC discovery; retained for refreshes. */
    tokenEndpoint: string;
    scopes?: string;
    /** Display account: email, username, or subject claim from the id token. */
    account?: string;
}
/**
 * Stored GitHub Copilot subscription session. Two token generations are at
 * play: the long-lived GitHub OAuth token from the device flow is kept in
 * `refreshToken`, and `accessToken` carries the short-lived (~30 minutes)
 * Copilot API token exchanged from it. A "refresh" is therefore a fresh
 * exchange against `copilot_internal/v2/token`, not an OAuth grant.
 */
export interface CopilotSession {
    /** Copilot API token; sent as the bearer on api.githubcopilot.com. */
    accessToken: string;
    /** Long-lived GitHub OAuth token from the device flow. */
    refreshToken: string;
    /** Epoch milliseconds at which the Copilot API token expires. */
    expiresAt: number;
    /** GitHub login name, for the status display. */
    account?: string;
}
/** Stored Google OAuth session for the Antigravity v1internal API. */
export interface AntigravitySession {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds at which the Google access token expires. */
    expiresAt: number;
    /** Cloud AI Companion project required by Antigravity request envelopes. */
    projectId: string;
    /** Google account email, for the status display. */
    account?: string;
    /** Subscription tier observed during project discovery. */
    plan?: string;
    /** Granted Google OAuth scopes, when the token endpoint returned them. */
    scopes?: string;
}
/** One provider's accounts: account key → session, plus the default account. */
export interface ProviderAccounts<S> {
    /** Key of the account direct (non-pool) routes serve; the first login wins. */
    default?: string;
    accounts: Record<string, S>;
    /** Old keys remain bound to their migrated account, never a workspace sibling. */
    aliases?: Record<string, string>;
}
/** The durable store shape: per provider, its accounts. */
export interface SessionMap {
    codex?: ProviderAccounts<CodexSession>;
    claude?: ProviderAccounts<ClaudeSession>;
    grok?: ProviderAccounts<GrokSession>;
    copilot?: ProviderAccounts<CopilotSession>;
    antigravity?: ProviderAccounts<AntigravitySession>;
}
/** Any stored session, for provider-agnostic plumbing. */
export type StoredSession = CodexSession | ClaudeSession | GrokSession | CopilotSession | AntigravitySession;
/** The session type one provider stores. */
export type SessionOf<K extends ProviderId> = NonNullable<SessionMap[K]>['accounts'][string];
/** One account entry as returned by {@link listAccounts} (default first). */
export interface AccountEntry<S> {
    key: string;
    session: S;
}
/**
 * The stable identity of one session's account: Codex keys on workspace AND
 * user (email fallback, workspace-only for unidentified legacy sessions),
 * the others on their display identity, falling
 * back to a refresh-token hash for sessions stored before identity fields
 * existed. Logging the same account in again lands on the same key, so a
 * re-login updates in place instead of duplicating. (The hash fallback can
 * miss that dedup once for a legacy session re-logged with a now-known
 * identity — the duplicate is visible on the Settings page and can simply
 * be logged out.)
 * @param provider - the provider route.
 * @param session - the session to key.
 * @returns the account map key.
 */
export declare function accountKeyOf(provider: ProviderId, session: StoredSession): string;
/**
 * Resolve a persisted legacy account key to its canonical account identity.
 * For Codex, a reference that matches no key or alias also resolves through
 * a unique login email or workspace ID (see {@link resolveCodexReference}).
 */
export declare function resolveAccountKey(provider: ProviderId, account: string, path?: string): Promise<string>;
/**
 * Absolute path of the auth store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
 */
export declare function authFilePath(): string;
/**
 * Read the whole store. A missing file is an empty store; malformed JSON or a
 * malformed entry throws, because silently discarding tokens would strand the
 * user without a diagnosis. Single-account entries are migrated in memory;
 * the next write persists the new shape.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the parsed session map.
 */
export declare function loadStore(path?: string): Promise<SessionMap>;
/**
 * List one provider's accounts, default first.
 * @param provider - the provider route.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the account entries in stable order (empty when logged out).
 */
export declare function listAccounts<K extends ProviderId>(provider: K, path?: string): Promise<AccountEntry<SessionOf<K>>[]>;
/**
 * Read one account's session.
 * @param provider - the provider route.
 * @param account - the account key; defaults to the provider's default account.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the stored session, or `undefined` when absent.
 */
export declare function getAccountSession<K extends ProviderId>(provider: K, account?: string, path?: string): Promise<SessionOf<K> | undefined>;
/**
 * Write one account's session, preserving the others. The first account of a
 * provider becomes its default.
 *
 * The session is validated before it lands: a corrupt entry written here
 * would fail every later read of the whole store (one bad entry breaks all
 * providers' status), so the write path must be as strict as the read path.
 * @param provider - the provider route.
 * @param account - the account key (see {@link accountKeyOf}).
 * @param session - the fresh session from a login or refresh.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @throws when the session is missing accessToken/refreshToken/expiresAt.
 */
export declare function saveAccountSession<K extends ProviderId>(provider: K, account: string, session: SessionOf<K>, path?: string): Promise<void>;
/**
 * Delete one account's session (logout). Deleting the default moves the badge
 * to the next remaining account.
 * @param provider - the provider route.
 * @param account - the account key.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export declare function deleteAccountSession(provider: ProviderId, account: string, path?: string): Promise<void>;
/**
 * Pin the account direct (non-pool) routes serve.
 * @param provider - the provider route.
 * @param account - the account key; must exist.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export declare function setDefaultAccount(provider: ProviderId, account: string, path?: string): Promise<void>;
