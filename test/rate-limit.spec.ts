/**
 * Rate-limit window handling: the shared value/duration/date parsing, each
 * provider's reset reader against its own 429 shapes, the classification of a
 * 429 as RATE_LIMIT ahead of the quota-wording check, and the retry policy
 * whose delay ceiling decides how long a route may hold a turn open.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpLlmError, TokenManager } from '../src/providers/common.js'
import {
  DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  DEFAULT_RETRY,
  durationMs,
  earliestReset,
  jsonBody,
  resetFromFields,
  resetInstantFromNumber,
  resetInstantFromValue,
  resolveRateLimitWait,
  retryAfterInstant,
  subscriptionRetryPolicy,
  waitFromReset,
} from '../src/providers/rate-limit.js'
import { claudeRateLimitReset, ClaudeAdapter } from '../src/providers/claude.js'
import { codexRateLimitReset, CodexAdapter } from '../src/providers/codex.js'
import { grokRateLimitReset, GrokAdapter } from '../src/providers/grok.js'
import type { ClaudeSession, CodexSession, GrokSession } from '../src/auth/store.js'

/** A fixed clock, so every expectation is an exact number rather than a window. */
const NOW = 1_800_000_000_000

/** Builds a failed response with the given headers and body. */
function failure(status: number, headers: Record<string, string>, body = ''): Response {
  return new Response(body, { status, headers })
}

/** A TokenManager over an in-memory session; these tests never refresh. */
function memoryTokens<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  initial: S,
): TokenManager<S> {
  let stored: S | undefined = initial
  return new TokenManager<S>({
    displayName: 'Test',
    preemptMs: 0,
    load: () => Promise.resolve(stored),
    save: (session) => {
      stored = session
      return Promise.resolve()
    },
    remove: () => {
      stored = undefined
      return Promise.resolve()
    },
    refresh: session => Promise.resolve(session),
    isPermanent: () => false,
  })
}

const claudeSession: ClaudeSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW, scopes: 's' }
const codexSession: CodexSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW, accountId: 'a' }
const grokSession: GrokSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: NOW,
  tokenEndpoint: 'https://auth.x.ai/token',
}

test('a bare number is read as epoch ms, epoch seconds, or a delay by magnitude', () => {
  assert.equal(resetInstantFromNumber(NOW + 5_000, NOW), NOW + 5_000)
  assert.equal(resetInstantFromNumber(1_800_000_300, NOW), 1_800_000_300_000)
  assert.equal(resetInstantFromNumber(300, NOW), NOW + 300_000)
  // A full week as a delay still stays below the epoch-seconds floor.
  assert.equal(resetInstantFromNumber(604_800, NOW), NOW + 604_800_000)
  assert.equal(resetInstantFromNumber(0, NOW), undefined)
  assert.equal(resetInstantFromNumber(-5, NOW), undefined)
  assert.equal(resetInstantFromNumber(Number.NaN, NOW), undefined)
})

test('durations parse in the Go form the OpenAI-compatible headers use', () => {
  assert.equal(durationMs('6m0s'), 360_000)
  assert.equal(durationMs('1h2m3s'), 3_723_000)
  assert.equal(durationMs('1.5s'), 1_500)
  assert.equal(durationMs('150ms'), 150)
  assert.equal(durationMs(' 2m '), 120_000)
  assert.equal(durationMs('6m0s later'), undefined)
  assert.equal(durationMs('soon'), undefined)
  assert.equal(durationMs(''), undefined)
})

test('a single value is read in every shape a provider might encode it in', () => {
  assert.equal(resetInstantFromValue(300, NOW), NOW + 300_000)
  assert.equal(resetInstantFromValue('300', NOW), NOW + 300_000)
  assert.equal(resetInstantFromValue('6m0s', NOW), NOW + 360_000)
  assert.equal(resetInstantFromValue('2027-01-15T10:30:00Z', NOW), Date.parse('2027-01-15T10:30:00Z'))
  assert.equal(resetInstantFromValue(null, NOW), undefined)
  assert.equal(resetInstantFromValue({ nested: 1 }, NOW), undefined)
  assert.equal(resetInstantFromValue('whenever', NOW), undefined)
})

