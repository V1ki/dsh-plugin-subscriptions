/**
 * Kimi Code and GLM Coding Plan usage parsing: windows, reset instants,
 * Extra Usage balance, and banked reset cards. Fetches are injected.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'
import './keep-alive.js'
import { fetchKimiUsage } from '../src/providers/kimi-usage.js'
import { fetchGlmUsage } from '../src/providers/glm-usage.js'
import { fetchGlmModels } from '../src/providers/glm-models.js'
import type { GlmSession, KimiSession } from '../src/auth/store.js'

const KIMI_USAGES = 'https://api.kimi.com/coding/v1/usages'
const KIMI_ME = 'https://api.kimi.com/coding/v1/me'
const GLM_LIMIT = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
const GLM_RESET = 'https://open.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL'

interface Stub {
  status?: number
  body?: unknown
}

/** A fetch stub replaying one response queue per URL and recording headers. */
function stubFetch(script: Record<string, Stub[]>): {
  fetchFn: typeof fetch
  headers: (url: string) => Record<string, string>[]
} {
  const queues = new Map(Object.entries(script).map(([url, responses]) => [url, [...responses]]))
  const seen = new Map<string, Record<string, string>[]>()
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const record = seen.get(url) ?? []
    record.push((init?.headers ?? {}) as Record<string, string>)
    seen.set(url, record)
    const queue = queues.get(url)
    if (queue === undefined || queue.length === 0) {
      return Promise.reject(new Error(`unexpected fetch to ${url}`))
    }
    const payload = queue.shift() ?? {}
    return Promise.resolve(new Response(JSON.stringify(payload.body ?? {}), { status: payload.status ?? 200 }))
  }) as typeof fetch
  return { fetchFn, headers: url => seen.get(url) ?? [] }
}

const kimiSession: KimiSession = {
  accessToken: 'kimi-at',
  refreshToken: 'kimi-rt',
  expiresAt: Date.now() + 3_600_000,
}

test('kimi usage: ratio pools, monthly scope, planner tier and Extra Usage balance', async () => {
  const { fetchFn, headers } = stubFetch({
    [KIMI_USAGES]: [{
      status: 200,
      body: {
        usages: {
          limit_5h: { used_ratio: 0.1, reset_time: '2026-11-15T18:00:00Z' },
          limit_month_total: { used_ratio: '0.5', reset_time: '2026-11-26T00:00:00Z' },
          limit_month_code: { used_ratio: 0.25, reset_time: '2026-11-26T00:00:00Z' },
        },
        boosterWallet: {
          status: 'STATUS_ACTIVE',
          balance: { type: 'BOOSTER', amountLeft: 12_340_000 },
          monthlyChargeLimit: { currency: 'CNY' },
        },
      },
    }],
    [KIMI_ME]: [{ status: 200, body: { user_level_name: 'Allegretto' } }],
  })
  const usage = await fetchKimiUsage(kimiSession, fetchFn)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, 'Allegretto')
  assert.deepEqual(usage.windows?.map(window => [window.kind, window.usedPercent, window.scope]), [
    ['session', 10, undefined],
    ['other', 50, 'Monthly'],
    ['other', 25, 'Code'],
  ])
  assert.equal(usage.windows?.[0]?.durationMs, 5 * 60 * 60_000)
  assert.equal(usage.windows?.[0]?.resetsAt, Date.parse('2026-11-15T18:00:00Z'))
  assert.deepEqual(usage.credits, {
    hasCredits: true,
    unlimited: false,
    balance: '12.34',
    unit: 'currency',
    currency: 'CNY',
  })
  assert.equal(headers(KIMI_USAGES)[0]?.authorization, 'Bearer kimi-at')
})

test('kimi usage: legacy count windows are derived when ratio pools are absent', async () => {
  const { fetchFn } = stubFetch({
    [KIMI_USAGES]: [{
      status: 200,
      body: {
        limits: [{
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '200', used: '50', remaining: '150', resetTime: '2026-11-15T18:00:00Z' },
        }],
        usage: { limit: '2048', used: '512', remaining: '1536', resetTime: '2026-11-20T00:00:00Z' },
      },
    }],
    [KIMI_ME]: [{ status: 404, body: {} }],
  })
  const usage = await fetchKimiUsage(kimiSession, fetchFn)
  assert.deepEqual(usage.windows?.map(window => [window.kind, window.usedPercent]), [
    ['session', 25],
    ['weekly', 25],
  ])
  assert.equal(usage.plan, undefined)
})

