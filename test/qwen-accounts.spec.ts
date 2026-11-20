import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { QwenSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { QwenAccountAdapter } from '../src/providers/qwen-accounts.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { buildAccountPools } from '../src/providers/pool-family.js'

function session(token: string): QwenSession {
  return { accessToken: token, refreshToken: token + '-refresh', expiresAt: Date.now() + 3_600_000 }
}
function harness(refresh?: (account: string, current: QwenSession) => Promise<QwenSession>) {
  const stored = new Map<string, QwenSession>([['a', session('a-token')], ['b', session('b-token')]])
  const refreshes: string[] = []
  const tokens = new AccountTokenManager<QwenSession>({
    provider: 'qwen-subscription', displayName: 'Qwen',
    makeOptions: account => ({
      preemptMs: 60_000,
      refresh: async current => {
        refreshes.push(account)
        return refresh === undefined
          ? { ...current, accessToken: current.accessToken + '-new', refreshToken: current.refreshToken + '-new' }
          : refresh(account, current)
      },
      isPermanent: () => false,
    }),
    io: {
      list: async () => [...stored].map(([key, value]) => ({ key, session: value })),
      get: async key => key === undefined ? stored.values().next().value : stored.get(key),
      save: async (key, value) => { stored.set(key, value) },
      remove: async key => { stored.delete(key) },
      compareAndSave: async (key: string, expectedRefreshToken: string, next: QwenSession) => {
        const current = stored.get(key)
        if (current?.refreshToken !== expectedRefreshToken) return current
        stored.set(key, next)
        return next
      },
      compareAndDelete: async (key: string, expectedRefreshToken: string) => {
        if (stored.get(key)?.refreshToken !== expectedRefreshToken) return false
        stored.delete(key)
        return true
      },
      resolve: async key => key === 'old-a' ? 'a' : key,
    },
  })
  return { tokens, stored, refreshes }
}
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const data = (...models: { id: string; input_modalities?: string[]; context_window_tokens?: number }[]): Response => json({ data: models })
const okStream = (): Response => new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
const OPTIONS: GenerateOptions = { provider: 'qwen-subscription', model: 'shared', messages: [] }
const bearer = (init?: RequestInit): string | null => new Headers(init?.headers).get('authorization')
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

test('catalogs and capability metadata are isolated by account and union default first', async () => {
  const h = harness()
  const calls: string[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    const token = bearer(init)!; calls.push(token)
    return token === 'Bearer a-token'
      ? data({ id: 'shared', context_window_tokens: 100, input_modalities: ['text'] }, { id: 'only-a' })
      : data({ id: 'shared', context_window_tokens: 40, input_modalities: ['text', 'image'] }, { id: 'only-b', context_window_tokens: 80 })
  }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  assert.deepEqual((await adapter.listOwnModels('qwen-subscription')).map(m => m.id), ['shared', 'only-a', 'only-b'])
  assert.equal((await adapter.resolveOwnModel('qwen-subscription', 'shared', 'old-a')).context?.contextWindow, 100)
  assert.equal((await adapter.resolveOwnModel('qwen-subscription', 'shared', 'b')).context?.contextWindow, 40)
  assert.equal((await adapter.resolveOwnModel('qwen-subscription', 'only-b')).context?.contextWindow, 80)
  await assert.rejects(adapter.resolveOwnModel('qwen-subscription', 'only-b', 'a'), /unavailable/)
  assert.equal(calls.length, 2, 'preferCached does not refetch during resolution')
  assert.deepEqual((await adapter.listOwnModels('another-route', 'b', undefined, true)).map(m => m.provider), ['another-route', 'another-route'])
})

test('account invalidation drops only its catalog, including through a known alias', async () => {
  const h = harness(); const calls: string[] = []; let aVersion = 1
  const fetchFn: typeof fetch = async (_url, init) => {
    const token = bearer(init)!; calls.push(token)
    return token === 'Bearer a-token' ? data({ id: 'a-' + aVersion }) : data({ id: 'b' })
  }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  await adapter.listOwnModels('qwen-subscription')
  await adapter.listOwnModels('qwen-subscription', 'old-a', undefined, true)
  aVersion = 2; adapter.clearAccountCatalog('old-a')
  assert.equal(await adapter.lastKnownOwnModels('qwen-subscription', 'a'), undefined)
  assert.deepEqual((await adapter.listOwnModels('qwen-subscription', 'b', undefined, true)).map(m => m.id), ['b'])
  assert.deepEqual((await adapter.listOwnModels('qwen-subscription', 'a', undefined, true)).map(m => m.id), ['a-2'])
  assert.deepEqual(calls, ['Bearer a-token', 'Bearer b-token', 'Bearer a-token'])
  adapter.clearAccountCatalog()
  assert.equal(await adapter.lastKnownOwnModels('qwen-subscription', 'b'), undefined)
})

test('forced catalog refresh retains fallback and bypasses preferCached', async () => {
  const h = harness(); let state: 'live' | 'down' | 'denied' = 'live'; let calls = 0
  const fetchFn: typeof fetch = async () => {
    calls++
    return state === 'live' ? data({ id: 'model' }) : json({}, state === 'down' ? 503 : 403)
  }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  await adapter.listOwnModels('qwen-subscription', 'a')
  state = 'down'; adapter.invalidateAccountCatalog('a')
  assert.deepEqual((await adapter.lastKnownOwnModels('qwen-subscription', 'a'))?.map(m => m.id), ['model'])
  assert.deepEqual((await adapter.listOwnModels('qwen-subscription', 'a', undefined, true)).map(m => m.id), ['model'])
  assert.equal(calls, 2)
  state = 'denied'
  // A 503 fallback must not mark the forced refresh complete.
  await assert.rejects(adapter.listOwnModels('qwen-subscription', 'a', undefined, true), /403/)
  await assert.rejects(adapter.lastKnownOwnModels('qwen-subscription', 'a'), /403/)
})

test('invalidation during in-flight discovery cannot restore obsolete catalog', async () => {
  const h = harness(); const started = deferred<void>(); const pending = deferred<Response>(); let count = 0
  const fetchFn: typeof fetch = async () => { count++; if (count === 1) { started.resolve(); return pending.promise }; return data({ id: 'fresh' }) }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  const old = adapter.listOwnModels('qwen-subscription', 'a')
  await started.promise
  adapter.clearAccountCatalog('a')
  assert.deepEqual((await adapter.listOwnModels('qwen-subscription', 'a')).map(m => m.id), ['fresh'])
  pending.resolve(data({ id: 'old' }))
  assert.deepEqual(await old, [])
  assert.deepEqual((await adapter.lastKnownOwnModels('qwen-subscription', 'a'))?.map(m => m.id), ['fresh'])
})

test('capability-only catalog changes notify the pool', async () => {
  const h = harness(); let contextWindow = 100; let changes = 0
  const fetchFn: typeof fetch = async () => data({ id: 'shared', context_window_tokens: contextWindow })
  const adapter = new QwenAccountAdapter({
    tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn, onCatalogChanged: () => { changes++ },
  })
  await adapter.listOwnModels('qwen-subscription', 'a')
  assert.equal(changes, 1)
  contextWindow = 40
  adapter.invalidateAccountCatalog('a')
  await adapter.listOwnModels('qwen-subscription', 'a', undefined, true)
  assert.equal(changes, 2)
  assert.equal((await adapter.resolveOwnModel('qwen-subscription', 'shared', 'a')).context?.contextWindow, 40)
})

test('forced refresh during active discovery triggers another request', async () => {
  const h = harness(); const started = deferred<void>(); const gate = deferred<Response>(); let calls = 0
  const fetchFn: typeof fetch = async () => {
    calls++
    if (calls === 2) { started.resolve(); return gate.promise }
    return data({ id: calls === 1 ? 'original' : 'fresh' })
  }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  await adapter.listOwnModels('qwen-subscription', 'a')
  const old = adapter.listOwnModels('qwen-subscription', 'a')
  await started.promise; adapter.invalidateAccountCatalog('a')
  const fresh = adapter.listOwnModels('qwen-subscription', 'a', undefined, true)
  assert.deepEqual((await adapter.lastKnownOwnModels('qwen-subscription', 'a'))?.map(m => m.id), ['original'])
  gate.resolve(data({ id: 'outdated' }))
  assert.deepEqual((await old).map(m => m.id), ['fresh'])
  assert.deepEqual((await fresh).map(m => m.id), ['fresh'])
  assert.deepEqual((await adapter.lastKnownOwnModels('qwen-subscription', 'a'))?.map(m => m.id), ['fresh'])
  assert.equal(calls, 3)
})

test('default stream uses default credentials; named streams use only named credentials', async () => {
  const h = harness(); const calls: (string | null)[] = []
  const fetchFn: typeof fetch = async (_url, init) => { calls.push(bearer(init)); return okStream() }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  assert.ok((await collect(adapter.stream(OPTIONS))).some(c => c.type === 'text-delta'))
  await collect(adapter.streamAccount(OPTIONS, 'b'))
  await collect(adapter.streamAccount(OPTIONS, 'old-a'))
  assert.deepEqual(calls, ['Bearer a-token', 'Bearer b-token', 'Bearer a-token'])
})

test('concurrent 401 retries rotate once and reuse the current access token', async () => {
  const started = deferred<void>(); const gate = deferred<void>()
  const h = harness(async (_account, current) => {
    started.resolve(); await gate.promise
    return { ...current, accessToken: 'new-a', refreshToken: 'new-refresh' }
  })
  const calls: (string | null)[] = []; const oldRequests = deferred<void>(); let count = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    const auth = bearer(init); calls.push(auth)
    if (auth === 'Bearer a-token') {
      count++
      if (count === 2) oldRequests.resolve()
      await oldRequests.promise
      return json({}, 401)
    }
    return okStream()
  }
  // Two wrappers share a manager and hence the compare/refresh queue.
  const one = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 5000, fetchFn })
  const two = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 5000, fetchFn })
  const pending = Promise.all([collect(one.streamAccount(OPTIONS, 'a')), collect(two.streamAccount(OPTIONS, 'old-a'))])
  await started.promise; gate.resolve(); await pending
  assert.deepEqual(h.refreshes, ['a'])
  assert.equal(h.stored.get('a')?.refreshToken, 'new-refresh')
  assert.equal(calls.filter(token => token === 'Bearer new-a').length, 2)
})

