/**
 * Runtime detection of the locally installed Claude Code CLI version and
 * beta flags.  Exercises both the happy path (claude binary on $PATH) and
 * the fallback path (binary absent or broken).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  detectClaudeVersion,
  CLAUDE_CLI_FALLBACK_VERSION,
  CLAUDE_BETA_FALLBACK,
} from '../src/providers/claude.js'

// ---------------------------------------------------------------------------
// detectClaudeVersion
// ---------------------------------------------------------------------------

test('detectClaudeVersion returns a semver-shaped string', () => {
  const version = detectClaudeVersion()
  assert.match(version, /^\d+\.\d+\.\d+$/, `expected semver, got "${version}"`)
})

test('detectClaudeVersion fallback is a valid semver', () => {
  assert.match(CLAUDE_CLI_FALLBACK_VERSION, /^\d+\.\d+\.\d+$/)
})

test('detectClaudeVersion returns the fallback when claude is not in PATH', () => {
  // Temporarily break PATH so `claude` cannot be found.
  const original = process.env.PATH
  try {
    process.env.PATH = ''
    const version = detectClaudeVersion()
    assert.equal(version, CLAUDE_CLI_FALLBACK_VERSION)
  } finally {
    process.env.PATH = original
  }
})

test('detectClaudeVersion falls back silently without logging when claude is absent', () => {
  const originalPath = process.env.PATH
  const originalDebug = console.debug
  const originalWarn = console.warn
  const originalError = console.error
  const calls: string[] = []
  console.debug = (...args: unknown[]) => { calls.push(`debug:${args.map(String).join(' ')}`) }
  console.warn = (...args: unknown[]) => { calls.push(`warn:${args.map(String).join(' ')}`) }
  console.error = (...args: unknown[]) => { calls.push(`error:${args.map(String).join(' ')}`) }
  try {
    process.env.PATH = ''
    assert.equal(detectClaudeVersion(), CLAUDE_CLI_FALLBACK_VERSION)
    assert.deepEqual(calls, [])
  } finally {
    process.env.PATH = originalPath
    console.debug = originalDebug
    console.warn = originalWarn
    console.error = originalError
  }
})

/** A working CLI must win over the hard-coded fallback version. */
test('detectClaudeVersion reads a resolvable CLI rather than the fallback', () => {
  const bin = join(mkdtempSync(join(tmpdir(), 'claude-probe-')), process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const reported = '9.9.9'
  writeFileSync(bin, process.platform === 'win32'
    ? `@echo off\r\necho ${reported} (Claude Code)\r\n`
    : `#!/bin/sh\necho "${reported} (Claude Code)"\n`, { mode: 0o755 })
  const original = process.env.PATH
  try {
    process.env.PATH = dirname(bin)
    assert.equal(detectClaudeVersion(), reported)
  } finally {
    process.env.PATH = original
    rmSync(dirname(bin), { recursive: true, force: true })
  }
})

/** The fallback must remain above the currently documented model floor. */
test('detectClaudeVersion fallback is new enough for currently gated models', () => {
  const [major, minor, patch] = CLAUDE_CLI_FALLBACK_VERSION.split('.').map(Number)
  assert.ok(major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 251))))
})

// ---------------------------------------------------------------------------
// CLAUDE_BETA_FALLBACK
// ---------------------------------------------------------------------------

const EXPECTED_FLAGS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'effort-2025-11-24',
  'compact-2026-01-12',
  'files-api-2025-04-14',
]

test('CLAUDE_BETA_FALLBACK is a well-formed comma-separated flag list', () => {
  assert.ok(CLAUDE_BETA_FALLBACK.length > 0, 'must not be empty')
  assert.ok(!CLAUDE_BETA_FALLBACK.startsWith(',') && !CLAUDE_BETA_FALLBACK.endsWith(','), 'no leading/trailing commas')
  for (const flag of CLAUDE_BETA_FALLBACK.split(',')) {
    // Dates appear both dashed (oauth-2025-04-20) and compact (claude-code-20250219).
    assert.match(flag, /^[a-z][\w-]+-\d{4}-?\d{2}-?\d{2}$/, `malformed flag: "${flag}"`)
  }
})

test('CLAUDE_BETA_FALLBACK contains exactly the live-verified flag set', () => {
  const flags = CLAUDE_BETA_FALLBACK.split(',')
  for (const expected of EXPECTED_FLAGS) {
    assert.ok(flags.includes(expected), `missing expected flag: ${expected}`)
  }
  assert.equal(flags.length, EXPECTED_FLAGS.length, `expected ${EXPECTED_FLAGS.length} flags, got ${flags.length}`)
})
