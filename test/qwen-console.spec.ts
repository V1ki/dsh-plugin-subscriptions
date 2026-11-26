/**
 * Qwen 千问AI平台 console login and quota mapping: the PKCE device flow, the
 * four-layer gateway envelope, monthly used-ratio/reset mapping, and the
 * pay-as-you-go cash balance fallback. Fetches are injected.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import './keep-alive.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'
import { listQwenConsoleModels, startQwenConsoleLogin } from '../src/auth/qwen-console.js'
import { fetchQwenUsage } from '../src/providers/qwen-usage.js'
import { qwenSessionFromKey } from '../src/auth/qwen.js'
import { accountKeyOf } from '../src/auth/store.js'
import type { QwenSession } from '../src/auth/store.js'

/** JSON response for the host-level fetch stubs. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface Call {
  url: string
  init?: RequestInit
}

/** Route one request by a URL predicate; records every call. */
function routedFetch(routes: {
  match: (url: URL, init?: RequestInit) => boolean
  respond: () => { status?: number; body?: unknown }
}[]): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(init === undefined ? { url: url.toString() } : { url: url.toString(), init })
    const route = routes.find(candidate => candidate.match(url, init))
    if (route === undefined) return Promise.reject(new Error(`unexpected fetch to ${url.toString()}`))
    const payload = route.respond()
    return Promise.resolve(new Response(JSON.stringify(payload.body ?? {}), { status: payload.status ?? 200 }))
  }) as typeof fetch
  return { fetchFn, calls }
}

function gatewayEnvelope(payload: unknown) {
  return {
    code: '200',
    successResponse: true,
    data: {
      success: true,
      httpStatus: 200,
      DataV2: {
        ret: ['SUCCESS::接口调用成功'],
        data: { code: 'SUCCESS', success: true, data: payload },
      },
    },
  }
}

test('qwen console: PKCE device flow resolves the credentials from the poll', async () => {
  let polls = 0
  const { fetchFn, calls } = routedFetch([
    {
      match: url => url.hostname === 't.qianwenai.com' && url.pathname === '/cli/device/code',
      respond: () => ({
        body: {
          Data: {
            Token: 'device-token',
            ExpiresIn: 60,
            VerificationUrl: 'https://account.qianwenai.com/sso/OIDCAuth?auth_token=device-token',
            Interval: 0.01,
          },
          Success: true,
        },
      }),
    },
    {
      match: url => url.hostname === 't.qianwenai.com' && url.pathname === '/cli/device/token',
      respond: () => {
        polls += 1
        return polls === 1
          ? { body: { Data: { Status: 'authorization_pending' }, Success: true } }
          : {
            body: {
              Data: {
                Status: 'complete',
                Credentials: {
                  AccessToken: 'console-at',
                  RefreshToken: 'console-rt',
                  ExpireTime: Date.parse('2027-01-01T00:00:00Z'),
                  User: { email: 'me@example.com' },
                },
              },
              Success: true,
            },
          }
      },
    },
  ])

  const attempt = await startQwenConsoleLogin({ fetchFn, minPollMs: 5 })
  assert.match(attempt.authorizeUrl, /account\.qianwenai\.com/)
  const credentials = await attempt.wait()
  assert.equal(credentials.accessToken, 'console-at')
  assert.equal(credentials.refreshToken, 'console-rt')
  assert.equal(credentials.user, 'me@example.com')
  assert.equal(credentials.expiresAt, Date.parse('2027-01-01T00:00:00Z'))

  const deviceCall = calls[0]
  const query = new URL(deviceCall?.url ?? '').searchParams
  assert.equal(query.get('code_challenge_method'), 'S256')
  assert.ok((query.get('code_challenge') ?? '').length > 10)
  assert.ok((query.get('client_id') ?? '').length > 10)
  const pollQuery = new URL(calls[1]?.url ?? '').searchParams
  assert.equal(pollQuery.get('token'), 'device-token')
  assert.ok((pollQuery.get('code_verifier') ?? '').length > 10)
})

test('qwen console: cancel rejects the pending login', async () => {
  const { fetchFn } = routedFetch([
    {
      match: url => url.pathname === '/cli/device/code',
      respond: () => ({
        body: { Data: { Token: 't', VerificationUrl: 'https://x', Interval: 0.01, ExpiresIn: 60 } },
      }),
    },
    {
      match: url => url.pathname === '/cli/device/token',
      respond: () => ({ body: { Data: { Status: 'authorization_pending' } } }),
    },
  ])
  const attempt = await startQwenConsoleLogin({ fetchFn, minPollMs: 50 })
  attempt.cancel()
  await assert.rejects(attempt.wait(), /login cancelled/)
})

