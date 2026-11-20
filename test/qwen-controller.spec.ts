/**
 * Qwen login through the real controller and an injected OAuth client. All
 * OAuth HTTP replies are local fixtures; each test owns an isolated DSH_HOME.
 * Deferred replies let us exercise the race windows without timing guesses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubscriptionsAuthController } from '../src/index.js'
import { DeviceFlowManager } from '../src/auth/device-flow.js'
import { OAuthFlowManager } from '../src/auth/oauth-flow.js'
import { authFilePath, listAccounts } from '../src/auth/store.js'
import type { ProviderId, StoredSession } from '../src/auth/store.js'
import { QwenOAuthClient, QWEN_AUTH_URL } from '../src/providers/qwen.js'

const DEVICE = 'device-secret-fixture-901'
const ACCESS = 'access-secret-fixture-902'
const REFRESH = 'refresh-secret-fixture-903'
const USER_CODE = 'ABCD-1234'
const SUBJECT = 'qwen-subject-1'
const grant = {
  device_code: DEVICE,
  user_code: USER_CODE,
  verification_uri: 'https://chat.qwen.ai/authorize',
  verification_uri_complete: 'https://chat.qwen.ai/authorize',
  expires_in: 60,
  interval: 0.001,
}
const tokens = {
  access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer',
  expires_in: 3600, scope: 'model:invoke profile:read',
}
const profile = { sub: SUBJECT, name: 'Alice', email: 'alice@example.com', member_type: 'Plus' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Holds one HTTP reply, deliberately even after abort to simulate a late response. */
function endpoint() {
  const entered = deferred<RequestInit>()
  const reply = deferred<Response>()
  return { entered: entered.promise, respond: (body: unknown, status = 200) => reply.resolve(response(body, status)),
    reject: (error: Error) => reply.reject(error),
    request: (init: RequestInit) => { entered.resolve(init); return reply.promise } }
}

function fixture(count = 1) {
  const starts = Array.from({ length: count }, endpoint)
  const polls = Array.from({ length: count }, endpoint)
  const profiles = Array.from({ length: count }, endpoint)
  const revocation = endpoint()
  let startCount = 0, pollCount = 0, profileCount = 0
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === QWEN_AUTH_URL + '/device/code') {
      const next = starts[startCount++]
      assert.ok(next, 'unexpected device-code request')
      return next.request(init ?? {})
    }
    if (url === QWEN_AUTH_URL + '/token') {
      const next = polls[pollCount++]
      assert.ok(next, 'unexpected token request')
      return next.request(init ?? {})
    }
    if (url === QWEN_AUTH_URL + '/userinfo') {
      const next = profiles[profileCount++]
      assert.ok(next, 'unexpected userInfo request')
      return next.request(init ?? {})
    }
    if (url === QWEN_AUTH_URL + '/revoke') return revocation.request(init ?? {})
    throw new Error('unexpected Qwen request: ' + url)
  }) as typeof fetch
  return {
    starts, polls, profiles, revocation, client: new QwenOAuthClient(fetchFn),
    counts: () => ({ starts: startCount, polls: pollCount, profiles: profileCount }),
    releaseAll: () => {
      for (const e of starts) e.respond(grant)
      for (const e of polls) e.respond(tokens)
      for (const e of profiles) e.respond(profile)
      revocation.respond({}, 400)
    },
  }
}

function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const secret of [DEVICE, ACCESS, REFRESH]) {
    assert.ok(!serialized.includes(secret), 'public result contains a credential')
  }
}

async function inIsolatedHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'qwen-controller-dsh-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(authFilePath(), join(home, 'plugins', 'subscriptions', 'auth.json'))
    await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** Ensure a failed assertion does not leave the background login using the next test's home. */
async function withController(count: number, run: (ctx: {
  oauth: ReturnType<typeof fixture>
  controller: SubscriptionsAuthController
  changes: { provider: string; account?: string }[]
  login: () => ReturnType<SubscriptionsAuthController['login']>
}) => Promise<void>): Promise<void> {
  await inIsolatedHome(async () => {
    const oauth = fixture(count)
    const changes: { provider: string; account?: string }[] = []
    const controller = new SubscriptionsAuthController(
      new OAuthFlowManager(), new DeviceFlowManager(),
      (provider, account) => changes.push(account === undefined ? { provider } : { provider, account }),
      () => undefined, {}, () => undefined, undefined, {}, {}, undefined, undefined, oauth.client,
    )
    const pending: ReturnType<SubscriptionsAuthController['login']>[] = []
    const login = () => {
      const attempt = controller.login('qwen-subscription')
      // Attach a handler immediately: a test may inspect another stage before awaiting it.
      void attempt.catch(() => undefined)
      pending.push(attempt)
      return attempt
    }
    try {
      await run({ oauth, controller, changes, login })
    } finally {
      await controller.cancel('qwen-subscription')
      oauth.releaseAll()
      await Promise.allSettled(pending)
      await controller.settled('qwen-subscription')
    }
  })
}

