/**
 * 国产订阅登录：Kimi Code 设备码、Qwen Code 设备码、GLM Coding Plan（ZCode
 * 服务器中转轮询 + 套餐 Key 铸造）。全部使用注入的 fetch，不访问网络。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.js'
import './keep-alive.js'
import { DeviceFlowManager } from '../src/auth/device-flow.js'
import {
  completeKimiLogin,
  isKimiPermanentRefreshError,
  KIMI_API_BASE,
  kimiDeviceFlow,
  refreshKimi,
} from '../src/auth/kimi.js'
import {
  parseQwenApiKey,
  QWEN_STANDARD_BASE,
  QWEN_TOKEN_PLAN_BASE,
  QWEN_USER_AGENT,
  qwenSessionFromKey,
  refreshQwen,
} from '../src/auth/qwen.js'
import { isGlmPermanentRefreshError, mintKey, refreshGlm, startGlmLogin } from '../src/auth/zcode.js'
import { accountKeyOf } from '../src/auth/store.js'
import type { GlmSession, KimiSession, QwenSession } from '../src/auth/store.js'

/** A fetch stub replaying one response queue per URL and recording calls. */
function stubFetch(script: Record<string, unknown[]>): {
  fetchFn: typeof fetch
  calls: { url: string; init?: RequestInit }[]
} {
  const queues = new Map(Object.entries(script).map(([url, responses]) => [url, [...responses]]))
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(init === undefined ? { url } : { url, init })
    const queue = queues.get(url)
    if (queue === undefined || queue.length === 0) {
      return Promise.reject(new Error(`unexpected fetch to ${url}`))
    }
    const payload = queue.shift()
    if (payload instanceof Response) return Promise.resolve(payload)
    const record = payload as { status?: number; body?: unknown }
    return Promise.resolve(new Response(JSON.stringify(record.body ?? {}), { status: record.status ?? 200 }))
  }) as typeof fetch
  return { fetchFn, calls }
}

