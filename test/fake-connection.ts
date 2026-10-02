/**
 * Fake host `connection` service for the RPC specs. The node half mounts its
 * endpoints as exact POST Fetch routes under `/api`
 * (`/api/subscriptions-auth.<endpoint>`); this fake records those routes and
 * exposes a ConnectionRpcHandler-shaped caller that drives them the way the
 * browser does — `client-request` envelope in, `server-response` envelope
 * out — so the specs keep asserting on plain RpcResult values.
 */

import type { SubscriptionsRpcHandler as ConnectionRpcHandler } from '../src/auth/rpc.js'
import type { RpcResult } from '../src/compat.js'

interface FakeRoute {
  path: string
  methods: readonly string[]
  fetch: (request: Request) => Promise<Response>
}

export interface FakeConnection {
  /** Value to `ctx.provide('connection', ...)`. */
  connection: { fetch: { register: (route: FakeRoute) => () => Promise<void> } }
  /** Whether the plugin registered at least one `subscriptions-auth` route. */
  registered: () => boolean
  /** Call one endpoint through its registered route and unwrap the RPC result. */
  handler: ConnectionRpcHandler
}

/** Build a fresh fake connection; one per mounted plugin. */
export function createFakeConnection(): FakeConnection {
  const routes = new Map<string, FakeRoute>()
  const connection = {
    fetch: {
      register: (route: FakeRoute) => {
        if (routes.has(route.path)) throw new Error(`duplicate fake route ${route.path}`)
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
  }
  const handler: ConnectionRpcHandler = async (endpoint, payload, signal) => {
    const method = `subscriptions-auth.${endpoint}`
    const path = `/api/${method}`
    const route = routes.get(path)
    if (route === undefined) throw new Error(`no route registered for ${path}`)
    if (!route.methods.includes('POST')) throw new Error(`${path} does not accept POST`)
    const request = new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload }),
      signal,
    })
    const response = await route.fetch(request)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    const body = await response.json() as { type: string; rpcId: string; result: RpcResult<unknown> }
    if (body.type !== 'server-response' || body.rpcId !== 'rpc-1') throw new Error('invalid server-response envelope')
    return body.result
  }
  return {
    connection,
    registered: () => [...routes.keys()].some(path => path.startsWith('/api/subscriptions-auth.')),
    handler,
  }
}
