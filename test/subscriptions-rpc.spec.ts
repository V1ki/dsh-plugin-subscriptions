/**
 * Unit tests for the browser-side transport choice: on hosts with exact Fetch
 * routes (dsh 0.1.2-alpha.1+, recognised by the absent rc.2 `.api` face) the
 * `/subscriptions-auth` calls ride `/api/subscriptions-auth`; rc.2 keeps the
 * legacy channel; other channels are never rewritten.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { routeSubscriptionsAuth } from '../src/client/subscriptions-rpc.js'

type Call = [channel: string, endpoint: string, payload: unknown, signal: AbortSignal | undefined]

function fakeConnection(extra: object = {}) {
  const calls: Call[] = []
  const rpc = {
    call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
      calls.push([channel, endpoint, payload, signal])
      return Promise.resolve({ ok: true as const, value: 'v' })
    },
  }
  const connection = { rpc, isLoopback: true, ...extra } as unknown as ConnectionHandle
  return { connection, calls }
}

test('fetch-route hosts: subscriptions-auth calls ride the /api route with the endpoint in the payload', async () => {
  const { connection, calls } = fakeConnection({ generation: {} })
  const routed = routeSubscriptionsAuth(connection)
  const signal = new AbortController().signal
  assert.deepEqual(await routed.rpc.call('/subscriptions-auth', 'usage', { provider: 'codex' }, signal), { ok: true, value: 'v' })
  assert.deepEqual(calls, [['/api', 'subscriptions-auth', { endpoint: 'usage', payload: { provider: 'codex' } }, signal]])
})

test('fetch-route hosts: other channels pass through untouched', async () => {
  const { connection, calls } = fakeConnection()
  await routeSubscriptionsAuth(connection).rpc.call('/api', 'goals/create', { x: 1 })
  assert.deepEqual(calls, [['/api', 'goals/create', { x: 1 }, undefined]])
})

test('rc.2 hosts (legacy .api face): calls keep the legacy channel', async () => {
  const { connection, calls } = fakeConnection({ api: {} })
  await routeSubscriptionsAuth(connection).rpc.call('/subscriptions-auth', 'status', {})
  assert.deepEqual(calls, [['/subscriptions-auth', 'status', {}, undefined]])
})
