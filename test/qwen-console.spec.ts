/**
 * Qwen 千问AI平台 console login and quota mapping: the PKCE device flow, the
 * four-layer gateway envelope, monthly used-ratio/reset mapping, and the
 * pay-as-you-go cash balance fallback. Fetches are injected.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { startQwenConsoleLogin } from '../src/auth/qwen-console.js'
import { fetchQwenUsage } from '../src/providers/qwen-usage.js'
import type { QwenSession } from '../src/auth/store.js'

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