/** Minimal unsigned JWT, enough for the claim reader. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`
}

const KIMI_DEVICE = 'https://auth.kimi.com/api/oauth/device_authorization'
const KIMI_TOKEN = 'https://auth.kimi.com/api/oauth/token'

test('kimi: device flow is form-encoded, carries the client device headers, and prefers the complete URL', async () => {
  const flow = await kimiDeviceFlow()
  assert.equal(flow.deviceCodeUrl, KIMI_DEVICE)
  assert.equal(flow.tokenUrl, KIMI_TOKEN)
  assert.equal(flow.encoding, 'form')
  assert.equal(flow.preferCompleteUri, true)
  assert.equal(flow.scope, undefined)
  assert.equal(flow.headers?.['x-msh-platform'], 'kimi_code_cli')
  assert.match(flow.headers?.['x-msh-device-id'] ?? '', /^[0-9a-f-]{32,36}$/i)

  const { fetchFn, calls } = stubFetch({
    [KIMI_DEVICE]: [{
      status: 200,
      body: {
        device_code: 'dc', user_code: 'WDJB-MJHT',
        verification_uri: 'https://kimi.com/device',
        verification_uri_complete: 'https://kimi.com/device?user_code=WDJB-MJHT',
        interval: 0.01, expires_in: 60,
      },
    }],
    [KIMI_TOKEN]: [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 60, token_type: 'Bearer' } },
    ],
  })
  const manager = new DeviceFlowManager()
  const attempt = await manager.start('kimi', { ...flow, fetchFn })
  assert.equal(attempt.verificationUrl, 'https://kimi.com/device?user_code=WDJB-MJHT')
  assert.equal(attempt.userCode, 'WDJB-MJHT')
  const tokens = await attempt.waitTokens()
  assert.equal(tokens.accessToken, 'at')
  assert.equal(tokens.refreshToken, 'rt')
  assert.equal(tokens.expiresIn, 60)

  const body = new URLSearchParams(String(calls[0]?.init?.body))
  assert.equal(body.get('client_id'), '17e5f671-d194-4dfb-9706-5516cb48c098')
  assert.equal(body.get('scope'), null)
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['x-msh-platform'], 'kimi_code_cli')
})

test('kimi: a completed grant becomes an account-keyed session and requires the refresh token', () => {
  const session = completeKimiLogin({
    accessToken: jwt({ email: 'dev@example.com' }),
    refreshToken: 'rt-1',
    expiresIn: 3600,
  })
  assert.equal(session.account, 'dev@example.com')
  assert.ok(session.expiresAt > Date.now() + 3_000_000)
  assert.equal(accountKeyOf('kimi', session), 'dev@example.com')
  assert.throws(() => completeKimiLogin({ accessToken: 'at' }), /no refresh token/)
})

test('kimi: refresh posts the rotating grant and keeps the account', async () => {
  const { fetchFn, calls } = stubFetch({
    [KIMI_TOKEN]: [{ status: 200, body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 120 } }],
  })
  const next = await refreshKimi({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1, account: 'a@b.c' }, fetchFn)
  assert.deepEqual({ at: next.accessToken, rt: next.refreshToken, account: next.account }, { at: 'at-2', rt: 'rt-2', account: 'a@b.c' })
  const body = new URLSearchParams(String(calls[0]?.init?.body))
  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('refresh_token'), 'rt-1')
  assert.equal(body.get('client_id'), '17e5f671-d194-4dfb-9706-5516cb48c098')
})

test('kimi: 401 and invalid_grant are permanent refresh failures', async () => {
  const { fetchFn } = stubFetch({ [KIMI_TOKEN]: [{ status: 401, body: { error: 'invalid_grant' } }] })
  const error = await refreshKimi({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 }, fetchFn).catch(value => value)
  assert.equal(isKimiPermanentRefreshError(error), true)
})

test('qwen-platform: the key product type selects the endpoint', () => {
  assert.deepEqual(parseQwenApiKey('sk-sp-abc123'), {
    key: 'sk-sp-abc123', baseURL: QWEN_TOKEN_PLAN_BASE, plan: 'Token Plan',
  })
  assert.equal(parseQwenApiKey('sk-ws-abc123').baseURL, QWEN_STANDARD_BASE)
  assert.equal(parseQwenApiKey('sk-abc123').baseURL, QWEN_STANDARD_BASE)
  assert.equal(parseQwenApiKey('  sk-sp-trimmed  ').key, 'sk-sp-trimmed')
  assert.throws(() => parseQwenApiKey('nope'), /sk-sp-/)
  assert.throws(() => parseQwenApiKey('sk-sp-\nheader'), /Invalid Qwen API key/)
  assert.match(QWEN_USER_AGENT, /^QwenCode\//)
})

test('qwen-platform: a saved key becomes a non-expiring, plan-labelled session', async () => {
  const session = qwenSessionFromKey('sk-sp-key')
  assert.equal(session.accessToken, 'sk-sp-key')
  assert.equal(session.refreshToken, 'sk-sp-key')
  assert.equal(session.plan, 'Token Plan')
  assert.equal(session.baseURL, QWEN_TOKEN_PLAN_BASE)
  assert.equal(accountKeyOf('qwen', session), 'Token Plan')
  assert.ok(session.expiresAt > Date.now() + 90 * 365 * 24 * 60 * 60_000)
  assert.equal(await refreshQwen(session), session)
})

const ZCODE_INIT = 'https://zcode.z.ai/api/v1/oauth/cli/init'
const ZCODE_POLL = 'https://zcode.z.ai/api/v1/oauth/cli/poll/flow-1'
const ZCODE_LOGIN = 'https://api.z.ai/api/auth/z/login'

function initEnvelope(provider: 'bigmodel' | 'zai') {
  return {
    status: 200,
    body: {
      code: 0,
      data: {
        flow_id: 'flow-1',
        poll_token: 'server-poll-token',
        authorize_url: provider === 'zai'
          ? 'https://chat.z.ai/api/oauth/authorize?client_id=x'
          : 'https://bigmodel.cn/login?appId=zcode',
        expires_at: Math.floor(Date.now() / 1000) + 300,
        server_time: Math.floor(Date.now() / 1000),
        poll_interval_sec: 0.01,
      },
    },
  }
}

/** Business-API stub: default org/project, an existing key, and its secret. */
function businessScript(host: string, opts: { keys?: unknown[] } = {}) {
  const base = `${host}/api/biz/v1/organization/org-1/projects/proj-1/api_keys`
  return {
    [`${host}/api/biz/customer/getCustomerInfo`]: [{
      status: 200,
      body: {
        code: 0,
        data: {
          organizations: [{
            organizationId: 'org-1',
            organizationName: '默认机构',
            projects: [{ projectId: 'proj-1', projectName: '默认项目' }],
          }],
        },
      },
    }],
    [base]: [
      { status: 200, body: { code: 0, data: opts.keys ?? [] } },
      { status: 200, body: { code: 0, data: { apiKey: 'created-key' } } },
    ],
    [`${base}/copy/kid`]: [{ status: 200, body: { code: 0, data: { secretKey: 'secret' } } }],
    [`${base}/copy/created-key`]: [{ status: 200, body: { code: 0, data: { secretKey: 'secret' } } }],
  }
}