test('cancelling a waiter does not cancel an already rotating credential', async () => {
  const started = deferred<void>(); const gate = deferred<void>()
  const h = harness(async (_account, current) => {
    started.resolve(); await gate.promise
    return { ...current, accessToken: 'new-a', refreshToken: 'new-refresh' }
  })
  const fetchFn: typeof fetch = async (_url, init) => bearer(init) === 'Bearer a-token' ? json({}, 401) : okStream()
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 5000, fetchFn })
  const controller = new AbortController()
  const first = collect(adapter.streamAccount({ ...OPTIONS, signal: controller.signal }, 'a'))
  await started.promise
  controller.abort(new Error('cancelled'))
  await assert.rejects(first, /abort/i)
  const second = collect(adapter.streamAccount(OPTIONS, 'a'))
  gate.resolve()
  await second
  assert.equal(h.stored.get('a')?.refreshToken, 'new-refresh')
  assert.deepEqual(h.refreshes, ['a'])
})

test('a late 401 after an external token replacement reuses the new token', async () => {
  const h = harness(); const seen: (string | null)[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    const token = bearer(init); seen.push(token)
    if (token === 'Bearer a-token') { h.stored.set('a', session('replacement')); return json({}, 401) }
    return okStream()
  }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  await collect(adapter.streamAccount(OPTIONS, 'a'))
  assert.deepEqual(seen, ['Bearer a-token', 'Bearer replacement'])
  assert.deepEqual(h.refreshes, [])
})

