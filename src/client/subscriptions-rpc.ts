import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'

const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Business error returned by the `/subscriptions-auth` channel (error branch message). */
export class SubscriptionsAuthError extends Error {}

/**
 * Point the handle's `/subscriptions-auth` calls at the transport the node half
 * registered. Hosts since dsh 0.1.2-alpha.1 carry exact `/api` Fetch routes and
 * the node half serves the endpoints there (0.1.5 can no longer mount the
 * legacy channel), so each call becomes `rpc.call('/api', 'subscriptions-auth',
 * { endpoint, payload })`. rc.2 has no Fetch routes; it is recognised by its
 * `.api` face, which 0.1.2-alpha.1 removed, and keeps the legacy channel.
 * Keying on the frozen rc.2 face rather than a newer member keeps future hosts
 * on the Fetch route.
 * @param connection - the client connection handle.
 * @returns the RPC face this plugin consumes, with `/subscriptions-auth` calls routed.
 */
export function routeSubscriptionsAuth(connection: Pick<ConnectionHandle, 'rpc'>): Pick<ConnectionHandle, 'rpc'> {
  const rpc = connection.rpc
  if ('api' in connection) return { rpc }
  return {
    rpc: {
      ...rpc,
      call: (channel, endpoint, payload, signal) => channel === SUBSCRIPTIONS_AUTH_CHANNEL
        ? rpc.call('/api', 'subscriptions-auth', { endpoint, payload }, signal)
        : rpc.call(channel, endpoint, payload, signal),
    },
  }
}

/**
 * Call one `/subscriptions-auth` endpoint and unwrap the business result.
 * Shared by the settings section and the composer Speed toggle.
 * @param rpc - Connection RPC caller.
 * @param endpoint - channel-relative endpoint.
 * @param payload - channel-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
export async function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T> {
  let result: RpcResult<unknown>
  try {
    result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, endpoint, payload)
  } catch (error) {
    // The transport rejected rather than answering; surface the same way.
    throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) throw new SubscriptionsAuthError(result.error.message)
  return result.value as T
}
