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

import { OAuthEndpointError, retryAfterMs } from '../src/providers/common.js'
import type { FetchFn } from '../src/providers/common.js'
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

/**
 * A fetch implementation answering one JSON payload; records the request.
 * @param responseHeaders - headers to answer with (e.g. `retry-after` on a 429).
 */
function fakeFetch(payload: unknown, status = 200, responseHeaders?: Record<string, string>): {
  fetchFn: FetchFn
  requests: { url: string; headers: Record<string, string> }[]
} {
  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetchFn: FetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
    requests.push({ url: String(url), headers })
    return Promise.resolve(new Response(JSON.stringify(payload), {
      status,
      ...responseHeaders === undefined ? {} : { headers: responseHeaders },
    }))
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

test('fetchClaudeUsage reports the plan from the stored subscription type', async () => {
  // The usage payload names no tier (unlike codex's plan_type), so the plan
  // rides the session; both response shapes must carry it.
  const modern = fakeFetch({
    limits: [{ kind: 'weekly_all', percent: 40, resets_at: '2026-04-14T16:59:59Z' }],
  })
  const withPlan = { ...claudeSession, subscriptionType: 'max' }
  assert.equal((await fetchClaudeUsage(withPlan, modern.fetchFn)).plan, 'Max')

  const legacy = fakeFetch({ five_hour: { utilization: 6, resets_at: null } })
  assert.equal((await fetchClaudeUsage(withPlan, legacy.fetchFn)).plan, 'Max')
})

test('fetchClaudeUsage omits the plan when the session names none', async () => {
  const { fetchFn } = fakeFetch({
    limits: [{ kind: 'weekly_all', percent: 40, resets_at: '2026-04-14T16:59:59Z' }],
  })
  const usage = await fetchClaudeUsage(claudeSession, fetchFn)
  assert.equal('plan' in usage, false)
  const blank = await fetchClaudeUsage({ ...claudeSession, subscriptionType: '   ' }, fakeFetch({
    limits: [{ kind: 'weekly_all', percent: 40 }],
  }).fetchFn)
  assert.equal('plan' in blank, false)
})

test('retryAfterMs reads both header forms and refuses past deadlines', () => {
  const now = 1_700_000_000_000
  assert.equal(retryAfterMs('120'), 120_000)
  assert.equal(retryAfterMs('0'), undefined)
  assert.equal(retryAfterMs(null), undefined)
  assert.equal(retryAfterMs('   '), undefined)
  assert.equal(retryAfterMs('tomorrow'), undefined)
  assert.equal(retryAfterMs(new Date(now + 60_000).toUTCString(), now), 60_000)
  assert.equal(retryAfterMs(new Date(now - 60_000).toUTCString(), now), undefined)
})

test('a rate-limited usage lookup surfaces the provider retry delay', async () => {
  // The `internal` RpcResult branch types `details` as an empty object
  // upstream, so the delay rides the message; a caller backing off on 429 can
  // then honour the interval the provider actually asked for.
  const { fetchFn } = fakeFetch({ error: 'rate_limited' }, 429, { 'retry-after': '300' })
  const error = await fetchClaudeUsage(claudeSession, fetchFn).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof OAuthEndpointError)
  assert.equal(error.status, 429)
  assert.equal(error.retryAfterMs, 300_000)
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
  const result = await handler('usage', { provider: 'grok' }, new AbortController().signal)
  assert.deepEqual(result, { ok: true, value: { supported: false } })
})

test('usage endpoint: logged-out provider answers an error result', async () => {
  const handler = await mount()
  const result = await handler('usage', { provider: 'codex' }, new AbortController().signal)
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