test('AUTH invalidates cached catalog and propagates; a healthy account still lists', async () => {
  const h = harness(); let deny = false
  const fetchFn: typeof fetch = async (_url, init) => {
    if (bearer(init) === 'Bearer a-token') return deny ? json({}, 403) : data({ id: 'private' })
    return data({ id: 'public' })
  }
  let changes = 0
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn, onCatalogChanged: () => { changes++ } })
  await adapter.listOwnModels('qwen-subscription', 'a'); deny = true
  assert.equal(changes, 1)
  await assert.rejects(adapter.listOwnModels('qwen-subscription', 'a'), /403/)
  assert.equal(changes, 2, 'a rejected cached catalog invalidates the pool snapshot')
  await assert.rejects(adapter.lastKnownOwnModels('qwen-subscription', 'a'), /403/)
  assert.deepEqual((await adapter.listOwnModels('qwen-subscription')).map(m => m.id), ['public'])
  h.stored.delete('b')
  await assert.rejects(adapter.listOwnModels('qwen-subscription'), /403/)
  await assert.rejects(adapter.resolveModel('qwen-subscription', 'private'), /403/)
})

test('pool delegates resolution/stream, keeps per-member capabilities and fails over', async () => {
  const h = harness(); const streams: (string | null)[] = []
  const fetchFn: typeof fetch = async (url, init) => {
    const auth = bearer(init)
    if (String(url).endsWith('/models')) return data({ id: 'shared', context_window_tokens: auth === 'Bearer a-token' ? 100 : 40 })
    streams.push(auth)
    return auth === 'Bearer a-token' ? json({}, 500) : okStream()
  }
  let pool: PoolAdapter | undefined
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn, pool: () => pool })
  const catalogs = await Promise.all(['a', 'b'].map(async account => ({ account, models: await adapter.listOwnModels('qwen-subscription', account) })))
  pool = new PoolAdapter({
    adapters: { 'qwen-subscription': adapter }, health: new PoolHealthRegistry(), usage: new PoolUsageTracker(() => undefined),
    strategy: 'priority', switchMargin: 2, defaultAccount: async () => 'a',
    families: async () => buildAccountPools({ 'qwen-subscription': { catalogs } }), tiers: {}, onWarn: () => {},
  })
  assert.equal((await adapter.resolveModel('qwen-subscription', 'shared')).context?.contextWindow, 40)
  assert.ok((await collect(adapter.stream(OPTIONS))).some(c => c.type === 'text-delta'))
  assert.deepEqual(streams, ['Bearer a-token', 'Bearer b-token'])
})