const qwenSession: QwenSession = {
  accessToken: 'sk-sp-key',
  refreshToken: 'sk-sp-key',
  expiresAt: Date.now() + 100 * 365 * 24 * 60 * 60_000,
  account: 'Token Plan',
  plan: 'Token Plan',
  baseURL: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
  console: { accessToken: 'console-at', expiresAt: Date.now() + 86_400_000, cliAccessToken: 'cli-token' },
}

test('qwen usage: monthly ratio, reset instant, plan and remaining credits', async () => {
  const { fetchFn, calls } = routedFetch([
    {
      match: url => url.hostname === 'cs-data.qianwenai.com'
        && url.searchParams.get('api')?.endsWith('/usage') === true,
      respond: () => ({
        body: gatewayEnvelope({
          per1MonthPercentage: 0.2834,
          per1MonthResetTime: Date.parse('2026-12-01T00:00:00Z'),
        }),
      }),
    },
    {
      match: url => url.hostname === 'cs-data.qianwenai.com'
        && url.searchParams.get('api')?.endsWith('/subscription') === true,
      respond: () => ({ body: gatewayEnvelope({ status: 'VALID', specCode: 'pro', endTime: 1798732800000 }) }),
    },
    {
      match: url => url.hostname === 'cs-data.qianwenai.com'
        && url.searchParams.get('api')?.endsWith('/quota-config') === true,
      respond: () => ({ body: gatewayEnvelope({ pro: { monthly: 200000, five_hour: 12000 } }) }),
    },
  ])
  const { usage } = await fetchQwenUsage(qwenSession, fetchFn)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, 'pro')
  assert.equal(usage.windows?.[0]?.scope, 'Monthly')
  assert.equal(usage.windows?.[0]?.usedPercent, 28.34)
  assert.equal(usage.windows?.[0]?.resetsAt, Date.parse('2026-12-01T00:00:00Z'))
  // 200,000 credits × (1 − 0.2834) = 143,320 remaining.
  assert.deepEqual(usage.credits, { hasCredits: true, unlimited: false, balance: '143320', unit: 'credit' })
  const usageCall = calls.find(call => decodeURIComponent(call.url).includes('/usage'))
  assert.equal((usageCall?.init?.headers as Record<string, string>).authorization, 'Bearer cli-token')
})

test('qwen usage: a pay-as-you-go account reports its cash balance', async () => {
  const { fetchFn } = routedFetch([
    {
      match: url => url.hostname === 'cs-data.qianwenai.com'
        && url.searchParams.get('api')?.endsWith('/usage') === true,
      respond: () => ({ body: gatewayEnvelope({}) }),
    },
    {
      match: url => url.hostname === 'cs-data.qianwenai.com'
        && url.searchParams.get('api')?.endsWith('/subscription') === true,
      respond: () => ({ body: gatewayEnvelope({}) }),
    },
    {
      match: url => url.hostname === 'cs-data.qianwenai.com'
        && url.searchParams.get('api')?.endsWith('/quota-config') === true,
      respond: () => ({ body: gatewayEnvelope({}) }),
    },
    {
      match: url => url.hostname === 'cli.qianwenai.com',
      respond: () => ({ body: { code: '200', data: { AvailableAmount: '123.45', Currency: 'CNY' } } }),
    },
  ])
  const { usage } = await fetchQwenUsage(qwenSession, fetchFn)
  assert.equal(usage.windows, undefined)
  assert.deepEqual(usage.credits, {
    hasCredits: true,
    unlimited: false,
    balance: '123.45',
    unit: 'currency',
    currency: 'CNY',
  })
})

test('qwen usage: without a console session the route reports unsupported', async () => {
  const { console: _console, ...withoutConsole } = qwenSession
  const { usage } = await fetchQwenUsage(withoutConsole, (() => {
    throw new Error('must not fetch')
  }) as typeof fetch)
  assert.deepEqual(usage, { supported: false })
})

