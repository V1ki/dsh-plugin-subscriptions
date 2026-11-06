import test from 'node:test'
import assert from 'node:assert/strict'

import { responsesFailure, ResponsesStreamTranslator } from '../src/translate/responses.js'
import { QUOTA_EXCEEDED_CODE, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { ResponsesStreamEvent } from '../src/translate/responses.js'

/** The exact payload shape observed from chatgpt.com/backend-api/codex. */
const OVERLOADED_EVENT: ResponsesStreamEvent = {
  type: 'error',
  error: {
    code: 'server_is_overloaded',
    message: 'Our servers are currently overloaded. Please try again later.',
    headers: { 'retry-after': '314', 'retry-after-ms': '314000' },
  },
}

test('responsesFailure: upstream retry-after-ms becomes providerRetryAfterMs', () => {
  const error = responsesFailure('server_is_overloaded', 'busy', { 'retry-after-ms': '314000' })
  assert.equal(error.code, 'SERVER')
  assert.equal(error.failure.providerRetryAfterMs, 314000)
})

test('responsesFailure: retry-after seconds are converted to ms', () => {
  const error = responsesFailure('server_is_overloaded', 'busy', { 'retry-after': '120' })
  assert.equal(error.failure.providerRetryAfterMs, 120000)
})

test('responsesFailure: retry-after-ms wins over retry-after', () => {
  const error = responsesFailure('busy', 'busy', { 'retry-after': '1', 'retry-after-ms': '250000' })
  assert.equal(error.failure.providerRetryAfterMs, 250000)
})

test('responsesFailure: a payload without headers invents no backoff', () => {
  const error = responsesFailure('server_is_overloaded', 'busy', undefined)
  assert.equal(error.failure.providerRetryAfterMs, undefined)
})

test('responsesFailure: unusable header values are ignored, not propagated', () => {
  for (const headers of [{ 'retry-after': 'not-a-number' }, { 'retry-after': '0' }, { 'retry-after': '-5' }, 'nope', null]) {
    const error = responsesFailure('server_is_overloaded', 'busy', headers)
    assert.equal(error.failure.providerRetryAfterMs, undefined, `headers ${JSON.stringify(headers)}`)
  }
})

test('responsesFailure: context-window and quota semantics are unchanged', () => {
  assert.equal(responsesFailure('context_window_exceeded', 'too long').code, CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.equal(responsesFailure('insufficient_quota', 'no quota').code, QUOTA_EXCEEDED_CODE)
})

test('error event: the nested error payload is what reaches the thrown error', () => {
  const translator = new ResponsesStreamTranslator()
  assert.throws(
    () => translator.push(OVERLOADED_EVENT),
    (error: unknown) => {
      const llmError = error as { message: string; code: string; failure: { providerRetryAfterMs?: number } }
      // The old code produced 'the provider reported a failed response' here.
      assert.equal(llmError.message, 'Our servers are currently overloaded. Please try again later.')
      assert.equal(llmError.code, 'SERVER')
      assert.equal(llmError.failure.providerRetryAfterMs, 314000)
      return true
    },
  )
})

test('error event: a flat payload (Copilot-style) still resolves', () => {
  const translator = new ResponsesStreamTranslator()
  assert.throws(
    () => translator.push({ type: 'error', code: 'server_error', message: 'upstream fell over' }),
    (error: unknown) => {
      const llmError = error as { message: string }
      assert.equal(llmError.message, 'upstream fell over')
      return true
    },
  )
})

test('malformed millisecond hints fall back to valid seconds without changing units', () => {
  for (const ms of [null, '', 'junk', -1, false, [], {}, '9e99']) {
    assert.equal(responsesFailure('busy', 'busy', { 'retry-after-ms': ms, 'retry-after': '120' }).failure.providerRetryAfterMs, 120000)
  }
})
