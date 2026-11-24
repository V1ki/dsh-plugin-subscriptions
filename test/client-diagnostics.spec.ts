import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { resetWarnings, warnOnce } from '../src/client/diagnostics.js'

afterEach(() => { resetWarnings() })

test('a repeated composer-control failure is logged once per distinct message', () => {
  const lines: string[] = []
  const original = console.warn
  console.warn = (message?: unknown) => { lines.push(String(message)) }
  try {
    warnOnce('speed', 'reading the session model', new Error('model selection is unavailable'))
    warnOnce('speed', 'reading the session model', new Error('model selection is unavailable'))
    warnOnce('speed', 'reading the session model', 'plain rejection')
    warnOnce('usage-badge', 'reading the session model', new Error('model selection is unavailable'))
  } finally {
    console.warn = original
  }
  assert.equal(lines.length, 3)
  assert.match(lines[0]!, /\[dsh-plugin-subscriptions\] speed: reading the session model failed/)
  assert.match(lines[0]!, /model selection is unavailable/)
  assert.match(lines[1]!, /plain rejection/)
  assert.match(lines[2]!, /usage-badge/)
})
