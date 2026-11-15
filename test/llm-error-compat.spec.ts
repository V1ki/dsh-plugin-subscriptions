import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { httpLlmError, llmErrorFromFailure } from '../src/providers/common.js'

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
