/**
 * The `/subscriptions-auth` HTTP route the plugin mounts on `webServer` when
 * the host exposes `connection.requestRejection` (dsh >= 0.1.2). Drives the
 * registered route over a real node:http server, so the wire contract the
 * browser client parses — path, method, envelope, fence — is checked end to
 * end rather than through the decoded handler alone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import './keep-alive.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'router-channel-route-test-'))

// Imports after the env override so the store path resolves under the temp home.
const plugin = await import('../src/index.js')

/** One mounted route plus the server answering it. */
interface Mounted {
  url: string
  close(): Promise<void>
}

/**
 * Mount the plugin against a host that models dsh >= 0.1.2, then serve the
 * route it registered.
 * @param rejection - what the browser fence returns for every request.
 */
async function mount(rejection: 401 | 403 | undefined = undefined): Promise<Mounted> {
  let route: WebRoute | undefined
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  ctx.provide('connection', {
    requestRejection: () => rejection,
    rpc: { handle: () => () => Promise.resolve() },
  })
  ctx.provide('webServer', {
    register: (registered: WebRoute) => {
      route = registered
      return () => {}
    },
  })
  ctx.plugin(plugin, { providers: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(route !== undefined, 'the plugin registered a webServer route')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/subscriptions-auth')
  const server: Server = createServer((req, res) => { void route?.handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>(resolve => server.close(() => { resolve() })),
  }
}

/** POST one endpoint the way the browser client does. */
async function call(base: string, endpoint: string, body: unknown): Promise<Response> {
  return fetch(`${base}/subscriptions-auth/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('the mounted route answers a client-request with a server-response envelope', async () => {
  const mounted = await mount()
  try {
    const response = await call(mounted.url, 'status', {
      type: 'client-request', rpcId: 'rpc-1', method: 'status', payload: {},
    })
    assert.equal(response.status, 200)
    const envelope = await response.json() as { type: string; rpcId: string; result: { ok: boolean; value: unknown } }
    assert.equal(envelope.type, 'server-response')
    // The client rejects a mismatched id, so echoing it is part of the contract.
    assert.equal(envelope.rpcId, 'rpc-1')
    assert.equal(envelope.result.ok, true)
    assert.ok(Object.hasOwn((envelope.result.value as { providers: object }).providers, 'codex'))
  } finally {
    await mounted.close()
  }
})

test('an unknown endpoint answers a business failure, not a transport failure', async () => {
  const mounted = await mount()
  try {
    const response = await call(mounted.url, 'nope', {
      type: 'client-request', rpcId: 'rpc-2', method: 'nope', payload: {},
    })
    assert.equal(response.status, 200)
    const envelope = await response.json() as { result: { ok: boolean; error: { message: string } } }
    assert.equal(envelope.result.ok, false)
    assert.match(envelope.result.error.message, /unknown \/subscriptions-auth endpoint/)
  } finally {
    await mounted.close()
  }
})

test('a method that disagrees with the path is rejected before dispatch', async () => {
  const mounted = await mount()
  try {
    const response = await call(mounted.url, 'status', {
      type: 'client-request', rpcId: 'rpc-3', method: 'login', payload: {},
    })
    const envelope = await response.json() as { result: { ok: boolean; error: { message: string } } }
    assert.equal(envelope.result.ok, false)
    assert.match(envelope.result.error.message, /does not match endpoint/)
  } finally {
    await mounted.close()
  }
})

test('the host browser fence answers before the channel does', async () => {
  const mounted = await mount(401)
  try {
    const response = await call(mounted.url, 'status', {
      type: 'client-request', rpcId: 'rpc-4', method: 'status', payload: {},
    })
    assert.equal(response.status, 401)
    assert.equal(await response.text(), 'unauthorized')
  } finally {
    await mounted.close()
  }
})

test('non-POST requests and non-endpoint paths are not claimed', async () => {
  const mounted = await mount()
  try {
    // The prefix route also sees GETs and the bare channel path; neither names
    // an endpoint, so both answer 404 rather than reaching dispatch.
    const get = await fetch(`${mounted.url}/subscriptions-auth/status`)
    assert.equal(get.status, 404)
    const bare = await fetch(`${mounted.url}/subscriptions-auth`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(bare.status, 404)
    const encoded = await fetch(`${mounted.url}/subscriptions-auth/sta%20tus`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(encoded.status, 404)
  } finally {
    await mounted.close()
  }
})

test('a body that is not JSON is a 400, and a wrong content type a 415', async () => {
  const mounted = await mount()
  try {
    const notJson = await fetch(`${mounted.url}/subscriptions-auth/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })
    assert.equal(notJson.status, 400)
    const wrongType = await fetch(`${mounted.url}/subscriptions-auth/status`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    })
    assert.equal(wrongType.status, 415)
  } finally {
    await mounted.close()
  }
})
