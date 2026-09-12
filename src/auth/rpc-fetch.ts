/**
 * The `/subscriptions-auth` endpoints served as one exact `/api` Fetch route.
 *
 * dsh 0.1.5 broke `connection.rpc.handle` for every consumer: the channel is
 * mounted through the connection plugin's own `webServer`, which that plugin
 * no longer injects, so registration throws and the Settings page's POSTs
 * fall through to the SPA (405). An exact Fetch route only enters the
 * connection's route map, dispatched under its already-mounted `/api` prefix,
 * and the registry exists on every host since dsh 0.1.2-alpha.1.
 *
 * The browser keeps calling through `rpc.call('/api', 'subscriptions-auth',
 * { endpoint, payload })`, which posts the client-request envelope to this
 * path; the codec answers with the same server-response envelope the host's
 * channel bridge writes, so every caller sees the unchanged result shape.
 * One route with the endpoint in the payload keeps a single registration
 * instead of a path list that must track every endpoint.
 */

import type { RpcResult } from '../compat.js'

/** Channel-relative endpoint of the route below the shared `/api` channel. */
export const SUBSCRIPTIONS_AUTH_ROUTE_ENDPOINT = 'subscriptions-auth'

/** Absolute path of the exact Fetch route. */
export const SUBSCRIPTIONS_AUTH_ROUTE = `/api/${SUBSCRIPTIONS_AUTH_ROUTE_ENDPOINT}`

/** Decoded endpoint handler shared with the legacy channel; never throws. */
export type SubscriptionsAuthHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function respond(rpcId: string, result: RpcResult<unknown>): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * Build the Fetch implementation of the `/api/subscriptions-auth` route.
 * @param handler - the endpoint dispatcher the legacy channel also uses.
 * @returns a Fetch handler for authenticated POSTs the host has already let through its trust fence.
 */
export function subscriptionsAuthFetch(handler: SubscriptionsAuthHandler): (request: Request) => Promise<Response> {
  return async (request) => {
    // Same content-type and body rejections as the host's channel bridge.
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 })
    }
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }

    const message = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    if (message.type !== 'client-request' || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
      return respond(typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request',
        badRequest('invalid client-request message'))
    }
    if (message.method !== SUBSCRIPTIONS_AUTH_ROUTE_ENDPOINT) {
      return respond(message.rpcId, badRequest(
        `method ${JSON.stringify(message.method)} does not match endpoint "${SUBSCRIPTIONS_AUTH_ROUTE_ENDPOINT}"`))
    }
    const inner = message.payload
    const endpoint = typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>).endpoint : undefined
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return respond(message.rpcId, badRequest('payload.endpoint must be a non-empty string'))
    }
    return respond(message.rpcId, await handler(endpoint, (inner as Record<string, unknown>).payload, request.signal))
  }
}
