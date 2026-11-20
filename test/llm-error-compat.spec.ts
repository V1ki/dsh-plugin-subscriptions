import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ACCOUNT_SUSPENDED_CODE, httpLlmError, llmErrorFromFailure } from '../src/providers/common.js'

/**
 * The 403 Antigravity and Cloud Code Private API answer with once an account is
 * banned for a terms-of-service violation, reproduced verbatim.
 */
const SUSPENDED_BODY = '{"error":{"code":403,"message":"This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"TOS_VIOLATION","domain":"cloudcode-pa.googleapis.com","metadata":{"uiMessage":"true","appeal_url":"https://forms.gle/hGzM9MEUv2azZsrb9","appeal_url_link_text":"Submit Appeal"}}]}}'

test('external failures preserve their code, provider facts and cause on current and legacy hosts', () => {
  const failure = { code: 'EXTERNAL_PROVIDER_FAILURE', message: 'upstream failed', status: 418, providerRetryAfterMs: 2345 }
  const cause = new Error('original')
  const check = () => {
    const error = llmErrorFromFailure(failure, { cause })
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, failure.code)
    assert.deepEqual(error.failure, failure)
    assert.equal(error.cause, cause)
  }
  check()
  // Simulate a supported older runtime that has no static fromFailure.
  const descriptor = Object.getOwnPropertyDescriptor(LlmError, 'fromFailure')
  try {
    Object.defineProperty(LlmError, 'fromFailure', { value: undefined, configurable: true })
    check()
  } finally {
    if (descriptor === undefined) delete (LlmError as unknown as { fromFailure?: unknown }).fromFailure
    else Object.defineProperty(LlmError, 'fromFailure', descriptor)
  }
})

test('unclassified HTTP responses retain their HTTP code and status', async () => {
  const error = await httpLlmError(new Response('no tea', { status: 418 }), 'fixture')
  assert.equal(error.code, 'HTTP_418')
  assert.equal(error.failure.status, 418)
})

test('a 403 for a terms-of-service violation surfaces as a suspended account', async () => {
  const error = await httpLlmError(new Response(SUSPENDED_BODY, { status: 403 }), 'antigravity')
  // A ban is not an auth failure: the chat surface renders `AUTH` as an invalid
  // API key, which hid the real reason and sent users into re-login loops.
  assert.equal(error.code, ACCOUNT_SUSPENDED_CODE)
  assert.equal(error.code, 'ACCOUNT_SUSPENDED')
  assert.equal(error.failure.status, 403)
  assert.ok(error.message.includes(SUSPENDED_BODY.slice(0, 500)), 'the original body must reach the message')
})

test('a suspension past the displayed prefix is still classified', async () => {
  // The message is truncated for display, so classification must read the whole
  // body: here the reason sits beyond the first 500 characters.
  const padded = `{"error":{"message":"${'x'.repeat(600)}","details":[{"reason":"TOS_VIOLATION"}]}}`
  const error = await httpLlmError(new Response(padded, { status: 403 }), 'antigravity')
  assert.equal(error.code, ACCOUNT_SUSPENDED_CODE)
  assert.ok(!error.message.includes('TOS_VIOLATION'), 'the displayed message stays truncated')
})

test('a 403 without the ToS reason stays an auth failure', async () => {
  const error = await httpLlmError(new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }), 'antigravity')
  assert.equal(error.code, 'AUTH')
  assert.equal(error.failure.status, 403)
})

test('a 401 stays an auth failure whatever its body says', async () => {
  // A disabled account answers 403; an unauthorized credential answers 401 and
  // keeps the auth classification even when its body echoes the ToS wording.
  const error = await httpLlmError(new Response(SUSPENDED_BODY, { status: 401 }), 'antigravity')
  assert.equal(error.code, 'AUTH')
  assert.equal(error.failure.status, 401)
})