test('wrapper exposes and applies the configured default reasoning effort', async () => {
  const h = harness(); let requestBody: Record<string, unknown> | undefined
  const fetchFn: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return data({ id: 'shared' })
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return okStream()
  }
  const adapter = new QwenAccountAdapter({
    tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn,
    defaultEffortOf: model => model === 'shared' ? 'high' : undefined,
  })
  const resolved = await adapter.resolveOwnModel('qwen-subscription', 'shared', 'a')
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  assert.ok(resolved.reasoning?.efforts.some(effort => effort.id === 'high'))
  await collect(adapter.streamAccount(OPTIONS, 'a'))
  assert.equal(requestBody?.enable_thinking, true)
  assert.equal(requestBody?.thinking_budget, 32768)
})

test('a stalled account times out without blocking a healthy account', async () => {
  const h = harness(); const stalled = deferred<Response>()
  const fetchFn: typeof fetch = async (_url, init) => bearer(init) === 'Bearer a-token' ? stalled.promise : data({ id: 'healthy' })
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn, discoveryTimeoutMs: 20 })
  // AbortSignal.timeout timers are unref'ed; keep the event loop alive briefly.
  const keepAlive = setTimeout(() => {}, 2000)
  try { assert.deepEqual((await adapter.listOwnModels('qwen-subscription')).map(m => m.id), ['healthy']) }
  finally { clearTimeout(keepAlive); stalled.resolve(data({ id: 'late' })) }
  assert.equal(await adapter.lastKnownOwnModels('qwen-subscription', 'a'), undefined)
})

test('cancelling resolveModel aborts discovery and cannot publish late results', async () => {
  const h = harness(); h.stored.delete('b')
  const started = deferred<AbortSignal>(); const gate = deferred<Response>()
  const fetchFn: typeof fetch = async (_url, init) => { started.resolve(init!.signal!); return gate.promise }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  const controller = new AbortController(); const pending = adapter.resolveModel('qwen-subscription', 'shared', controller.signal)
  const fetchSignal = await started.promise
  controller.abort(new Error('resolve cancelled'))
  await assert.rejects(pending, /resolve cancelled/)
  assert.equal(fetchSignal.aborted, true)
  gate.resolve(data({ id: 'shared' }))
  assert.equal(await adapter.lastKnownOwnModels('qwen-subscription', 'a'), undefined)
})

