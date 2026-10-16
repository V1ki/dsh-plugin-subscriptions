/** PKCE (RFC 7636) and random-token helpers for the OAuth login flows. */
/** One PKCE verifier/challenge pair; the verifier stays local until the token exchange. */
export interface PkcePair {
    /** High-entropy secret sent as `code_verifier` at the token endpoint. */
    verifier: string;
    /** S256 digest of the verifier, sent as `code_challenge` at the authorize endpoint. */
    challenge: string;
}
/**
 * Base64url-encode without padding.
 * @param buffer - raw bytes.
 * @returns the RFC 4648 §5 encoding.
 */
export declare function base64url(buffer: Buffer): string;
/**
 * Mint a fresh PKCE pair (32-byte verifier, S256 challenge).
 * @returns the pair for one authorization attempt.
 */
export declare function createPkce(): PkcePair;
/**
 * Mint a URL-safe random token (default 16 bytes) for OAuth `state`.
 * @param bytes - entropy length.
 * @returns base64url-encoded random bytes.
 */
export declare function randomToken(bytes?: number): string;
/**
 * Mint lowercase-hex random bytes (for Grok's `nonce` parameter).
 * @param bytes - entropy length; the hex string is twice as long.
 * @returns hex-encoded random bytes.
 */
export declare function randomHex(bytes?: number): string;