const expectBusy = async (controller: SubscriptionsAuthController, expected: boolean) => {
  const status = await controller.status('qwen-subscription')
  assert.equal(status.busy, expected)
  assertNoSecrets(status)
  return status
}

test('Qwen Plus login persists its identity, reports busy in each phase, and never returns credentials', async () => {
  await withController(1, async ({ oauth, controller, changes, login }) => {
    assert.deepEqual(await expectBusy(controller, false), { busy: false, accounts: [] })
    const attempt = login()
    const startRequest = await oauth.starts[0]!.entered
    assert.ok(startRequest.signal)
    assert.deepEqual((await expectBusy(controller, true)).accounts, [])
    oauth.starts[0]!.respond(grant)
    const loginResult = await attempt
    const expectedUrl = new URL('https://chat.qwen.ai/authorize')
    expectedUrl.searchParams.set('user_code', USER_CODE)
    expectedUrl.searchParams.set('client', 'desktop')
    expectedUrl.searchParams.set('entry', 'qwen_code')
    expectedUrl.searchParams.set('paywallScene', 'desktop')
    assert.deepEqual(loginResult, { authorizeUrl: expectedUrl.toString(), userCode: USER_CODE })
    assertNoSecrets(loginResult)

    const pollRequest = await oauth.polls[0]!.entered
    assert.equal(new URLSearchParams(String(pollRequest.body)).get('device_code'), DEVICE)
    assert.deepEqual((await expectBusy(controller, true)).accounts, [])
    oauth.polls[0]!.respond(tokens)
    const infoRequest = await oauth.profiles[0]!.entered
    assert.equal(new Headers(infoRequest.headers).get('authorization'), 'Bearer ' + ACCESS)
    assert.deepEqual((await expectBusy(controller, true)).accounts, [])
    oauth.profiles[0]!.respond(profile)
    await controller.settled('qwen-subscription')

    const [stored] = await listAccounts('qwen-subscription')
    assert.ok(stored)
    assert.equal(stored.key, SUBJECT)
    assert.deepEqual(stored.session, {
      accessToken: ACCESS, refreshToken: REFRESH, expiresAt: stored.session.expiresAt,
      account: SUBJECT, plan: 'Plus',
    })
    assert.ok(stored.session.expiresAt > Date.now())
    assert.equal((await stat(authFilePath())).mode & 0o777, 0o600)
    const status = await expectBusy(controller, false)
    assert.deepEqual(status.accounts, [{ key: SUBJECT, isDefault: true, expiresAt: stored.session.expiresAt, account: SUBJECT, plan: 'Plus' }])
    assert.deepEqual(changes, [{ provider: 'qwen-subscription', account: SUBJECT }])
  })
})

test('Qwen rejects an unsupported subscription plan without storing tokens', async () => {
  await withController(1, async ({ oauth, controller, changes, login }) => {
    const attempt = login()
    await oauth.starts[0]!.entered; oauth.starts[0]!.respond(grant)
    assertNoSecrets(await attempt)
    await oauth.polls[0]!.entered; oauth.polls[0]!.respond(tokens)
    await oauth.profiles[0]!.entered; oauth.profiles[0]!.respond({ ...profile, member_type: 'Free' })
    await controller.settled('qwen-subscription')
    const status = await expectBusy(controller, false)
    assert.deepEqual(status.accounts, [])
    assert.match(status.detail ?? '', /Plus or Pro/)
    assert.deepEqual(await listAccounts('qwen-subscription'), [])
    assert.deepEqual(changes, [])
  })
})