test('cancelled catalog request settles without accepting a late response', async () => {
  const h = harness(); const started = deferred<void>(); const gate = deferred<Response>(); let calls = 0
  const fetchFn: typeof fetch = async () => {
    calls++
    if (calls === 2) { started.resolve(); return gate.promise }
    return data({ id: calls === 1 ? 'known' : 'fresh' })
  }
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn })
  await adapter.listOwnModels('qwen-subscription', 'a')
  const controller = new AbortController(); const pending = adapter.listOwnModels('qwen-subscription', 'a', controller.signal)
  await started.promise; controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  gate.resolve(data({ id: 'late' }))
  assert.deepEqual((await adapter.lastKnownOwnModels('qwen-subscription', 'a'))?.map(m => m.id), ['known'])
  assert.deepEqual((await adapter.listOwnModels('qwen-subscription', 'a')).map(m => m.id), ['fresh'])
})

test('quota usage is account-scoped memory only, without endpoint or invented percentages', async () => {
  const h = harness()
  const reset = Math.floor(Date.now() / 1000) + 3600
  let fail = true; let calls = 0
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn: async (url, init) => {
    calls++
    if (String(url).endsWith('/models')) return data({ id: 'shared' })
    return fail && bearer(init) === 'Bearer a-token' ? json({ error: { code: 'insufficient_quota', quota: { reset_at: reset } } }, 402) : okStream()
  } })
  assert.deepEqual(await adapter.usage('a'), { supported: false })
  assert.equal(calls, 0)
  await assert.rejects(collect(adapter.streamAccount(OPTIONS, 'old-a')), /quota exhausted/)
  const usage = await adapter.usage('a')
  assert.equal(usage.supported, false)
  assert.equal(usage.quotaExhaustion?.resetsAt, reset * 1000)
  assert.ok(usage.quotaExhaustion!.observedAt <= Date.now())
  assert.equal(usage.windows, undefined)
  assert.deepEqual(await adapter.usage('old-a'), usage)
  assert.deepEqual(await adapter.usage('b'), { supported: false })
  await collect(adapter.streamAccount(OPTIONS, 'b'))
  assert.deepEqual(await adapter.usage('a'), usage, 'another account success cannot clear exhaustion')
  adapter.invalidateAccountCatalog('a')
  await adapter.listOwnModels('qwen-subscription', 'a')
  assert.deepEqual(await adapter.usage('a'), usage, 'force refresh and catalog success do not prove renewal')
  const freshInstance = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000 })
  assert.deepEqual(await freshInstance.usage('a'), { supported: false }, 'observations are not persisted')
  fail = false
  await collect(adapter.stream(OPTIONS))
  assert.deepEqual(await adapter.usage('a'), { supported: false }, 'completed default chat success clears same account')
  const controller = new AbortController(); controller.abort(new Error('cancel usage'))
  await assert.rejects(adapter.usage('a', controller.signal), /cancel usage/)
})

test('auth catalog clearing removes quota and ignores delayed pre-login responses', async () => {
  const h = harness()
  let pending: ReturnType<typeof deferred<Response>> | undefined
  let started: ReturnType<typeof deferred<void>> | undefined
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn: async () => {
    if (pending) { started!.resolve(); return pending.promise }
    return json({ error: { code: 'insufficient_quota' } }, 402)
  } })
  await assert.rejects(collect(adapter.streamAccount(OPTIONS, 'a')), /quota exhausted/)
  await assert.rejects(collect(adapter.streamAccount(OPTIONS, 'b')), /quota exhausted/)
  assert.ok((await adapter.usage('old-a')).quotaExhaustion)
  adapter.clearAccountCatalog('old-a')
  assert.deepEqual(await adapter.usage('a'), { supported: false })
  assert.ok((await adapter.usage('b')).quotaExhaustion)
  pending = deferred<Response>(); started = deferred<void>()
  const old = collect(adapter.streamAccount(OPTIONS, 'a'))
  const oldRejected = assert.rejects(old, /quota exhausted/)
  await started.promise
  adapter.clearAccountCatalog('a')
  pending.resolve(json({ error: { code: 'insufficient_quota' } }, 402))
  await oldRejected
  assert.deepEqual(await adapter.usage('a'), { supported: false })
  adapter.clearAccountCatalog()
  assert.deepEqual(await adapter.usage('b'), { supported: false })
})

