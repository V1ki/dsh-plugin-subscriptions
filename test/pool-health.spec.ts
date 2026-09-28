/**
 * Pool health bookkeeping: failure classification (which error codes switch
 * members, with what cooldown, and which rethrow) and the cooldown registry
 * (expiry, longest-cooldown-wins, per-provider and per-account clear).
 * Records are account-granular: one account's cooldown never parks another
 * account of the same provider.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  accountKey,
  AUTH_COOLDOWN_MS,
  classifyPoolFailure,
  DEFAULT_QUOTA_COOLDOWN_MS,
  memberKey,
  PoolHealthRegistry,
  TRANSIENT_COOLDOWN_MS,
} from '../src/providers/pool-health.js'

test('classifyPoolFailure: quota and rate-limit cool the whole account (account-level quota)', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('quota', 'QUOTA'), 'codex'), {
    action: 'switch',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: 'QUOTA',
    scope: 'account',
  })
  assert.deepEqual(classifyPoolFailure(new LlmError('limited', 'RATE_LIMIT'), 'grok'), {
    action: 'switch',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: 'RATE_LIMIT',
    scope: 'account',
  })
})

test('classifyPoolFailure: claude quota failures stay member-scoped (per-model lanes)', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('quota', 'QUOTA'), 'claude'), {
    action: 'switch',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: 'QUOTA',
    scope: 'member',
  })
})

test('classifyPoolFailure: an Antigravity quota parks only the exhausted model', () => {
  // One model's 35-hour quota reset must not park the account's other models.
  const error = new LlmError('quota', 'RATE_LIMIT', { providerRetryAfterMs: 35 * 3_600_000 })
  assert.deepEqual(classifyPoolFailure(error, 'antigravity'), {
    action: 'switch',
    cooldownMs: 35 * 3_600_000,
    reason: 'RATE_LIMIT',
    scope: 'member',
  })
})

test('classifyPoolFailure: the provider retry-after wins over the default cooldown', () => {
  const error = new LlmError('slow down', 'RATE_LIMIT', { providerRetryAfterMs: 42_000 })
  assert.deepEqual(classifyPoolFailure(error, 'codex'), {
    action: 'switch',
    cooldownMs: 42_000,
    reason: 'RATE_LIMIT',
    scope: 'account',
  })
})

test('classifyPoolFailure: auth failures park the account until re-login', () => {
  for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('denied', code), 'claude'), {
      action: 'switch',
      cooldownMs: AUTH_COOLDOWN_MS,
      reason: code,
      scope: 'account',
    })
  }
})

test('classifyPoolFailure: transient server failures cool the member briefly', () => {
  for (const code of ['SERVER', 'TIMEOUT', 'EMPTY_RESPONSE']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('oops', code), 'codex'), {
      action: 'switch',
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      reason: code,
      scope: 'member',
    })
  }
})

test('classifyPoolFailure: transport failures switch without a health record', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('dns', 'TRANSPORT'), 'codex'), { action: 'switch' })
})

test('classifyPoolFailure: plan/model availability switches the member', () => {
  for (const code of ['HTTP_402', 'HTTP_404']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('unavailable', code), 'codex'), {
      action: 'switch',
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      reason: code,
      scope: 'member',
    })
  }
})

test('classifyPoolFailure: request-fault and unknown failures rethrow', () => {
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'HTTP_400']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('bad request', code), 'codex'), { action: 'throw' })
  }
  assert.deepEqual(classifyPoolFailure(new Error('plain'), 'codex'), { action: 'throw' })
  assert.deepEqual(classifyPoolFailure('string failure', 'codex'), { action: 'throw' })
})

test('PoolHealthRegistry: members cool down and recover on expiry', () => {
  const registry = new PoolHealthRegistry()
  const key = memberKey('codex', 'a1', 'gpt-5.4')
  assert.equal(registry.isAvailable(key, 1000), true)
  registry.markUnavailable(key, 5000, 'QUOTA', 1000)
  assert.equal(registry.isAvailable(key, 5999), false)
  assert.equal(registry.isAvailable(key, 6000), true)
})

test('PoolHealthRegistry: a longer existing cooldown wins', () => {
  const registry = new PoolHealthRegistry()
  const key = memberKey('claude', 'a1', 'claude-sonnet-5')
  registry.markUnavailable(key, 10_000, 'QUOTA', 0)
  registry.markUnavailable(key, 1000, 'SERVER', 0)
  assert.equal(registry.isAvailable(key, 5000), false)
  assert.equal(registry.isAvailable(key, 10_000), true)
})

test('PoolHealthRegistry: an account-wide record parks every member of the account only', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(accountKey('codex', 'a1'), 60_000, 'RATE_LIMIT', 0)
  assert.equal(registry.isMemberAvailable('codex', 'a1', 'gpt-5.4', 1000), false)
  assert.equal(registry.isMemberAvailable('codex', 'a1', 'gpt-5.4-mini', 1000), false)
  // Another account of the same provider and other providers are untouched.
  assert.equal(registry.isMemberAvailable('codex', 'a2', 'gpt-5.4', 1000), true)
  assert.equal(registry.isMemberAvailable('claude', 'a1', 'claude-sonnet-5', 1000), true)
  assert.equal(registry.isMemberAvailable('codex', 'a1', 'gpt-5.4', 60_000), true)
})

test('PoolHealthRegistry: earliestRecovery reports the soonest expiry among the given keys', () => {
  const registry = new PoolHealthRegistry()
  const keys = new Set([memberKey('codex', 'a1', 'a'), memberKey('claude', 'a1', 'b')])
  assert.equal(registry.earliestRecovery(keys, 0), undefined)
  registry.markUnavailable(memberKey('codex', 'a1', 'a'), 9000, 'QUOTA', 0)
  registry.markUnavailable(memberKey('claude', 'a1', 'b'), 3000, 'QUOTA', 0)
  assert.equal(registry.earliestRecovery(keys, 0), 3000)
  // Expired records are dropped, not reported.
  assert.equal(registry.earliestRecovery(keys, 5000), 9000)
})

test('PoolHealthRegistry: earliestRecovery ignores records outside the given keys', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(memberKey('grok', 'a1', 'other-pool-member'), 1000, 'QUOTA', 0)
  registry.markUnavailable(memberKey('codex', 'a1', 'a'), 9000, 'QUOTA', 0)
  const keys = new Set([memberKey('codex', 'a1', 'a'), accountKey('codex', 'a1')])
  // The unrelated pool's sooner recovery must not shape this pool's hint.
  assert.equal(registry.earliestRecovery(keys, 0), 9000)
})

test('PoolHealthRegistry: clear drops one account, or the whole provider when no account is given', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(memberKey('codex', 'a1', 'a'), 60_000, 'AUTH', 0)
  registry.markUnavailable(accountKey('codex', 'a1'), 60_000, 'AUTH', 0)
  registry.markUnavailable(memberKey('codex', 'a2', 'a'), 60_000, 'AUTH', 0)
  registry.markUnavailable(memberKey('claude', 'a1', 'c'), 60_000, 'AUTH', 0)
  registry.clear('codex', 'a1')
  assert.equal(registry.isMemberAvailable('codex', 'a1', 'a', 0), true)
  assert.equal(registry.isMemberAvailable('codex', 'a2', 'a', 0), false)
  registry.clear('codex')
  assert.equal(registry.isMemberAvailable('codex', 'a2', 'a', 0), true)
  assert.equal(registry.isMemberAvailable('claude', 'a1', 'c', 0), false)
})