test('retry-after reads a delay in seconds or an HTTP-date, never an epoch stamp', () => {
  assert.equal(retryAfterInstant(failure(429, { 'retry-after': '120' }), NOW), NOW + 120_000)
  // A large number stays a delay here, unlike a bare rate-limit field.
  assert.equal(retryAfterInstant(failure(429, { 'retry-after': '1800000000' }), NOW), NOW + 1_800_000_000_000)
  const date = 'Wed, 21 Oct 2026 07:28:00 GMT'
  assert.equal(retryAfterInstant(failure(429, { 'retry-after': date }), NOW), Date.parse(date))
  assert.equal(retryAfterInstant(failure(429, {}), NOW), undefined)
  assert.equal(retryAfterInstant(failure(429, { 'retry-after': '0' }), NOW), undefined)
})

test('a reset instant becomes a wait with clock-skew grace and a floor', () => {
  assert.equal(waitFromReset(NOW + 300_000, NOW), 302_000)
  // Already past: still scheduled, at the floor.
  assert.equal(waitFromReset(NOW - 60_000, NOW), 1_000)
  // Never capped here: an over-ceiling wait must reach the policy to be refused.
  assert.equal(waitFromReset(NOW + 7 * 24 * 3_600_000, NOW), 7 * 24 * 3_600_000 + 2_000)
})

test('a body field is found wherever the provider nests it', () => {
  const body = jsonBody('{"detail":{"type":"usage_limit_reached","resets_in_seconds":9000}}')
  assert.equal(resetFromFields(body, ['resets_in_seconds'], NOW), NOW + 9_000_000)
  assert.equal(resetFromFields(jsonBody('{"resets_in_seconds":60}'), ['resets_in_seconds'], NOW), NOW + 60_000)
  // The earliest of several matches wins.
  const many = jsonBody('{"a":{"resets_at":1800000600},"b":{"resets_at":1800000300}}')
  assert.equal(resetFromFields(many, ['resets_at'], NOW), 1_800_000_300_000)
  assert.equal(resetFromFields(jsonBody('{"other":5}'), ['resets_at'], NOW), undefined)
  assert.equal(jsonBody('<html>502</html>'), undefined)
})

test('earliestReset ignores absent candidates', () => {
  assert.equal(earliestReset(undefined, NOW + 10, undefined, NOW + 5), NOW + 5)
  assert.equal(earliestReset(undefined, undefined), undefined)
})

test('claude: the unified subscription window wins over the per-bucket headers', () => {
  const response = failure(429, {
    'anthropic-ratelimit-unified-reset': '1800009000',
    'anthropic-ratelimit-requests-reset': '2027-01-15T10:30:00Z',
  })
  assert.equal(claudeRateLimitReset(response, '', NOW), 1_800_009_000_000)
})

test('claude: the earliest per-bucket reset is used when no unified window is named', () => {
  const response = failure(429, {
    'anthropic-ratelimit-requests-reset': '2027-01-15T10:30:00Z',
    'anthropic-ratelimit-tokens-reset': '2026-09-01T00:00:00Z',
  })
  assert.equal(claudeRateLimitReset(response, '', NOW), Date.parse('2026-09-01T00:00:00Z'))
})

test('claude: a header-less rejection falls back to a reset named in the body', () => {
  const body = '{"type":"error","error":{"type":"rate_limit_error","resets_at":1800003600}}'
  assert.equal(claudeRateLimitReset(failure(429, {}), body, NOW), 1_800_003_600_000)
  assert.equal(claudeRateLimitReset(failure(429, {}), '{"type":"error"}', NOW), undefined)
})

