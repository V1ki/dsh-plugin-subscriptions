import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import semver from 'semver'

// Resolve the repository manifest through its package self-reference, including
// when this test runs from lib-test/test after TypeScript compilation.
const require = createRequire(import.meta.url)
const manifest = require('dsh-plugin-subscriptions/package.json') as {
  peerDependencies: Record<string, string>
  engines?: { dsh?: string }
}
const peers = Object.entries(manifest.peerDependencies).filter(([name]) =>
  name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

const supportedRange = '>=0.2.0-rc.2 || >=0.2.1-0'

test('all DSH peers share the minimum-only compatibility policy without an engines override', () => {
  assert.deepEqual(peers.map(([name]) => name).sort(), [
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-web',
  ])
  assert.equal(manifest.engines?.dsh, undefined,
    'an engines.dsh override requires testing that host admission range too')
  for (const [name, range] of peers) {
    assert.equal(range, supportedRange, name)
  }
})

// npm defaults exclude unrelated prereleases; DSH app-boot explicitly uses
// includePrerelease: true. Exercise both rather than assuming equivalence.
for (const includePrerelease of [false, true]) {
  const mode = includePrerelease ? 'DSH' : 'npm'
  const options = { includePrerelease }

  test(`${mode}: admits the lower release line and stable versions in range`, () => {
    for (const version of [
      '0.2.0-rc.2', '0.2.0-rc.3', '0.2.0', '0.2.1',
      '0.2.2', '0.2.9', '0.3.0', '1.0.0', '2.0.0',
    ]) {
      for (const [name, range] of peers) {
        assert.equal(semver.satisfies(version, range, options), true, `${name}: ${version}`)
      }
    }
  })

  test(`${mode}: admits all current 0.2.1 prereleases without per-RC entries`, () => {
    for (const version of [
      '0.2.1-0', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3',
      '0.2.1-alpha.4', '0.2.1-beta.1', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3',
      '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1-rc.99',
    ]) {
      for (const [name, range] of peers) {
        assert.equal(semver.satisfies(version, range, options), true, `${name}: ${version}`)
      }
    }
  })

  test(`${mode}: records the host/package-manager difference for future prerelease lines`, () => {
    // Only DSH opts into prereleases outside the explicitly anchored lines.
    // npm/pnpm need another anchor when a new prerelease line is supported.
    for (const version of [
      '0.2.2-0', '0.2.2-alpha.1', '0.2.2-rc.1', '0.3.0-alpha.1', '1.0.0-rc.1',
    ]) {
      for (const [name, range] of peers) {
        assert.equal(semver.satisfies(version, range, options), includePrerelease, `${name}: ${version}`)
      }
    }
  })

  test(`${mode}: excludes the entire retired 0.1 release line`, () => {
    for (const [name, range] of peers) {
      assert.equal(semver.intersects(range, '>=0.1.0-0 <0.2.0-0', options), false, name)
    }
  })

  test(`${mode}: rejects versions below the minimum`, () => {
    for (const version of [
      '0.1.7', '0.2.0-0', '0.2.0-alpha.1', '0.2.0-rc.1',
    ]) {
      for (const [name, range] of peers) {
        assert.equal(semver.satisfies(version, range, options), false, `${name}: ${version}`)
      }
    }
  })
}
