/**
 * The GitHub device-authorization flow engine: device-code request shape,
 * token polling (authorization_pending / slow_down / denial / expiry), busy
 * tracking, and cancellation. All fetches are injected; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { DeviceFlowManager } from '../src/auth/device-flow.js'
import type { DeviceFlowSpec } from '../src/auth/device-flow.js'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'

/**
 * A fetch implementation replaying queued responses per URL; records request
 * bodies. An `Error` entry rejects instead, simulating a transport failure that
 * arrives without any response.
 */
function fakeFetch(script: Record<string, unknown[]>): {
  fetchFn: typeof fetch
  bodies: (url: string) => string[]
} {
  const queues = new Map(Object.entries(script).map(([url, responses]) => [url, [...responses]]))
  const bodies = new Map<string, string[]>()
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const queue = queues.get(url)
    if (queue === undefined || queue.length === 0) {
      return Promise.reject(new Error(`unexpected fetch to ${url}`))
    }
    const list = bodies.get(url) ?? []
    list.push(typeof init?.body === 'string' ? init.body : '')
    bodies.set(url, list)
    const payload = queue.shift()
    if (payload instanceof Error) return Promise.reject(payload)
    if (payload instanceof Response) return Promise.resolve(payload)
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  }) as typeof fetch
  return { fetchFn, bodies: url => bodies.get(url) ?? [] }
}

function spec(fetchFn: typeof fetch): DeviceFlowSpec {
  return {
    clientId: 'client-1',
    scope: 'read:user',
    deviceCodeUrl: DEVICE_CODE_URL,
    tokenUrl: TOKEN_URL,
    fetchFn,
  }
}

const DEVICE_CODE = {
  device_code: 'dc-1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  // Fractional intervals keep the tests fast; GitHub sends integers ≥ 5.
  interval: 0.01,
  expires_in: 60,
}

test('device flow: pending polls resolve to the access token', async () => {
  const { fetchFn, bodies } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: 'gh-token' },
    ],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  assert.equal(attempt.userCode, 'ABCD-1234')
  assert.equal(attempt.verificationUrl, 'https://github.com/login/device')
  assert.equal(manager.isBusy('copilot'), true)

  // The device-code request carries the client id and scope, form-encoded.
  const [deviceBody] = bodies(DEVICE_CODE_URL)
  assert.equal(new URLSearchParams(deviceBody).get('client_id'), 'client-1')
  assert.equal(new URLSearchParams(deviceBody).get('scope'), 'read:user')

  assert.equal(await attempt.waitToken(), 'gh-token')
  assert.equal(manager.isBusy('copilot'), false)

  // Every poll presents the device code with the device-code grant type.
  for (const body of bodies(TOKEN_URL)) {
    const params = new URLSearchParams(body)
    assert.equal(params.get('device_code'), 'dc-1')
    assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  }
})

test('device flow: slow_down keeps polling and still resolves', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [
      { error: 'slow_down' },
      { access_token: 'gh-token' },
    ],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  assert.equal(await attempt.waitToken(), 'gh-token')
})

test('device flow: access_denied rejects the login', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [{ error: 'access_denied' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  await assert.rejects(attempt.waitToken(), /declined/)
  assert.equal(manager.isBusy('copilot'), false)
})

test('device flow: an expired device code rejects the login', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [{ error: 'expired_token' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  await assert.rejects(attempt.waitToken(), /expired/)
})

test('device flow: cancel rejects waitToken and frees the provider slot', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE, DEVICE_CODE],
    [TOKEN_URL]: [{ error: 'authorization_pending' }, { access_token: 'gh-token' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  attempt.cancel()
  await assert.rejects(attempt.waitToken(), /cancelled/)
  assert.equal(manager.isBusy('copilot'), false)
  assert.equal(manager.pending('copilot'), undefined)

  // A fresh attempt may start right away for the same provider.
  const again = await manager.start('copilot', spec(fetchFn))
  assert.equal(again.userCode, 'ABCD-1234')
  again.cancel()
})

test('device flow: a second concurrent attempt for one provider is refused', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE, DEVICE_CODE],
    [TOKEN_URL]: [{ error: 'authorization_pending' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))
  await assert.rejects(manager.start('copilot', spec(fetchFn)), /already in progress/)
  attempt.cancel()
})

test('device flow: a malformed device-code response fails the start', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [{ device_code: 'dc-1' }],
  })
  const manager = new DeviceFlowManager()
  await assert.rejects(manager.start('copilot', spec(fetchFn)), /missing/)
  assert.equal(manager.isBusy('copilot'), false)
})

test('device flow: a transport failure before the device code is retried', async () => {
  const { fetchFn, bodies } = fakeFetch({
    [DEVICE_CODE_URL]: [new Error('read ECONNRESET'), DEVICE_CODE],
    [TOKEN_URL]: [{ access_token: 'gh-token' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))

  // The dropped request is re-sent; the second one mints the code.
  assert.equal(bodies(DEVICE_CODE_URL).length, 2)
  assert.equal(attempt.userCode, 'ABCD-1234')
  assert.equal(await attempt.waitToken(), 'gh-token')
})

test('device flow: an HTTP error response is not retried', async () => {
  const { fetchFn, bodies } = fakeFetch({
    [DEVICE_CODE_URL]: [new Response('nope', { status: 403 }), DEVICE_CODE],
  })
  const manager = new DeviceFlowManager()

  await assert.rejects(manager.start('copilot', spec(fetchFn)), /HTTP 403/)
  // A response, even a failing one, is an answer: retrying would mint an orphan code.
  assert.equal(bodies(DEVICE_CODE_URL).length, 1)
})

test('device flow: device-code retries are bounded', async () => {
  const reset = new Error('read ECONNRESET')
  const { fetchFn, bodies } = fakeFetch({
    [DEVICE_CODE_URL]: [reset, new Error('read ECONNRESET'), new Error('read ECONNRESET'), new Error('read ECONNRESET')],
  })
  const manager = new DeviceFlowManager()

  await assert.rejects(manager.start('copilot', spec(fetchFn)), /ECONNRESET/)
  assert.equal(bodies(DEVICE_CODE_URL).length, 3)
  assert.equal(manager.isBusy('copilot'), false)
})

test('device flow: a transport failure while polling does not end the login', async () => {
  const { fetchFn } = fakeFetch({
    [DEVICE_CODE_URL]: [DEVICE_CODE],
    [TOKEN_URL]: [new Error('read ECONNRESET'), { error: 'authorization_pending' }, { access_token: 'gh-token' }],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('copilot', spec(fetchFn))

  // A dropped poll is not an answer from GitHub, so the login keeps polling.
  assert.equal(await attempt.waitToken(), 'gh-token')
})