test('glm(bigmodel): poll ready -> raw business token -> reuse key -> mint id.secret', async () => {
  const script = {
    [ZCODE_INIT]: [initEnvelope('bigmodel')],
    [ZCODE_POLL]: [
      { status: 200, body: { code: 0, data: { status: 'pending' } } },
      {
        status: 200,
        body: {
          code: 0,
          data: {
            status: 'ready',
            bigmodel: { access_token: 'bm-account-token' },
            user: { email: 'me@example.com' },
          },
        },
      },
    ],
    ...businessScript('https://bigmodel.cn', { keys: [{ name: 'zcode-api-key', apiKey: 'kid' }] }),
  }
  const { fetchFn, calls } = stubFetch(script)
  const attempt = await startGlmLogin('bigmodel', { fetchFn, minPollMs: 5 })
  assert.equal(attempt.authorizeUrl, 'https://bigmodel.cn/login?appId=zcode')
  const session = await attempt.wait()

  assert.equal(session.accessToken, 'kid.secret')
  assert.equal(session.refreshToken, 'bm-account-token')
  assert.equal(session.station, 'bigmodel')
  assert.equal(session.account, 'me@example.com')
  assert.equal(accountKeyOf('glm', session), 'me@example.com')

  const initCall = calls.find(call => call.url === ZCODE_INIT)
  assert.equal((initCall?.init?.headers as Record<string, string>).authorization !== undefined, true)
  assert.deepEqual(JSON.parse(String(initCall?.init?.body)), { provider: 'bigmodel' })
  const pollCall = calls.find(call => call.url === ZCODE_POLL)
  assert.equal((pollCall?.init?.headers as Record<string, string>).authorization, 'Bearer server-poll-token')
  const customer = calls.find(call => call.url === 'https://bigmodel.cn/api/biz/customer/getCustomerInfo')
  // bigmodel takes the account token verbatim, without a Bearer prefix.
  assert.equal((customer?.init?.headers as Record<string, string>).authorization, 'bm-account-token')
})

test('glm(zai): z/login exchanges the account token and creates the key when missing', async () => {
  const script = {
    [ZCODE_INIT]: [initEnvelope('zai')],
    [ZCODE_POLL]: [{
      status: 200,
      body: {
        code: 0,
        data: { status: 'ready', zai: { access_token: 'zai-account-token' }, user: { name: 'Zed' } },
      },
    }],
    [ZCODE_LOGIN]: [{ status: 200, body: { code: 0, data: { access_token: 'biz-jwt' } } }],
    ...businessScript('https://api.z.ai'),
  }
  const { fetchFn, calls } = stubFetch(script)
  const session = await (await startGlmLogin('zai', { fetchFn, minPollMs: 5 })).wait()
  assert.equal(session.accessToken, 'created-key.secret')
  assert.equal(session.refreshToken, 'biz-jwt')
  assert.equal(session.station, 'zai')
  assert.equal(session.account, 'Zed')
  const login = calls.find(call => call.url === ZCODE_LOGIN)
  assert.deepEqual(JSON.parse(String(login?.init?.body)), { token: 'zai-account-token' })
   const customer = calls.find(call => call.url === 'https://api.z.ai/api/biz/customer/getCustomerInfo')
  assert.equal((customer?.init?.headers as Record<string, string>).authorization, 'Bearer biz-jwt')
  const created = calls.find(call => call.url.endsWith('/api_keys') && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(String(created?.init?.body)), { name: 'zcode-api-key' })
})

test('glm: a business error envelope fails the login instead of storing a key', async () => {
  const script = {
    [ZCODE_INIT]: [initEnvelope('bigmodel')],
    [ZCODE_POLL]: [{
      status: 200,
      body: { code: 0, data: { status: 'ready', bigmodel: { access_token: 'tok' } } },
    }],
    'https://bigmodel.cn/api/biz/customer/getCustomerInfo': [
      { status: 200, body: { code: 1001, msg: 'Authentication parameter not received', success: false } },
      { status: 200, body: { code: 1001, msg: 'Authentication parameter not received', success: false } },
    ],
  }
  const { fetchFn } = stubFetch(script)
  const attempt = await startGlmLogin('bigmodel', { fetchFn, minPollMs: 5 })
  await assert.rejects(attempt.wait(), /customer lookup was not authorized/)
})

test('glm: no organization with a project reports "no coding plan"', async () => {
  const script = {
    [ZCODE_INIT]: [initEnvelope('bigmodel')],
    [ZCODE_POLL]: [{
      status: 200,
      body: { code: 0, data: { status: 'ready', bigmodel: { access_token: 'tok' } } },
    }],
    'https://bigmodel.cn/api/biz/customer/getCustomerInfo': [{
      status: 200,
      body: { code: 0, data: { organizations: [{ organizationId: 'org-1', projects: [] }] } },
    }],
  }
  const { fetchFn } = stubFetch(script)
  await assert.rejects(
    (await startGlmLogin('bigmodel', { fetchFn, minPollMs: 5 })).wait(),
    /no organization with a coding-plan project/,
  )
})

