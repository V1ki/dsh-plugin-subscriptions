import { publishUsage, failUsage, retainUsageAccounts } from './usage-cache.js'
import type { ProviderUsage, ProviderStatus } from './SubscriptionsSection.js'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * The node half mounts every endpoint as an exact POST route on the shared
 * `/api` channel (`/api/subscriptions-auth.<endpoint>`), so the browser
 * reaches it through the `/api` channel with a prefixed endpoint name.
 * A dedicated channel is no longer used: since dsh 0.1.5 `rpc.handle`
 * cannot register one from a plugin (see `src/auth/rpc.ts`).
 */
const SUBSCRIPTIONS_AUTH_CHANNEL = '/api'
const SUBSCRIPTIONS_AUTH_PREFIX = 'subscriptions-auth.'

/** Business error returned by a `subscriptions-auth` endpoint (error branch message). */
export class SubscriptionsAuthError extends Error {}

/**
 * Call one `subscriptions-auth` endpoint and unwrap the business result.
 * Shared by the settings section, the composer Speed toggle, the usage
 * badge, and the image/video toolviews.
 * @param rpc - Connection RPC caller.
 * @param endpoint - endpoint name (`status`, `usage`, `image`, ...).
 * @param payload - endpoint-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
export async function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T> {
  const request = payload as { provider?: string; account?: string } | undefined
  const usageKey = endpoint === 'usage' && request?.provider && request.account ? `${request.provider}:${request.account}` : undefined
  let result: RpcResult<unknown>
  try {
    result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, `${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint}`, payload)
  } catch (error) {
    if (usageKey) failUsage(rpc, usageKey)
    // The transport rejected rather than answering; surface the same way.
    throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) {
    if (usageKey) failUsage(rpc, usageKey)
    throw new SubscriptionsAuthError(result.error.message)
  }
  let value = result.value
  if (usageKey) {
    // The server may return cached usage even for force=true. Keep receipt
    // time separate; never manufacture fetchedAt or reset server freshness.
    value = { ...value as ProviderUsage, receivedAt: Date.now() }
    publishUsage(rpc, usageKey, value as ProviderUsage)
  }
  if (endpoint === 'status') {
    const status = result.value as { providers: Record<string, ProviderStatus> }
    retainUsageAccounts(rpc, new Set(Object.entries(status.providers).flatMap(([provider, state]) =>
      state.accounts.map(account => `${provider}:${account.key}`))))
  }
  return value as T
}