test('cancelling Qwen during userInfo discards even an abort-ignoring late response', async () => {
  await withController(1, async ({ oauth, controller, changes, login }) => {
    const attempt = login()
    await oauth.starts[0]!.entered; oauth.starts[0]!.respond(grant)
    assertNoSecrets(await attempt)
    await oauth.polls[0]!.entered; oauth.polls[0]!.respond(tokens)
    const request = await oauth.profiles[0]!.entered
    assert.ok(request.signal)
    assert.equal(request.signal.aborted, false)
    await expectBusy(controller, true)
    await controller.cancel('qwen-subscription')
    assert.equal(request.signal.aborted, true, 'cancel propagates to the active profile request')
    // The HTTP mock intentionally ignores abort. A late successful profile must not be persisted.
    oauth.profiles[0]!.respond(profile)
    await controller.settled('qwen-subscription')
    const status = await expectBusy(controller, false)
    assert.deepEqual(status.accounts, [])
    assert.equal(status.detail, undefined, 'cancellation is not reported as a login failure')
    assert.deepEqual(await listAccounts('qwen-subscription'), [])
    assert.deepEqual(changes, [])
  })
})

test('Qwen rejects a concurrent start without superseding the in-flight login', async () => {
  await withController(1, async ({ oauth, controller, changes, login }) => {
    const first = login()
    await oauth.starts[0]!.entered
    await expectBusy(controller, true)
    await assert.rejects(login(), /already in progress/)
    assert.deepEqual(oauth.counts(), { starts: 1, polls: 0, profiles: 0 })
    oauth.starts[0]!.respond(grant)
    assertNoSecrets(await first)
    await oauth.polls[0]!.entered; oauth.polls[0]!.respond(tokens)
    await oauth.profiles[0]!.entered; oauth.profiles[0]!.respond(profile)
    await controller.settled('qwen-subscription')
    const status = await expectBusy(controller, false)
    assert.equal(status.accounts[0]?.key, SUBJECT)
    assert.deepEqual(changes, [{ provider: 'qwen-subscription', account: SUBJECT }])
  })
})

test('cancel while requesting a Qwen device code prevents late polling and permits a retry', async () => {
  await withController(2, async ({ oauth, controller, changes, login }) => {
    const first = login()
    const request = await oauth.starts[0]!.entered
    assert.ok(request.signal)
    await expectBusy(controller, true)
    await controller.cancel('qwen-subscription')
    assert.equal(request.signal.aborted, true)
    // Even if the cancelled HTTP request still completes, it must not begin polling.
    oauth.starts[0]!.respond(grant)
    await assert.rejects(first, /login cancelled/)
    assert.deepEqual(oauth.counts(), { starts: 1, polls: 0, profiles: 0 })
    assert.deepEqual((await expectBusy(controller, false)).accounts, [])
    assert.deepEqual(await listAccounts('qwen-subscription'), [])

    const second = login()
    await oauth.starts[1]!.entered
    await expectBusy(controller, true)
    oauth.starts[1]!.respond(grant)
    assertNoSecrets(await second)
    await oauth.polls[0]!.entered; oauth.polls[0]!.respond(tokens)
    await oauth.profiles[0]!.entered; oauth.profiles[0]!.respond(profile)
    await controller.settled('qwen-subscription')
    assert.equal((await expectBusy(controller, false)).accounts[0]?.key, SUBJECT)
    assert.deepEqual(changes, [{ provider: 'qwen-subscription', account: SUBJECT }])
  })
})

test('Qwen refuses cancellation after the real store write is enqueued and commits the login', async () => {
  await withController(1, async ({ oauth, controller, changes, login }) => {
    // TypeScript's private method is still an ordinary JS property. This
    // instance-only wrapper calls the real method first, so the write is
    // actually enqueued; holding its returned promise does not fake the store.
    const probe = controller as unknown as { persist: (provider: ProviderId, session: StoredSession) => Promise<void> }
    const realPersist = probe.persist.bind(controller)
    const entered = deferred<void>()
    const release = deferred<void>()
    probe.persist = async (provider, session) => {
      const write = realPersist(provider, session)
      entered.resolve()
      await release.promise
      await write
    }
    try {
      const attempt = login()
      await oauth.starts[0]!.entered; oauth.starts[0]!.respond(grant)
      assertNoSecrets(await attempt)
      await oauth.polls[0]!.entered; oauth.polls[0]!.respond(tokens)
      await oauth.profiles[0]!.entered; oauth.profiles[0]!.respond(profile)
      await entered.promise
      await expectBusy(controller, true)
      // Once enqueued, cancellation must not report success: it cannot roll
      // back the write, and the account will become logged in after it settles.
      await assert.rejects(controller.cancel('qwen-subscription'), /login is already being saved.*cannot (?:be cancell?ed|cancel)/i)
      release.resolve()
      await controller.settled('qwen-subscription')
      assert.equal((await listAccounts('qwen-subscription'))[0]?.key, SUBJECT)
      assert.equal((await expectBusy(controller, false)).accounts[0]?.key, SUBJECT)
      assert.deepEqual(changes, [{ provider: 'qwen-subscription', account: SUBJECT }])
    } finally {
      release.resolve()
    }
  })
})

