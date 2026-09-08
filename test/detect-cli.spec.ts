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

/**
 * Regression: on Windows the CLI is `claude.cmd`, which `execFileSync` cannot
 * spawn directly — `ENOENT` for the extensionless name, `EINVAL` for the
 * `.cmd`. Detection then fell through to the fallback constant on every run,
 * so the user-agent advertised a stale version regardless of what was
 * installed, and Anthropic rejected models gated on a newer CLI.
 *
 * The assertion is deliberately indirect: it cannot require a real CLI in CI,
 * so it pins the property that actually broke — when a working `claude`
 * resolves, detection must report *its* version rather than the constant.
 */
test('detectClaudeVersion reads a resolvable CLI rather than the fallback', (t) => {
  const bin = join(mkdtempSync(join(tmpdir(), 'claude-probe-')), process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const reported = '9.9.9'
  writeFileSync(
    bin,
    process.platform === 'win32' ? `@echo off\r\necho ${reported} (Claude Code)\r\n` : `#!/bin/sh\necho "${reported} (Claude Code)"\n`,
    { mode: 0o755 },
  )

  const original = process.env.PATH
  try {
    process.env.PATH = dirname(bin)
    const version = detectClaudeVersion()
    if (version === CLAUDE_CLI_FALLBACK_VERSION) {
      assert.fail(
        'detection fell back to the hardcoded constant even though a working ' +
          `\`claude\` was on PATH (expected ${reported}). On Windows this is the ` +
          'execFileSync ENOENT/EINVAL batch-shim failure.',
      )
    }
    assert.equal(version, reported)
  } finally {
    process.env.PATH = original
    rmSync(dirname(bin), { recursive: true, force: true })
  }
})

/**
 * The fallback is only a safety net, but it is still sent verbatim whenever
 * detection fails (CLI absent, sandboxed spawn). Letting it drift below the
 * floor Anthropic enforces turns that net into a guaranteed HTTP 400.
 */
test('detectClaudeVersion fallback is new enough for currently gated models', () => {
  const MINIMUM = '2.1.251'
  const ordinal = (v: string) => v.split('.').map(Number)
  const [major, minor, patch] = ordinal(CLAUDE_CLI_FALLBACK_VERSION)
  const [minMajor, minMinor, minPatch] = ordinal(MINIMUM)
  const isAtLeast =
    major > minMajor ||
    (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)))
  assert.ok(
    isAtLeast,
    `fallback ${CLAUDE_CLI_FALLBACK_VERSION} is below the ${MINIMUM} floor required by ` +
      'current models; requests made while detection is failing would be rejected',
  )
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
