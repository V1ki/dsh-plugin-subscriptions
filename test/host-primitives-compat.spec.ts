import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The client bundle resolves `@deepseek-ai/dsh-client-ui-primitives` from the
// running host, whose export list changes between DSH releases: 0.1.7 renamed
// the 16px icons and 0.2.2 removed `useAnchoredPosition`. The development
// dependency is pinned to one release, so type checking cannot see a removal.
// This host exports nothing at all: any client module that needs a named
// value from the host fails to link here, and a namespace read that is called
// without a fallback throws during render.
const host = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === '@deepseek-ai/dsh-client-ui-primitives'
    ? { url: 'data:text/javascript,export {}', shortCircuit: true }
    : nextResolve(specifier, context)
} })
const client = await import('../src/client/index.js')
const { SubscriptionUsageBadge } = await import('../src/client/SubscriptionUsageBadge.js')
const { SpeedSelect } = await import('../src/client/SpeedSelect.js')
host.deregister()

test('the client entry links against a host primitives module with no exports', () => {
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'connection', 'locale'])
})

test('composer entries render without any host hook (issue #215)', () => {
  // DSH retires a list-slot entry that throws on its first render, for the
  // page lifetime. The badge calls every hook before deciding to show a pill.
  const Badge = SubscriptionUsageBadge as unknown as ComponentType<Record<string, never>>
  assert.match(renderToStaticMarkup(createElement(Badge, {})), /^<span[^>]*aria-hidden="true"[^>]*><\/span>$/)
  const Speed = SpeedSelect as unknown as ComponentType<Record<string, never>>
  assert.equal(renderToStaticMarkup(createElement(Speed, {})), '')
})
