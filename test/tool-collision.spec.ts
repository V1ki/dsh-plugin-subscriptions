/**
 * Tool-name collision handling (issue #76): another plugin owning `x_search`
 * (e.g. @liustack/modsearch) used to make the duplicate insert throw out of
 * the plugin's apply, which took the providers, the tools, and the auth
 * channel down with it. The plugin now mounts the tool under an alias
 * instead, and degrades to a skip — never a crash — when even the alias is
 * taken. Drives the real plugin wiring with a fake tools registry whose
 * `get`/`register` mirror the ToolRuntime face; DSH_HOME is redirected to a
 * temp dir with a logged-in grok store so the tool trio would register.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tool-collision-test-'))

// Imports after the env override so the store path resolves under the temp home.
const plugin = await import('../src/index.js')

/**
 * A tools registry that already owns the given names (the modsearch stand-in).
 * `registered` is the full name set (seeded ownership plus successful
 * registrations); `attempted` is every `register` call, so a skipped
 * candidate — probe-short-circuited or thrown — is distinguishable from a
 * name that was owned all along.
 */
function fakeTools(owned: readonly string[]): {
  registered: () => string[]
  attempted: () => string[]
  service: object
} {
  const names = new Set<string>(owned)
  const attempted: string[] = []
  return {
    registered: () => [...names],
    attempted: () => [...attempted],
    service: {
      get: (name: string) => names.has(name) ? { name } : undefined,
      register: (definition: { name: string }) => {
        attempted.push(definition.name)
        if (names.has(definition.name)) {
          throw new Error(`tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`)
        }
        names.add(definition.name)
        return () => {}
      },
    },
  }
}

/** Mount the plugin with a grok session and a tools registry owning `owned`. */
async function mountTools(owned: readonly string[]): Promise<{
  registered: string[]
  attempted: string[]
}> {
  const home = process.env.DSH_HOME as string
  mkdirSync(join(home, 'plugins', 'subscriptions'), { recursive: true })
  writeFileSync(join(home, 'plugins', 'subscriptions', 'auth.json'), JSON.stringify({
    grok: { default: 'acct-1', accounts: { 'acct-1': {
      accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, tokenEndpoint: 'https://auth.x.ai/token',
    } } },
  }), { mode: 0o600 })
  const fake = fakeTools(owned)
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  ctx.provide('tools', fake.service)
  ctx.plugin(plugin, { providers: ['grok'], pool: { enabled: false } })
  // The tools inject callback settles on a later tick.
  await new Promise(resolve => setTimeout(resolve, 50))
  const out = { registered: fake.registered(), attempted: fake.attempted() }
  rmSync(join(home, 'plugins'), { recursive: true, force: true })
  return out
}

test('a foreign x_search owner no longer aborts the apply; the tool mounts as grok_x_search', async () => {
  const { registered, attempted } = await mountTools(['x_search'])
  assert.ok(registered.includes('grok_x_search'), `aliased registration missing in ${JSON.stringify(registered)}`)
  assert.ok(registered.includes('video_generate'), 'video_generate still registers')
  assert.equal(attempted.filter(name => name === 'x_search').length, 0,
    'the canonical name is never re-attempted; it stays with the other plugin')
})

test('without a collision the canonical names register', async () => {
  const { registered, attempted } = await mountTools([])
  for (const expected of ['x_search', 'video_generate']) {
    assert.ok(registered.includes(expected), `${expected} missing in ${JSON.stringify(registered)}`)
    assert.ok(attempted.includes(expected), `${expected} registered under its canonical name`)
  }
  assert.ok(!registered.includes('grok_x_search'))
})

test('an alias collision degrades to a skip and the plugin still applies', async () => {
  // Everything grok would register is owned, canonical and alias alike; the
  // image tool (grok is its fallback provider here) still mounts normally.
  const { registered, attempted } = await mountTools(
    ['x_search', 'grok_x_search', 'video_generate', 'grok_video_generate'])
  for (const skipped of ['x_search', 'grok_x_search', 'video_generate', 'grok_video_generate']) {
    assert.equal(attempted.filter(name => name === skipped).length, 0,
      `${skipped} is probed away, never attempted`)
  }
  assert.ok(registered.includes('image_generate'), 'image_generate still registers')
})