test('codex: the exhausted window in the body wins over the snapshot headers', () => {
  const response = failure(429, { 'x-codex-primary-reset-after-seconds': '30' })
  const body = '{"detail":{"type":"usage_limit_reached","resets_in_seconds":9000,"plan_type":"plus"}}'
  assert.equal(codexRateLimitReset(response, body, NOW), NOW + 9_000_000)
})

test('codex: the snapshot headers serve when the body names nothing', () => {
  const response = failure(429, {
    'x-codex-primary-reset-after-seconds': '900',
    'x-codex-secondary-reset-after-seconds': '90000',
  })
  assert.equal(codexRateLimitReset(response, '{"detail":"slow down"}', NOW), NOW + 900_000)
})

test('grok: the OpenAI-compatible reset headers are read as durations', () => {
  const response = failure(429, {
    'x-ratelimit-reset-requests': '6m0s',
    'x-ratelimit-reset-tokens': '1h',
  })
  assert.equal(grokRateLimitReset(response, '', NOW), NOW + 360_000)
})

test('grok: a body-named retry delay serves when no header carries one', () => {
  assert.equal(grokRateLimitReset(failure(429, {}), '{"error":{"retry_after":45}}', NOW), NOW + 45_000)
  assert.equal(grokRateLimitReset(failure(429, {}), '{"error":"rate limited"}', NOW), undefined)
})

test('a 429 classifies as RATE_LIMIT even when the wording reads as terminal quota', async () => {
  const body = '{"detail":{"type":"usage_limit_reached","resets_in_seconds":9000,"plan_type":"plus"}}'
  const error = await httpLlmError(failure(429, {}, body), 'codex API', {
    rateLimitReset: codexRateLimitReset,
  })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs > 8_990_000)
})

test('quota wording still classifies as QUOTA on any other status', async () => {
  const error = await httpLlmError(failure(402, {}, 'Weekly usage limit exceeded'), 'codex API')
  assert.equal(error.code, 'QUOTA')
})

test('a rate-limit reset survives a body longer than the truncated message', async () => {
  const padding = 'x'.repeat(2_000)
  const body = JSON.stringify({ note: padding, detail: { resets_in_seconds: 600 } })
  const error = await httpLlmError(failure(429, {}, body), 'codex API', {
    rateLimitReset: codexRateLimitReset,
  })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs > 590_000)
  // The message itself stays truncated.
  assert.ok(error.message.length < 600)
})

test("the provider's own field beats a short retry-after on the same response", async () => {
  const response = failure(429, {
    'retry-after': '60',
    'anthropic-ratelimit-unified-reset': String(Math.floor(NOW / 1_000) + 9_000),
  }, '')
  const error = await httpLlmError(response, 'claude API', { rateLimitReset: claudeRateLimitReset })
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs > 8_000_000, 'the window reset, not the 60s backoff')
})

test('retry-after still serves a provider that disclosed nothing else', async () => {
  const error = await httpLlmError(failure(429, { 'retry-after': '30' }, ''), 'grok API', {
    rateLimitReset: grokRateLimitReset,
  })
  assert.ok(error.failure.providerRetryAfterMs !== undefined)
  assert.ok(error.failure.providerRetryAfterMs >= 30_000)
})

test('a 429 that disclosed no reset warns with the headers that would have carried one', async () => {
  const warnings: string[] = []
  const response = failure(429, {
    'x-ratelimit-remaining-requests': '0',
    'content-type': 'application/json',
  }, '{"error":"slow down"}')
  const error = await httpLlmError(response, 'grok API', {
    rateLimitReset: grokRateLimitReset,
    onWarn: message => warnings.push(message),
  })
  assert.equal(error.failure.providerRetryAfterMs, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /grok API: 429 disclosed no reset time/)
  assert.match(warnings[0], /x-ratelimit-remaining-requests: 0/)
  assert.match(warnings[0], /slow down/)
  // Headers that say nothing about rate limits stay out of the diagnostic.
  assert.doesNotMatch(warnings[0], /content-type/)
})

