/**
 * Subscription usage lookups: fetchCodexUsage / fetchClaudeUsage payload
 * mapping (via an injected fetch, no network) and the `/subscriptions-auth`
 * `usage` endpoint answering `{ supported: false }` for providers without a
 * usage fetcher and an error result for a logged-out provider.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'

process.env.DSH_HOME ??= mkdtempSync(join(tmpdir(), 'router-usage-test-'))

// Imports after the env override so the store path resolves under the temp home.
const { fetchCodexUsage } = await import('../src/providers/codex.js')
const { fetchClaudeUsage } = await import('../src/providers/claude.js')
const { fetchGrokUsage, grokTierName } = await import('../src/providers/grok.js')
const plugin = await import('../src/index.js')
const { SubscriptionsAuthController } = plugin
const { OAuthFlowManager } = await import('../src/auth/oauth-flow.js')
const { DeviceFlowManager } = await import('../src/auth/device-flow.js')
const { PoolUsageTracker } = await import('../src/providers/pool-usage.js')

import { OAuthEndpointError } from '../src/providers/common.js'
import type { FetchFn, ProviderUsage } from '../src/providers/common.js'
import type { ClaudeSession, CodexSession, GrokSession } from '../src/auth/store.js'

const codexSession: CodexSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}
const claudeSession: ClaudeSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'scope',
}
const grokSession: GrokSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  tokenEndpoint: 'https://auth.x.ai/token',
}

/** A fetch implementation answering one JSON payload; records the request. */
function fakeFetch(payload: unknown, status = 200): {
  fetchFn: FetchFn
  requests: { url: string; headers: Record<string, string> }[]
} {
  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetchFn: FetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
    requests.push({ url: String(url), headers })
    return Promise.resolve(new Response(JSON.stringify(payload), { status }))
  }) as FetchFn
  return { fetchFn, requests }
}

test('fetchCodexUsage maps windows, plan, and reset timestamps', async () => {
  const { fetchFn, requests } = fakeFetch({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 1_782_770_922 },
      secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 1_783_357_722 },
    },
  })
  const usage = await fetchCodexUsage(codexSession, fetchFn)
  assert.deepEqual(usage, {
    supported: true,
    plan: 'plus',
    windows: [
      { kind: 'session', usedPercent: 27, resetsAt: 1_782_770_922_000 },
      { kind: 'weekly', usedPercent: 4, resetsAt: 1_783_357_722_000 },
    ],
  })
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /backend-api\/wham\/usage/)
  assert.equal(requests[0].headers['chatgpt-account-id'], 'acct-1')
  assert.equal(requests[0].headers.authorization, 'Bearer at')
})

test('fetchCodexUsage classifies a weekly primary window by duration', async () => {
  const { fetchFn } = fakeFetch({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 39, limit_window_seconds: 604800, reset_at: 1_783_357_722 },
    },
  })
  const usage = await fetchCodexUsage(codexSession, fetchFn)
  assert.deepEqual(usage.windows, [
    { kind: 'weekly', usedPercent: 39, resetsAt: 1_783_357_722_000 },
  ])
})

test('fetchCodexUsage maps unrecognized durations to other, not a fixed label', async () => {
  const { fetchFn } = fakeFetch({
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 5, limit_window_seconds: 3600 },
    },
  })
  const usage = await fetchCodexUsage(codexSession, fetchFn)
  assert.deepEqual(usage.windows, [
    { kind: 'session', usedPercent: 10 },
    { kind: 'other', usedPercent: 5 },
  ])
})

test('fetchCodexUsage falls back to slot-based kind when duration is absent', async () => {
  const { fetchFn } = fakeFetch({
    rate_limit: {
      primary_window: { used_percent: 10 },
      secondary_window: { used_percent: 4 },
    },
  })
  const usage = await fetchCodexUsage(codexSession, fetchFn)
  assert.deepEqual(usage.windows, [
    { kind: 'session', usedPercent: 10 },
    { kind: 'weekly', usedPercent: 4 },
  ])
})