test('kimi usage: a failed endpoint surfaces an error', async () => {
  const { fetchFn } = stubFetch({ [KIMI_USAGES]: [{ status: 401, body: {} }] })
  await assert.rejects(() => fetchKimiUsage(kimiSession, fetchFn), /HTTP 401/)
})

const glmSession: GlmSession = {
  accessToken: 'kid.secret',
  refreshToken: 'biz-token',
  expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
  station: 'bigmodel',
  account: 'me@example.com',
}

test('glm usage: credit windows, plan, and available reset cards', async () => {
  const { fetchFn, headers } = stubFetch({
    [GLM_LIMIT]: [{
      status: 200,
      body: {
        code: 200,
        success: true,
        data: {
          level: 'max',
          limits: [
            { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 3341, remaining: 24658, percentage: 11, nextResetTime: 1787563232239 },
            { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 25224, remaining: 114775, percentage: 18, nextResetTime: 1788077327998 },
          ],
        },
      },
    }],
    [GLM_RESET]: [{
      status: 200,
      body: {
        code: 200,
        success: true,
        data: {
          fiveHourResets: [
            { recordId: 11, resetType: 'FIVE_HOUR', expireTime: '2026-12-20 23:59:59', available: true },
            { recordId: 12, resetType: 'FIVE_HOUR', expireTime: '2026-12-20 23:59:59', status: 'consumed' },
          ],
          weekResets: [{ id: 21, expireTime: '2026-12-25 23:59:59' }],
        },
      },
    }],
  })
  const usage = await fetchGlmUsage(glmSession, fetchFn)
  assert.equal(usage.plan, 'max')
  assert.deepEqual(usage.windows?.map(window => [window.kind, window.usedPercent, window.durationMs]), [
    ['session', 11, 5 * 60 * 60_000],
    ['weekly', 18, 7 * 24 * 60 * 60_000],
  ])
  assert.equal(usage.windows?.[0]?.resetsAt, 1787563232239)
  assert.deepEqual(usage.resetCredits?.map(card => card.id), ['11', '21'])
  assert.equal(usage.resetCredits?.[0]?.expiresAt, Date.parse('2026-12-20T23:59:59+08:00'))
  // The official client sends the minted key bare, without a Bearer prefix.
  assert.equal(headers(GLM_LIMIT)[0]?.authorization, 'kid.secret')
})

test('glm usage: a 1000 auth envelope retries once with Bearer', async () => {
  const { fetchFn, headers } = stubFetch({
    [GLM_LIMIT]: [
      { status: 200, body: { code: 1000, msg: '身份验证失败。', success: false } },
      {
        status: 200,
        body: {
          code: 200,
          success: true,
          data: { level: 'lite', limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 4 }] },
        },
      },
    ],
    [GLM_RESET]: [{ status: 200, body: { code: 200, success: true, data: { fiveHourResets: [], weekResets: [] } } }],
  })
  const usage = await fetchGlmUsage(glmSession, fetchFn)
  assert.equal(usage.windows?.[0]?.usedPercent, 4)
  assert.deepEqual(headers(GLM_LIMIT).map(entry => entry.authorization), ['kid.secret', 'Bearer kid.secret'])
  assert.deepEqual(usage.resetCredits, [])
})

test('glm usage: an account without a Coding Plan reports it, not zero usage', async () => {
  const { fetchFn } = stubFetch({
    [GLM_LIMIT]: [{ status: 200, body: { code: 500, msg: '当前用户不存在coding plan', success: false } }],
  })
  await assert.rejects(() => fetchGlmUsage(glmSession, fetchFn), /no active Coding Plan/)
})

test('glm usage: a failed reset lookup keeps the windows and reports the error', async () => {
  const { fetchFn } = stubFetch({
    [GLM_LIMIT]: [{
      status: 200,
      body: { code: 200, success: true, data: { level: 'pro', limits: [{ type: 'CREDIT_LIMIT', unit: 3, percentage: 2 }] } },
    }],
    [GLM_RESET]: [{ status: 500, body: {} }],
  })
  const usage = await fetchGlmUsage(glmSession, fetchFn)
  assert.equal(usage.windows?.length, 1)
  assert.equal(usage.resetCredits, undefined)
  assert.match(usage.resetCreditsError ?? '', /HTTP 500/)
})