test('a non-429 failure never emits the rate-limit diagnostic', async () => {
  const warnings: string[] = []
  await httpLlmError(failure(500, {}, 'boom'), 'grok API', { onWarn: message => warnings.push(message) })
  assert.deepEqual(warnings, [])
})

test('waiting widens the delay ceiling to the configured maximum', () => {
  const policy = subscriptionRetryPolicy(
    DEFAULT_RETRY,
    { wait: true, maxWaitMs: 6 * 3_600_000 },
    'test: retryPolicy',
  )
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxDelayMs, 6 * 3_600_000)
  assert.equal(policy.initialDelayMs, DEFAULT_RETRY.initialDelayMs)
  assert.equal(policy.mode === 'normal' && policy.maxRetries, DEFAULT_RETRY.maxRetries)
  assert.ok(policy.mode === 'normal' && policy.retryableCodes.includes('RATE_LIMIT'))
})

test('opting out of waiting restores the route defaults exactly', () => {
  const policy = subscriptionRetryPolicy(
    DEFAULT_RETRY,
    { wait: false, maxWaitMs: 6 * 3_600_000 },
    'test: retryPolicy',
  )
  assert.equal(policy.maxDelayMs, DEFAULT_RETRY.maxDelayMs)
})

test('a wait ceiling below the local backoff ceiling never shortens local backoff', () => {
  const policy = subscriptionRetryPolicy(
    { maxRetries: 10, initialDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0.2 },
    { wait: true, maxWaitMs: 5_000 },
    'test: retryPolicy',
  )
  assert.equal(policy.maxDelayMs, 60_000)
})

test('rate-limit waiting defaults to on with a six-hour ceiling', () => {
  assert.deepEqual(resolveRateLimitWait(undefined, 'config: rateLimit'), {
    wait: true,
    maxWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  })
  assert.deepEqual(resolveRateLimitWait({ wait: false }, 'config: rateLimit'), {
    wait: false,
    maxWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  })
  assert.throws(
    () => resolveRateLimitWait({ maxWaitMs: 0 }, 'config: rateLimit'),
    /rateLimit.maxWaitMs must be a positive finite number/,
  )
  assert.throws(
    () => resolveRateLimitWait({ maxWaitMs: 30 * 24 * 3_600_000 }, 'config: rateLimit'),
    /maximum schedulable delay/,
  )
})

test('every route reports a policy able to hold the configured wait', () => {
  const rateLimit = { wait: true, maxWaitMs: 4 * 3_600_000 }
  const claude = new ClaudeAdapter({
    models: [{ id: 'claude-opus-5' }],
    streamIdleTimeoutMs: 1_000,
    tokens: memoryTokens(claudeSession),
    discovery: false,
    rateLimit,
  })
  const codex = new CodexAdapter({
    models: [{ id: 'gpt-5.1-codex' }],
    streamIdleTimeoutMs: 1_000,
    tokens: memoryTokens(codexSession),
    discovery: false,
    rateLimit,
  })
  const grok = new GrokAdapter({
    models: [{ id: 'grok-4' }],
    streamIdleTimeoutMs: 1_000,
    tokens: memoryTokens(grokSession),
    discovery: false,
    rateLimit,
  })
  for (const [route, adapter] of [['claude', claude], ['codex', codex], ['grok', grok]] as const) {
    const policy = adapter.providerRetryPolicy(route)
    assert.ok(policy !== undefined, `${route} reports a policy`)
    assert.equal(policy.maxDelayMs, 4 * 3_600_000, `${route} accepts the configured wait`)
  }
  // Claude keeps Claude Code's own retry budget.
  const claudePolicy = claude.providerRetryPolicy('claude')
  assert.equal(claudePolicy?.mode === 'normal' && claudePolicy.maxRetries, 10)
})
