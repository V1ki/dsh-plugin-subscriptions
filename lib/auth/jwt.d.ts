/** Minimal JWT payload decoding for claims extraction (no signature verification). */
/**
 * Decode a JWT payload without verifying the signature. Used only to read
 * account claims from `id_token`s issued over the provider's own TLS channel
 * during a code exchange we initiated — never to authorize anything.
 * @param token - the compact JWT string.
 * @returns the parsed payload object, or `undefined` when the token is not a
 *   well-formed JWT with a JSON object payload.
 */
export declare function decodeJwtPayload(token: string): Record<string, unknown> | undefined;