test('Qwen logout removes local credentials before a failed remote revocation and reports a safe error', async () => {
  await withController(1, async ({ oauth, controller, changes, login }) => {
    const attempt = login()
    await oauth.starts[0]!.entered; oauth.starts[0]!.respond(grant)
    assertNoSecrets(await attempt)
    await oauth.polls[0]!.entered; oauth.polls[0]!.respond(tokens)
    await oauth.profiles[0]!.entered; oauth.profiles[0]!.respond(profile)
    await controller.settled('qwen-subscription')
    assert.equal((await listAccounts('qwen-subscription'))[0]?.key, SUBJECT)

    const logout = controller.logout('qwen-subscription', SUBJECT)
    // Install the rejection handler before releasing the failing HTTP request.
    const rejected = assert.rejects(logout, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /signed out locally.*remote token revocation failed/i)
      assertNoSecrets({ name: error.name, message: error.message, cause: error.cause })
      return true
    })
    const request = await oauth.revocation.entered
    const form = new URLSearchParams(String(request.body))
    assert.equal(form.get('token'), REFRESH)
    assert.equal(form.get('token_type_hint'), 'refresh_token')
    assert.deepEqual(await listAccounts('qwen-subscription'), [], 'local deletion precedes remote response')
    assert.deepEqual((await expectBusy(controller, false)).accounts, [])
    oauth.revocation.reject(new Error('network failure while sending ' + REFRESH))
    await rejected
    assert.deepEqual(await listAccounts('qwen-subscription'), [])
    assert.deepEqual((await expectBusy(controller, false)).accounts, [])
    assert.deepEqual(changes, [{ provider: 'qwen-subscription', account: SUBJECT }, { provider: 'qwen-subscription', account: SUBJECT }])
  })
})

test('Qwen polling errors never expose an echoed device code in public status', async () => {
  await withController(1, async ({ oauth, controller, login }) => {
    const attempt = login()
    await oauth.starts[0]!.entered; oauth.starts[0]!.respond(grant)
    assertNoSecrets(await attempt)
    await oauth.polls[0]!.entered
    oauth.polls[0]!.respond({ error: 'invalid_device_code: ' + DEVICE }, 400)
    await controller.settled('qwen-subscription')
    const status = await controller.status('qwen-subscription')
    assert.equal(status.busy, false)
    assert.ok(status.detail)
    assertNoSecrets(status)
    assert.deepEqual(status.accounts, [])
  })
})

test('Qwen device-code request errors do not expose credentials to the caller', async () => {
  await withController(1, async ({ oauth, controller, login }) => {
    const attempt = login()
    await oauth.starts[0]!.entered
    oauth.starts[0]!.respond({ error: 'bad request: ' + DEVICE + ' ' + ACCESS + ' ' + REFRESH }, 400)
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof Error)
      assertNoSecrets({ name: error.name, message: error.message, cause: error.cause })
      return true
    })
    assert.deepEqual((await expectBusy(controller, false)).accounts, [])
    assert.deepEqual(oauth.counts(), { starts: 1, polls: 0, profiles: 0 })
  })
})

test('Qwen userInfo errors never expose an echoed access token in public status', async () => {
  await withController(1, async ({ oauth, controller, login }) => {
    const attempt = login()
    await oauth.starts[0]!.entered; oauth.starts[0]!.respond(grant)
    assertNoSecrets(await attempt)
    await oauth.polls[0]!.entered; oauth.polls[0]!.respond(tokens)
    await oauth.profiles[0]!.entered
    oauth.profiles[0]!.respond({ error: 'invalid_token: ' + ACCESS }, 400)
    await controller.settled('qwen-subscription')
    const status = await controller.status('qwen-subscription')
    assert.equal(status.busy, false)
    assert.ok(status.detail)
    assertNoSecrets(status)
    assert.deepEqual(status.accounts, [])
  })
})