test('qwen console: the platform catalog is read and media models are filtered out', async () => {
  let request: RequestInit | undefined
  const { fetchFn } = routedFetch([
    {
      match: url => url.hostname === 'cli.qianwenai.com',
      respond: () => ({
        body: {
          code: '200',
          data: {
            Data: [{
              Group: 'text',
              Models: [
                { Model: 'qwen4-max-preview' },
                { Model: 'qwen3.8-max' },
                { Model: 'qwen-image-3.0-pro' },
                { Model: 'wan3.0-video' },
                { Model: 'qwen-audio-3.0-tts-plus' },
              ],
            }],
          },
        },
      }),
    },
  ])
  const ids = await listQwenConsoleModels({
    accessToken: 'console-at',
    cliAccessToken: 'cli-token',
    expiresAt: Date.now() + 86_400_000,
  }, fetchFn)
  assert.deepEqual(ids, ['qwen4-max-preview', 'qwen3.8-max'])
})

test('host: logout during the console exchange is not resurrected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qwen-console-race-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await mkdir(join(home, 'plugins', 'subscriptions'), { recursive: true })
  const session = qwenSessionFromKey('sk-sp-race')
  const key = accountKeyOf('qwen', session)
  await writeFile(join(home, 'plugins', 'subscriptions', 'auth.json'), JSON.stringify({
    qwen: { default: key, accounts: { [key]: session } },
  }))

  let releaseExchange!: () => void
  const exchangeReleased = new Promise<void>((resolve) => { releaseExchange = resolve })
  let markStarted!: () => void
  const exchangeStarted = new Promise<void>((resolve) => { markStarted = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/cli/device/code')) {
      return json({ Data: {
        Token: 'device-token', VerificationUrl: 'https://example.invalid/verify', Interval: 1, ExpiresIn: 60,
      } })
    }
    if (url.includes('/cli/device/token')) {
      return json({ Data: {
        Status: 'complete', Credentials: { AccessToken: 'console-at', ExpireTime: Date.now() + 86_400_000 },
      } })
    }
    if (url.includes('cli.qianwenai.com')) {
      markStarted()
      await exchangeReleased
      return json({ code: 200, data: { cliAccessToken: 'cli-token' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  const ctx = new Context()
  new LlmRuntime(ctx)
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', { register: () => () => {} })
  const runtime = ctx.plugin(plugin, { providers: ['qwen'] })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    const login = await connection.handler('login', { provider: 'qwen', account: key }, new AbortController().signal)
    assert.equal(login.ok, true)
    await exchangeStarted
    // Log out while exchangeQwenCliToken is still in flight.
    const logout = await connection.handler('logout', { provider: 'qwen', account: key }, new AbortController().signal)
    assert.equal(logout.ok, true)
    releaseExchange()
    await new Promise(resolve => setTimeout(resolve, 200))
    const status = await connection.handler('status', { provider: 'qwen' }, new AbortController().signal)
    assert.equal(status.ok, true)
    assert.equal((status.value as { providers: { qwen: { accounts: unknown[] } } }).providers.qwen.accounts.length, 0)
  } finally {
    await runtime.dispose()
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('host: re-saving a legacy plan-keyed account updates it instead of duplicating', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qwen-console-legacy-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await mkdir(join(home, 'plugins', 'subscriptions'), { recursive: true })
  const session: QwenSession = {
    accessToken: 'sk-sp-legacy',
    refreshToken: 'sk-sp-legacy',
    expiresAt: Date.now() + 100 * 365 * 24 * 60 * 60_000,
    account: 'Token Plan',
    plan: 'Token Plan',
    baseURL: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
    console: { accessToken: 'console-at', expiresAt: Date.now() + 86_400_000 },
  }
  await writeFile(join(home, 'plugins', 'subscriptions', 'auth.json'), JSON.stringify({
    qwen: { default: 'Token Plan', accounts: { 'Token Plan': session } },
  }))
  const ctx = new Context()
  new LlmRuntime(ctx)
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', { register: () => () => {} })
  const runtime = ctx.plugin(plugin, { providers: ['qwen'] })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    const saved = await connection.handler('saveKey', { provider: 'qwen', key: 'sk-sp-legacy' }, new AbortController().signal)
    assert.equal(saved.ok, true)
    const status = await connection.handler('status', { provider: 'qwen' }, new AbortController().signal)
    assert.equal(status.ok, true)
    const value = status.value as { providers: { qwen: { accounts: { key: string, quotaLinked?: boolean }[] } } }
    assert.equal(value.providers.qwen.accounts.length, 1)
    assert.equal(value.providers.qwen.accounts[0]?.key, 'Token Plan')
    assert.equal(value.providers.qwen.accounts[0]?.quotaLinked, true)
  } finally {
    await runtime.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