test('late successful chat cannot erase a newer concurrent quota observation', async () => {
  const h = harness(); let delaySuccess = false
  const pending = deferred<Response>(); const started = deferred<void>()
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn: async () => {
    if (delaySuccess) { delaySuccess = false; started.resolve(); return pending.promise }
    return json({ error: { code: 'insufficient_quota' } }, 402)
  } })
  await assert.rejects(collect(adapter.streamAccount(OPTIONS, 'a')), /quota exhausted/)
  delaySuccess = true
  const success = collect(adapter.streamAccount(OPTIONS, 'a'))
  await started.promise
  await assert.rejects(collect(adapter.streamAccount(OPTIONS, 'a')), /quota exhausted/)
  const newer = await adapter.usage('a')
  pending.resolve(okStream()); await success
  assert.deepEqual(await adapter.usage('a'), newer)
})

test('empty and content-filter terminal errors never disprove quota exhaustion', async () => {
  for (const reason of ['stop', 'content_filter']) {
    const h = harness(); let fail = true
    const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn: async () => fail
      ? json({ error: { code: 'insufficient_quota' } }, 402)
      : new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: reason === 'content_filter' ? { content: 'filtered response' } : {}, finish_reason: reason }] }) + '\n\ndata: [DONE]\n\n'),
    })
    await assert.rejects(collect(adapter.streamAccount(OPTIONS, 'a')), /quota exhausted/)
    const before = await adapter.usage('a'); fail = false
    const chunks = await collect(adapter.streamAccount(OPTIONS, 'a'))
    assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'))
    assert.deepEqual(await adapter.usage('a'), before)
  }
})

test('confirmed chat success suppresses quota from earlier requests but preserves new failures', async () => {
  const h = harness(); let delay = true; let fail = false
  const pending = deferred<Response>(); const started = deferred<void>()
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn: async () => {
    if (delay) { delay = false; started.resolve(); return pending.promise }
    return fail ? json({ error: { code: 'insufficient_quota' } }, 402) : okStream()
  } })
  const old = collect(adapter.streamAccount(OPTIONS, 'a'))
  const rejected = assert.rejects(old, /quota exhausted/)
  await started.promise
  for await (const chunk of adapter.streamAccount(OPTIONS, 'a')) {
    if (chunk.type === 'finish') break
  }
  pending.resolve(json({ error: { code: 'insufficient_quota' } }, 402)); await rejected
  assert.deepEqual(await adapter.usage('a'), { supported: false }, 'old request cannot reinsert superseded exhaustion')
  fail = true
  await assert.rejects(collect(adapter.streamAccount(OPTIONS, 'a')), /quota exhausted/)
  assert.ok((await adapter.usage('a')).quotaExhaustion, 'new request still records exhaustion')
})

test('consumer break on successful finish clears quota before yielding terminal chunk', async () => {
  const h = harness(); let fail = true
  const adapter = new QwenAccountAdapter({ tokens: h.tokens, streamIdleTimeoutMs: 1000, fetchFn: async () => fail
    ? json({ error: { code: 'insufficient_quota' } }, 402) : okStream(),
  })
  await assert.rejects(collect(adapter.streamAccount(OPTIONS, 'a')), /quota exhausted/)
  fail = false
  for await (const chunk of adapter.streamAccount(OPTIONS, 'a')) {
    if (chunk.type === 'finish') {
      assert.deepEqual(await adapter.usage('a'), { supported: false })
      break
    }
  }
  assert.deepEqual(await adapter.usage('a'), { supported: false })
})
