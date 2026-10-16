import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
/** Business error returned by a `subscriptions-auth` endpoint (error branch message). */
export declare class SubscriptionsAuthError extends Error {
}
/**
 * Call one `subscriptions-auth` endpoint and unwrap the business result.
 * Shared by the settings section, the composer Speed toggle, the usage
 * badge, and the image/video toolviews.
 * @param rpc - Connection RPC caller.
 * @param endpoint - endpoint name (`status`, `usage`, `image`, ...).
 * @param payload - endpoint-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
export declare function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T>;
