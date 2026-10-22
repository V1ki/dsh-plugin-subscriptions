import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { createSpeedLoader, createSpeedSetter } from '../src/client/SpeedSelect.js'

test('Speed selector resolves a child default for the current model and rechecks model switches', async () => {
  const requests: unknown[] = []
  const connection = { rpc: { call: async (_channel: string, _endpoint: string, payload: { model?: string }) => {
    requests.push(payload)
    return { ok: true, value: { tier: payload.model === 'fast-model' ? 'fast' : 'standard', fastModels: ['fast-model'] } }
  } } } as unknown as ConnectionHandle
  let current = { provider: 'codex', model: 'fast-model' }
  const load = createSpeedLoader(connection, () => ({ directoryFor: id => {
    assert.equal(id, 'child')
    return { load: async () => ({ current }) }
  } }), 'child')
  assert.deepEqual(await load(), { visible: true, tier: 'fast' })
  current = { provider: 'codex', model: 'plain-model' }
  assert.deepEqual(await load(), { visible: false, tier: 'standard' })
  current = { provider: 'claude', model: 'fast-model' }
  assert.deepEqual(await load(), { visible: false, tier: 'standard' })
  assert.deepEqual(requests, [
    { sessionId: 'child', model: 'fast-model' },
    { sessionId: 'child', model: 'plain-model' },
    { sessionId: 'child' },
  ])
  assert.deepEqual(await createSpeedLoader(connection, () => undefined, 'unknown')(), { visible: false, tier: 'standard' })
})

test('Speed setter captures the selected Codex model for durable per-model choices', async () => {
  const requests: unknown[] = []
  const connection = { rpc: { call: async (_channel: string, _endpoint: string, payload: unknown) => {
    requests.push(payload)
    return { ok: true, value: { ok: true } }
  } } } as unknown as ConnectionHandle
  let current = { provider: 'codex', model: 'first' }
  const set = createSpeedSetter(connection, 'session', () => ({ directoryFor: () => ({ load: async () => ({ current }) }) }))
  assert.equal(await set('fast'), true)
  current = { provider: 'codex', model: 'second' }
  assert.equal(await set('standard'), true)
  current = { provider: 'claude', model: 'first' }
  assert.equal(await set('fast'), false)
  assert.deepEqual(requests, [
    { sessionId: 'session', tier: 'fast', model: 'first' },
    { sessionId: 'session', tier: 'standard', model: 'second' },
  ])
})