test('glm: cancel rejects the pending login', async () => {
  const { fetchFn } = stubFetch({
    [ZCODE_INIT]: [initEnvelope('bigmodel')],
    [ZCODE_POLL]: [{ status: 200, body: { code: 0, data: { status: 'pending' } } }],
  })
  const attempt = await startGlmLogin('bigmodel', { fetchFn, minPollMs: 50 })
  attempt.cancel()
  await assert.rejects(attempt.wait(), /login cancelled/)
})

test('glm: refresh re-mints the plan key from the stored business token', async () => {
  const base = 'https://bigmodel.cn/api/biz/v1/organization/org-1/projects/proj-1/api_keys'
  const { fetchFn, calls } = stubFetch({
    'https://bigmodel.cn/api/biz/customer/getCustomerInfo': [{
      status: 200,
      body: { code: 0, data: { organizations: [{ organizationId: 'org-1', projects: [{ projectId: 'proj-1' }] }] } },
    }],
    [base]: [
      { status: 200, body: { code: 0, data: [] } },
      { status: 200, body: { code: 0, data: { apiKey: 'fresh-key' } } },
    ],
    [`${base}/copy/fresh-key`]: [{ status: 200, body: { code: 0, data: { secretKey: 's2' } } }],
  })
  const session: GlmSession = {
    accessToken: 'old-key', refreshToken: 'bm-token', expiresAt: Date.now() + 1000, station: 'bigmodel',
  }
  const next = await refreshGlm(session, fetchFn)
  assert.equal(next.accessToken, 'fresh-key.s2')
  assert.equal(next.refreshToken, 'bm-token')
  assert.ok(next.expiresAt > Date.now() + 29 * 24 * 60 * 60_000)
  const customer = calls.find(call => call.url.endsWith('/getCustomerInfo'))
  assert.equal((customer?.init?.headers as Record<string, string>).authorization, 'bm-token')
})

test('kimi: the inference base stays the subscription endpoint', () => {
  assert.equal(KIMI_API_BASE, 'https://api.kimi.com/coding/v1')
})

test('host integration: the three routes register and stay catalog-empty until login', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cn-routes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  ctx.provide('tools', { register: () => () => {} })
  const runtime = ctx.plugin(plugin, {
    providers: ['kimi', 'glm', 'qwen'],
    pool: { enabled: false },
    glm: { station: 'zai' },
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    const providers = llm.listProviders()
    assert.deepEqual(providers.map(provider => provider.id), ['kimi', 'glm', 'qwen'])
    assert.deepEqual(providers.map(provider => provider.name), ['Kimi Code', 'GLM Coding Plan', 'Qwen 千问AI平台'])
    // No account yet: a subscription route advertises nothing rather than a
    // catalog the user cannot call.
    assert.deepEqual(await llm.listModels('kimi'), [])
    assert.deepEqual(await llm.listModels('glm'), [])
    assert.deepEqual(await llm.listModels('qwen'), [])
  } finally {
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('glm: an unauthorized business envelope is a permanent refresh failure', async () => {
  const { fetchFn } = stubFetch({
    'https://bigmodel.cn/api/biz/customer/getCustomerInfo': [
      { status: 200, body: { code: 1001, msg: 'Authentication parameter not received', success: false } },
      { status: 200, body: { code: 1001, msg: 'Authentication parameter not received', success: false } },
    ],
  })
  const session: GlmSession = {
    accessToken: 'k', refreshToken: 'dead', expiresAt: Date.now() + 1000, station: 'bigmodel',
  }
  const error = await refreshGlm(session, fetchFn).catch(value => value)
  assert.equal(isGlmPermanentRefreshError(error), true)
})

test('glm(bigmodel): a raw-token 1001 retries provisioning with a Bearer header', async () => {
  const base = 'https://bigmodel.cn/api/biz/v1/organization/org-1/projects/proj-1/api_keys'
  const { fetchFn, calls } = stubFetch({
    'https://bigmodel.cn/api/biz/customer/getCustomerInfo': [
      { status: 200, body: { code: 1001, msg: 'Authentication parameter not received', success: false } },
      {
        status: 200,
        body: { code: 0, data: { organizations: [
          { organizationId: 'org-1', projects: [{ projectId: 'proj-1' }] },
        ] } },
      },
    ],
    [base]: [{ status: 200, body: { code: 0, data: [{ name: 'zcode-api-key', apiKey: 'kid' }] } }],
    [`${base}/copy/kid`]: [{ status: 200, body: { code: 0, data: { secretKey: 's' } } }],
  })
  assert.equal(await mintKey('bigmodel', 'bm-token', fetchFn), 'kid.s')
  const customerCalls = calls.filter(call => call.url.endsWith('/getCustomerInfo'))
  assert.equal((customerCalls[0]?.init?.headers as Record<string, string>).authorization, 'bm-token')
  assert.equal((customerCalls[1]?.init?.headers as Record<string, string>).authorization, 'Bearer bm-token')
})