test('host: a pool-enabled profile reads Kimi/GLM usage instead of reporting unsupported', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cn-usage-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await mkdir(join(home, 'plugins', 'subscriptions'), { recursive: true })
  const far = Date.now() + 30 * 24 * 60 * 60_000
  await writeFile(join(home, 'plugins', 'subscriptions', 'auth.json'), JSON.stringify({
    kimi: { default: 'k', accounts: { k: { accessToken: 'kimi-at', refreshToken: 'kimi-rt', expiresAt: far } } },
    glm: { default: 'g', accounts: { g: {
      accessToken: 'kid.secret', refreshToken: 'biz', expiresAt: far, station: 'bigmodel',
    } } },
    qwen: { default: 'Token Plan', accounts: { 'Token Plan': {
      accessToken: 'sk-sp-x', refreshToken: 'sk-sp-x', expiresAt: far,
      account: 'Token Plan', plan: 'Token Plan',
      baseURL: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
      console: { accessToken: 'console-at', cliAccessToken: 'cli-token', expiresAt: far },
    } } },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/coding/v1/usages')) {
      return json({ usages: { limit_5h: { used_ratio: 0.25, reset_time: '2026-11-15T18:00:00Z' } } })
    }
    if (url.endsWith('/coding/v1/me')) return json({ user_level_name: 'Pro' })
    if (url.endsWith('/coding/v1/models')) return json({ data: [] })
    if (url.includes('/api/monitor/usage/quota/limit')) {
      return json({ code: 200, success: true, data: {
        level: 'pro',
        limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 40, nextResetTime: 1787563232239 }],
      } })
    }
    if (url.includes('/customer-package-reset/list')) {
      return json({ code: 200, success: true, data: { fiveHourResets: [], weekResets: [] } })
    }
    if (url.endsWith('/api/paas/v4/models')) {
      return json({ data: [
        { id: 'glm-5.4' },
        { id: 'glm-5.3-flashx' },
        { id: 'glm-4.7' },
        { id: 'glm-5.3-flashx-legal' },
      ] })
    }
    if (url.startsWith('https://cli.qianwenai.com/data/v2/api.json')) {
      return json({ code: '200', data: { Data: [{ Models: [
        { Model: 'qwen4-max-preview' },
        { Model: 'qwen3.8-max' },
      ] }] } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', { register: () => () => {} })
  // Default config: the account pool is enabled, so usage goes through the
  // pool cache and its own fetcher table.
  const runtime = ctx.plugin(plugin, {})
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    const kimi = await connection.handler('usage', { provider: 'kimi', account: 'k' }, new AbortController().signal)
    assert.equal(kimi.ok, true)
    assert.equal((kimi.value as { supported: boolean }).supported, true)
    assert.equal((kimi.value as { windows: { usedPercent: number }[] }).windows[0]?.usedPercent, 25)
    const glm = await connection.handler('usage', { provider: 'glm', account: 'g' }, new AbortController().signal)
    assert.equal(glm.ok, true)
    assert.equal((glm.value as { supported: boolean }).supported, true)
    assert.equal((glm.value as { windows: { usedPercent: number }[] }).windows[0]?.usedPercent, 40)
    // The console catalog replaces the static Qwen list, so preview models
    // the platform shows appear in the picker.
    const qwenModels = await llm.listModels('qwen')
    assert.deepEqual(qwenModels.map(model => model.id), ['qwen4-max-preview', 'qwen3.8-max'])
    // The account's live list wins over the static fallback: GLM-5.4 and the
    // FlashX variant appear without a plugin release; glm-4.7 and legal-only
    // variants stay out.
    const glmModels = await llm.listModels('glm')
    assert.deepEqual(glmModels.map(model => model.id), ['glm-5.4', 'glm-5.3-flashx'])
  } finally {
    await runtime.dispose()
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('glm models: the account list is filtered to the coding-plan generation', async () => {
  const { fetchFn } = stubFetch({
    'https://open.bigmodel.cn/api/paas/v4/models': [{
      status: 200,
      body: { data: [
        { id: 'glm-5.4' },
        { id: 'glm-5.3-flashx' },
        { id: 'glm-4.7' },
        { id: 'glm-5.3-flashx-legal' },
        { id: 'glm-5.4' },
      ] },
    }],
  })
  assert.deepEqual(await fetchGlmModels(glmSession, fetchFn), ['glm-5.4', 'glm-5.3-flashx'])
})