test('fetchCodexUsage falls back to reset_after_seconds and tolerates missing windows', async () => {
  const before = Date.now()
  const { fetchFn } = fakeFetch({
    rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: 100 } },
  })
  const usage = await fetchCodexUsage(codexSession, fetchFn)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, undefined)
  assert.equal(usage.windows?.length, 1)
  const [window] = usage.windows ?? []
  assert.equal(window.kind, 'session')
  assert.equal(window.usedPercent, 10)
  assert.ok(window.resetsAt !== undefined && window.resetsAt >= before + 100_000)
})

test('fetchCodexUsage: non-2xx response throws', async () => {
  const { fetchFn } = fakeFetch({ error: 'nope' }, 500)
  await assert.rejects(fetchCodexUsage(codexSession, fetchFn), /codex usage/)
})

test('fetchClaudeUsage maps legacy buckets and skips null ones', async () => {
  const { fetchFn, requests } = fakeFetch({
    five_hour: { utilization: 6, resets_at: '2026-04-08T18:59:59Z' },
    seven_day: { utilization: 35, resets_at: '2026-04-14T16:59:59Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 21, resets_at: null },
  })
  const usage = await fetchClaudeUsage(claudeSession, fetchFn)
  assert.deepEqual(usage, {
    supported: true,
    windows: [
      { kind: 'session', usedPercent: 6, resetsAt: Date.parse('2026-04-08T18:59:59Z') },
      { kind: 'weekly', usedPercent: 35, resetsAt: Date.parse('2026-04-14T16:59:59Z') },
      { kind: 'weekly', scope: 'Sonnet', usedPercent: 21 },
    ],
  })
  assert.equal(requests[0].headers['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(requests[0].headers.authorization, 'Bearer at')
})

test('fetchClaudeUsage: a 429 carries the retry-after header as retryAfterMs (issue #46)', async () => {
  const fetchFn: FetchFn = ((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(
    new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '462' } }),
  )) as FetchFn
  await assert.rejects(fetchClaudeUsage(claudeSession, fetchFn), (error: unknown) => {
    assert.ok(error instanceof OAuthEndpointError)
    assert.equal(error.status, 429)
    assert.equal(error.retryAfterMs, 462_000)
    return true
  })
})

test('fetchClaudeUsage prefers the modern limits array when present', async () => {
  const { fetchFn } = fakeFetch({
    five_hour: null,
    seven_day: null,
    limits: [
      { kind: 'session', percent: 12, resets_at: '2026-04-08T18:59:59Z' },
      { kind: 'weekly_all', percent: 40, resets_at: '2026-04-14T16:59:59Z' },
      { kind: 'weekly_scoped', percent: 7, resets_at: '2026-04-14T16:59:59Z', scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped' }, // no percent → skipped
    ],
  })
  const usage = await fetchClaudeUsage(claudeSession, fetchFn)
  assert.deepEqual(usage.windows, [
    { kind: 'session', usedPercent: 12, resetsAt: Date.parse('2026-04-08T18:59:59Z') },
    { kind: 'weekly', usedPercent: 40, resetsAt: Date.parse('2026-04-14T16:59:59Z') },
    { kind: 'weekly', scope: 'Opus', usedPercent: 7, resetsAt: Date.parse('2026-04-14T16:59:59Z') },
  ])
})

test('fetchGrokUsage maps the credits-config shape (weekly percent + reset)', async () => {
  const { fetchFn, requests } = fakeFetch({
    config: {
      creditUsagePercent: 2,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-11T10:14:00Z',
        end: '2026-08-18T10:14:00Z',
      },
    },
    subscriptionTier: 'SuperGrok Heavy',
  })
  const usage = await fetchGrokUsage(grokSession, fetchFn)
  assert.deepEqual(usage, {
    supported: true,
    plan: 'SuperGrok Heavy',
    windows: [
      { kind: 'weekly', usedPercent: 2, resetsAt: Date.parse('2026-08-18T10:14:00Z') },
    ],
  })
  assert.match(requests[0].url, /cli-chat-proxy\.grok\.com\/v1\/billing\?format=credits/)
  assert.equal(requests[0].headers['x-xai-token-auth'], 'xai-grok-cli')
  assert.equal(requests[0].headers.authorization, 'Bearer at')
})

test('fetchGrokUsage derives the percent from the legacy cent-valued shape', async () => {
  const { fetchFn } = fakeFetch({
    config: {
      monthlyLimit: { val: 2000 },
      used: { val: 500 },
      billingPeriodEnd: '2026-09-01T00:00:00Z',
    },
  })
  const usage = await fetchGrokUsage(grokSession, fetchFn)
  assert.deepEqual(usage.windows, [
    { kind: 'other', usedPercent: 25, resetsAt: Date.parse('2026-09-01T00:00:00Z') },
  ])
})

/** Build an unsigned JWT with the given payload (header.payload.sig, base64url). */
function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`
}

test('grokTierName maps the JWT tier claim to display names', () => {
  assert.equal(grokTierName(unsignedJwt({ tier: 0 })), 'Free')
  assert.equal(grokTierName(unsignedJwt({ tier: 1 })), 'SuperGrok')
  assert.equal(grokTierName(unsignedJwt({ tier: 3 })), 'X Premium')
  assert.equal(grokTierName(unsignedJwt({ tier: 5 })), 'SuperGrok Heavy')
  // Unknown numeric tiers surface as the raw number.
  assert.equal(grokTierName(unsignedJwt({ tier: 42 })), '42')
  // Missing/non-numeric claims and non-JWT tokens yield nothing.
  assert.equal(grokTierName(unsignedJwt({})), undefined)
  assert.equal(grokTierName(unsignedJwt({ tier: 'pro' })), undefined)
  assert.equal(grokTierName('opaque-token'), undefined)
})

test('fetchGrokUsage falls back to the access-token tier when billing omits subscriptionTier', async () => {
  const session: GrokSession = { ...grokSession, accessToken: unsignedJwt({ tier: 5 }) }
  const { fetchFn } = fakeFetch({
    config: {
      creditUsagePercent: 2,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-18T10:14:00Z' },
    },
  })
  const usage = await fetchGrokUsage(session, fetchFn)
  assert.equal(usage.plan, 'SuperGrok Heavy')
})

test('fetchGrokUsage tolerates a null config and non-2xx responses', async () => {
  const { fetchFn } = fakeFetch({ config: null })
  const usage = await fetchGrokUsage(grokSession, fetchFn)
  assert.deepEqual(usage, { supported: true, windows: [] })
  const { fetchFn: failing } = fakeFetch({ error: 'nope' }, 403)
  await assert.rejects(fetchGrokUsage(grokSession, failing), /grok billing/)
})

test('fetchGrokUsage extracts reset window when creditUsagePercent is absent but currentPeriod is present', async () => {
  const { fetchFn } = fakeFetch({
    config: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-10T12:00:00Z' },
    },
  })
  const usage = await fetchGrokUsage(grokSession, fetchFn)
  assert.ok(usage.windows)
  assert.equal(usage.windows.length, 1)
  assert.equal(usage.windows[0]?.kind, 'weekly')
  assert.equal(usage.windows[0]?.usedPercent, 0)
  assert.equal(usage.windows[0]?.resetsAt, Date.parse('2026-09-10T12:00:00Z'))
})

/** Mount the plugin with fake llm/connection; return the RPC handler. */
async function mount(): Promise<ConnectionRpcHandler> {
  let handler: ConnectionRpcHandler | undefined
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  ctx.provide('connection', {
    rpc: {
      handle: (_channel: string, h: ConnectionRpcHandler) => {
        handler = h
        return () => Promise.resolve()
      },
    },
  })
  ctx.plugin(plugin, { providers: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(handler !== undefined, 'the /subscriptions-auth channel was registered')
  return handler
}

test('usage endpoint: provider without a usage fetcher answers supported:false', async () => {
  const handler = await mount()
  // Only codex is registered, so grok never got a usage fetcher.
  const result = await handler('usage', { provider: 'grok', account: 'a1' }, new AbortController().signal)
  assert.deepEqual(result, { ok: true, value: { supported: false } })
})

test('usage endpoint: logged-out provider answers an error result', async () => {
  const handler = await mount()
  const result = await handler('usage', { provider: 'codex', account: 'a1' }, new AbortController().signal)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /not logged in/)
  }
})

test('usage endpoint: payload validation rejects unknown providers', async () => {
  const handler = await mount()
  const result = await handler('usage', { provider: 'gemini' }, new AbortController().signal)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'bad-request')
})

test('usage endpoint: payload validation rejects a non-boolean force flag', async () => {
  const handler = await mount()
  const result = await handler('usage', { provider: 'codex', account: 'a1', force: 'yes' }, new AbortController().signal)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'bad-request')
})

// ---------------------------------------------------------------------------
// SubscriptionsAuthController.usage(): delegation to the pool's usage cache.
// The RPC and mount() tests above only exercise the "no pool tracker yet"
// (logged-out) path; these construct the controller directly, the way
// login.spec.ts does, to prove the actual wiring fixed by issue #46 — a
// failing usage fetch must not be retried through an active cooldown, and a
// manual (forced) refresh must bypass a fresh cache without bypassing that
// cooldown.
// ---------------------------------------------------------------------------

/** A usage fetcher the delegation tests assert is never reached once a pool tracker is wired in. */
function unreachableFetcher(): Promise<ProviderUsage> {
  throw new Error('the raw fetcher must not be called once the pool usage cache is wired in')
}

test('usage(): delegates to the pool usage cache, which withholds retries through a 429 cooldown', async () => {
  let calls = 0
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const poolUsage = new PoolUsageTracker((provider, account) =>
    provider === 'codex' && account === 'a1' ? () => { calls += 1; return Promise.reject(error) } : undefined)
  const controller = new SubscriptionsAuthController(
    new OAuthFlowManager(), new DeviceFlowManager(), () => {}, () => undefined,
    { codex: unreachableFetcher }, undefined, poolUsage,
  )
  await assert.rejects(controller.usage('codex', 'a1', new AbortController().signal), error)
  assert.equal(calls, 1)
  await assert.rejects(controller.usage('codex', 'a1', new AbortController().signal), error)
  assert.equal(calls, 1, 'a second call inside the retry-after window must not hit the network again')
})

test('usage(): a manual (forced) refresh bypasses a fresh cached snapshot, not a live cooldown', async () => {
  let calls = 0
  const usage: ProviderUsage = { supported: true, windows: [] }
  const poolUsage = new PoolUsageTracker((provider, account) =>
    provider === 'codex' && account === 'a1' ? () => { calls += 1; return Promise.resolve(usage) } : undefined)
  const controller = new SubscriptionsAuthController(
    new OAuthFlowManager(), new DeviceFlowManager(), () => {}, () => undefined,
    { codex: unreachableFetcher }, undefined, poolUsage,
  )
  await controller.usage('codex', 'a1', new AbortController().signal)
  await controller.usage('codex', 'a1', new AbortController().signal)
  assert.equal(calls, 1, 'a plain call reuses the fresh cache')
  await controller.usage('codex', 'a1', new AbortController().signal, true)
  assert.equal(calls, 2, 'a forced call re-checks despite the fresh cache')
})

test('usage(): with no pool tracker (pool disabled), every call hits the raw fetcher directly', async () => {
  let calls = 0
  const controller = new SubscriptionsAuthController(
    new OAuthFlowManager(), new DeviceFlowManager(), () => {}, () => undefined,
    { codex: async () => { calls += 1; return { supported: true, windows: [] } } },
  )
  await controller.usage('codex', 'a1', new AbortController().signal)
  await controller.usage('codex', 'a1', new AbortController().signal)
  assert.equal(calls, 2, 'unchanged prior behavior when the pool usage cache is unavailable')
})
