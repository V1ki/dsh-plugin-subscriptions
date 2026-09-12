/**
 * Unit tests for the `/api/subscriptions-auth` Fetch route codec: the
 * client-request / server-response envelope `rpc.call` speaks, the inner
 * `{ endpoint, payload }` unwrap, and the rejections the host's own channel
 * bridge applies (non-JSON content type, unparsable body, bad envelope).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RpcResult } from '../src/compat.js'
import { SUBSCRIPTIONS_AUTH_ROUTE, subscriptionsAuthFetch } from '../src/auth/rpc-fetch.js'

type Seen = { endpoint: string; payload: unknown; signal: AbortSignal }

function route(result: RpcResult<unknown> = { ok: true, value: 'v' }) {
  const seen: Seen[] = []
  const fetch = subscriptionsAuthFetch(async (endpoint, payload, signal) => {
    seen.push({ endpoint, payload, signal })
    return result
  })
  return { fetch, seen }
}

function post(body: unknown, contentType = 'application/json; charset=utf-8', signal?: AbortSignal): Request {
  return new Request(`http://dsh.internal${SUBSCRIPTIONS_AUTH_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...signal === undefined ? {} : { signal },
  })
}

const envelope = (payload: unknown, method = 'subscriptions-auth') =>
  ({ type: 'client-request', rpcId: 'r1', method, payload })

test('route path sits below the shared /api channel', () => {
  assert.equal(SUBSCRIPTIONS_AUTH_ROUTE, '/api/subscriptions-auth')
})

test('unwraps the endpoint and answers with the server-response envelope', async () => {
  const { fetch, seen } = route({ ok: true, value: { providers: {} } })
  const controller = new AbortController()
  const response = await fetch(post(envelope({ endpoint: 'status', payload: { a: 1 } }), undefined, controller.signal))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    type: 'server-response', rpcId: 'r1', result: { ok: true, value: { providers: {} } },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].endpoint, 'status')
  assert.deepEqual(seen[0].payload, { a: 1 })
  controller.abort()
  assert.equal(seen[0].signal.aborted, true, 'the request signal reaches the handler')
})

test('business failures pass through unchanged', async () => {
  const failure: RpcResult<unknown> = { ok: false, error: { code: 'internal', message: 'boom', details: {} } }
  const { fetch } = route(failure)
  const body = await (await fetch(post(envelope({ endpoint: 'usage', payload: {} })))).json()
  assert.deepEqual(body, { type: 'server-response', rpcId: 'r1', result: failure })
})

test('transport-level rejections mirror the host channel bridge', async () => {
  const { fetch, seen } = route()
  assert.equal((await fetch(post(envelope({ endpoint: 'status' }), 'text/plain'))).status, 415)
  assert.equal((await fetch(post('{not json'))).status, 400)
  assert.equal(seen.length, 0)
})

test('malformed envelopes and inner payloads become bad-request results', async () => {
  const { fetch, seen } = route()
  const cases = [
    [{ type: 'client-request', method: 'subscriptions-auth', payload: {} }, 'invalid-request', /client-request/],
    [envelope({ endpoint: 'status' }, 'other'), 'r1', /does not match/],
    [envelope('nope'), 'r1', /endpoint/],
    [envelope({ endpoint: '' }), 'r1', /endpoint/],
    [envelope({ endpoint: 7 }), 'r1', /endpoint/],
  ] as const
  for (const [body, rpcId, pattern] of cases) {
    const response = await fetch(post(body))
    assert.equal(response.status, 200, JSON.stringify(body))
    const json = await response.json() as { rpcId: string; result: RpcResult<unknown> }
    assert.equal(json.rpcId, rpcId)
    assert.equal(json.result.ok, false)
    if (!json.result.ok) {
      assert.equal(json.result.error.code, 'bad-request')
      assert.match(json.result.error.message, pattern)
    }
  }
  assert.equal(seen.length, 0)
})
