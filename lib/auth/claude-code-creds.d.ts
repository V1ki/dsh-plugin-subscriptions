import type { ClaudeSession } from './store.js';
/** Read the current Claude Code session from its source of truth: macOS Keychain, falling back to the credentials file. */
export declare function readClaudeCodeCredentials(): ClaudeSession | undefined;
/**
 * Write a refreshed session back to Claude Code's own credential store, so
 * the `claude` CLI and any other consumer of the same account see the token
 * we just rotated. A stale-blob mismatch (something else rotated it first)
 * is a no-op — the caller already has that other rotation via readClaudeCodeCredentials.
 * @param next - the freshly refreshed session to persist.
 * @param expectedPriorAccessToken - the access token this refresh started from.
 * @returns whether the write-back succeeded.
 */
export declare function writeBackClaudeCodeCredentials(next: ClaudeSession, expectedPriorAccessToken: string): boolean;
/**
 * Refresh a Claude session, first checking whether Claude Code's own store
 * already holds a fresher token (rotated by the `claude` CLI or another
 * consumer) before hitting the OAuth endpoint ourselves — and writing our own
 * refresh back to that store so every consumer of the account stays synced.
 * @param session - the session TokenManager wants refreshed.
 * @param doRefresh - the actual OAuth refresh-token grant (network call).
 * @returns the freshest available session.
 */
export declare function refreshClaudeSynced(session: ClaudeSession, doRefresh: (session: ClaudeSession) => Promise<ClaudeSession>): Promise<ClaudeSession>;
