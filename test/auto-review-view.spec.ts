import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAutoReviewLoader,
  createAutoReviewSetter,
  displayedAutoReview,
  type AutoReviewRpc,
  type AutoReviewState,
} from '../src/client/AutoReviewSelect.js'
import {
  createAutoReviewDefaultLoader,
  createAutoReviewDefaultSetter,
} from '../src/client/SubscriptionsSection.js'
import { en } from '../src/client/locales.js'

interface ActivityFormatterModule {
  formatAutoReviewActivity(provider: string, outcome?: string): string
}

function hasActivityFormatter(value: unknown): value is ActivityFormatterModule {
  return typeof value === 'object' && value !== null
    && 'formatAutoReviewActivity' in value
    && typeof value.formatAutoReviewActivity === 'function'
}

test('auto-review composer control uses the explicit Auto-Review label', () => {
  assert.equal(en.autoReview, 'Auto-Review')
})

test('auto-review chat activity names the provider and visible review result', async () => {
  const moduleUrl = new URL('../src/client/AutoReviewActivity.js', import.meta.url)
  const loaded: unknown = await import(moduleUrl.href).catch(() => undefined)

  assert.equal(hasActivityFormatter(loaded), true)
  if (!hasActivityFormatter(loaded)) return
  assert.equal(loaded.formatAutoReviewActivity('Codex'), 'Auto-Review · Codex · Reviewing...')
  assert.equal(loaded.formatAutoReviewActivity('Codex', 'allowed-once'), 'Auto-Review · Codex · Allowed')
  assert.equal(loaded.formatAutoReviewActivity('Codex', 'rejected'), 'Auto-Review · Codex · Denied')
  assert.equal(loaded.formatAutoReviewActivity('Codex', 'unavailable'), 'Auto-Review · Codex · Manual approval')
  assert.equal(loaded.formatAutoReviewActivity('Grok', 'unavailable'), 'Auto-Review · Grok · Unavailable')
  assert.equal(loaded.formatAutoReviewActivity('Grok', 'rejected'), 'Auto-Review · Grok · Denied')
})

test('auto-review composer callbacks bind reads and writes to one session', async () => {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  const rpc: AutoReviewRpc = {
    async call(channel: string, endpoint: string, payload: unknown) {
      calls.push({ channel, endpoint, payload })
      return endpoint === 'autoReview'
        ? { ok: true, value: { reviewer: 'none', reviewers: [{ reviewer: 'codex', label: 'Codex' }] } }
        : { ok: true, value: { ok: true } }
    },
  }

  assert.deepEqual(await createAutoReviewLoader(rpc, 'session-7')(), {
    reviewer: 'none',
    reviewers: [{ reviewer: 'codex', label: 'Codex' }],
  })
  assert.equal(await createAutoReviewSetter(rpc, 'session-7')('codex'), true)
  assert.deepEqual(calls, [
    { channel: '/subscriptions-auth', endpoint: 'autoReview', payload: { sessionId: 'session-7' } },
    {
      channel: '/subscriptions-auth',
      endpoint: 'setAutoReview',
      payload: { sessionId: 'session-7', reviewer: 'codex' },
    },
  ])
})

test('auto-review composer setter reports RPC failures without changing state itself', async () => {
  const rpc: AutoReviewRpc = {
    async call() {
      return { ok: false, error: { code: 'internal', message: 'offline', details: {} } }
    },
  }

  assert.equal(await createAutoReviewSetter(rpc, 'session-8')('none'), false)
})

test('Settings and composer hide a logged-out default reviewer as None', () => {
  const state: AutoReviewState = { reviewer: 'grok', reviewers: [] }
  assert.equal(displayedAutoReview(state), 'none')
  assert.equal(displayedAutoReview({
    reviewer: 'grok',
    reviewers: [{ reviewer: 'grok', label: 'Grok' }],
  }), 'grok')
})

test('Settings Auto-Review callbacks read and persist the global default', async () => {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc: AutoReviewRpc = {
    async call(_channel: string, endpoint: string, payload: unknown) {
      calls.push({ endpoint, payload })
      return {
        ok: true,
        value: {
          reviewer: endpoint === 'setAutoReviewDefault' ? 'none' : 'codex',
          reviewers: [{ reviewer: 'codex', label: 'Codex' }],
        },
      }
    },
  }

  assert.equal((await createAutoReviewDefaultLoader(rpc)()).reviewer, 'codex')
  assert.equal((await createAutoReviewDefaultSetter(rpc)('none')).reviewer, 'none')
  assert.deepEqual(calls, [
    { endpoint: 'autoReviewDefault', payload: {} },
    { endpoint: 'setAutoReviewDefault', payload: { reviewer: 'none' } },
  ])
})
