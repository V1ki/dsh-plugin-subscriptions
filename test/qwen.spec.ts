import { test } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import assert from 'node:assert/strict'
import { QwenAdapter, QwenOAuthClient, QwenOAuthError, QWEN_AUTH_URL, QWEN_GATEWAY_URL } from '../src/providers/qwen.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { classifyPoolFailure } from '../src/providers/pool-health.js'

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const token = { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: 'model:invoke profile:read' }

test('subscription device flow, token rotation, identity and revoke use official forms', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    if (String(url).endsWith('/device/code')) return json({ device_code: 'secret', user_code: 'ABCD', verification_uri: 'https://chat.qwen.ai/', verification_uri_complete: 'https://chat.qwen.ai/', expires_in: 60, interval: 0.001 })
    if (String(url).endsWith('/userinfo')) return json({ sub: 'id', name: 'name', email: 'mail', member_type: 'Plus' })
    if (String(url).endsWith('/revoke')) return new Response(null, { status: 204 })
    return json(token)
  }) as typeof fetch
  const client = new QwenOAuthClient(fetchFn)
  const device = await client.start()
  assert.equal(new URL(device.verificationUrl).searchParams.get('user_code'), 'ABCD')
  assert.equal((await client.poll(device)).refreshToken, 'refresh')
  assert.equal((await client.refresh('old')).accessToken, 'access')
  assert.equal((await client.userInfo('access')).memberType, 'Plus')
  await client.revoke('refresh')
  assert.equal(calls[0]!.url, QWEN_AUTH_URL + '/device/code')
  assert.equal(new URLSearchParams(String(calls[0]!.init.body)).get('scope'), 'model:invoke profile:read')
  assert.equal(new URLSearchParams(String(calls[1]!.init.body)).get('device_code'), 'secret')
  assert.equal(new URLSearchParams(String(calls[2]!.init.body)).get('refresh_token'), 'old')
  assert.ok(calls.every(c => c.init.redirect === 'error'))
})

test('device polling cancellation, expiration, and invalid token errors', async () => {
  const client = new QwenOAuthClient((async () => json({ error: 'invalid_grant' }, 400)) as typeof fetch)
  await assert.rejects(client.refresh('bad'), (e: unknown) => e instanceof QwenOAuthError && e.code === 'invalid_grant' && e.status === 400)
  const grant = { deviceCode: 'd', userCode: 'u', verificationUrl: '', intervalMs: 1000, expiresAt: Date.now() + 5000 }
  const controller = new AbortController(); const pending = client.poll(grant, controller.signal); controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(client.poll({ ...grant, expiresAt: Date.now() - 1 }), (e: unknown) => e instanceof QwenOAuthError && e.code === 'expired_token')
})

test('catalog and stream retry only rejected access token, reject redirects', async () => {
  const calls: { url: string; init: RequestInit }[] = []; const rejected: (string | undefined)[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    if (calls.length === 1) return json({}, 401)
    if (String(url).endsWith('/models')) return json({ data: [{ id: 'qwen-model', input_modalities: ['text', 'image'], context_window_tokens: 100000 }] })
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  }) as typeof fetch
  const adapter = new QwenAdapter({ tokens: { async getAccessToken(_signal, rejectedToken) { rejected.push(rejectedToken); return rejectedToken ? 'new' : 'old' } }, fetchFn, streamIdleTimeoutMs: 10000 })
  assert.equal((await adapter.listModels('qwen-subscription'))[0]!.id, 'qwen-model')
  assert.equal((await adapter.resolveModel('qwen-subscription', 'qwen-model')).context?.contextWindow, 100000)
  assert.deepEqual(rejected, [undefined, 'old'])
  const chunks = []; for await (const c of adapter.stream({ provider: 'qwen-subscription', model: 'qwen-model', messages: [] } as unknown as GenerateOptions)) chunks.push(c)
  assert.ok(chunks.some(c => c.type === 'text-delta'))
  assert.equal(calls[0]!.url, QWEN_GATEWAY_URL + '/models')
  assert.ok(calls.every(c => c.init.redirect === 'error'))
  const body = JSON.parse(String(calls[2]!.init.body)); assert.equal(body.enable_thinking, true); assert.equal(body.thinking_budget, 16384)
})

test('catalog fallback is account-scoped, cancellable and excludes 403', async () => {
  let mode = 'ok'
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    if (mode === 'network') throw new TypeError('offline')
    if (mode === 'server') return json({}, 503)
    if (mode === 'forbidden') return json({ error: { message: 'membership required' } }, 403)
    return json({ data: [{ id: 'model-one' }] })
  }) as typeof fetch
  const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, fetchFn, streamIdleTimeoutMs: 10000 })
  assert.equal((await adapter.listModels('qwen-subscription'))[0]!.id, 'model-one')
  assert.equal((await adapter.resolveModel('qwen-subscription', 'model-one')).context, undefined)
  await assert.rejects(adapter.resolveModel('qwen-subscription', 'unknown'), /not in the account catalog/)
  mode = 'network'; assert.equal((await adapter.listModelsResult('qwen-subscription')).fallback, true)
  mode = 'server'; assert.equal((await adapter.listModelsResult('qwen-subscription')).fallback, true)
  mode = 'ok'; assert.equal((await adapter.listModelsResult('qwen-subscription')).fallback, false)
  mode = 'forbidden'; await assert.rejects(adapter.listModels('qwen-subscription'), /403/)
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  mode = 'network'; await assert.rejects(adapter.listModels('qwen-subscription', controller.signal), /cancelled/)
  adapter.clearCatalog(); await assert.rejects(adapter.listModels('qwen-subscription'), /network request failed/)
})

test('stream translates reasoning and tool calls; 402 surfaces status', async () => {
  let fail = false
  const fetchFn = (async () => fail ? json({ error: { code: 'insufficient_quota', message: 'no credits' } }, 402) : new Response(
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{\\"x\\":1}"}}]},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
  )) as typeof fetch
  const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, fetchFn, streamIdleTimeoutMs: 10000 })
  const options = { provider: 'qwen-subscription', model: 'm', messages: [] } as unknown as GenerateOptions
  const chunks = []; for await (const c of adapter.stream(options)) chunks.push(c)
  assert.ok(chunks.some(c => c.type === 'reasoning-delta' && c.text === 'think'))
  assert.ok(chunks.some(c => c.type === 'block-end' && c.block.type === 'tool-call'))
  fail = true
  await assert.rejects(async () => { for await (const _ of adapter.stream(options)) {} }, /402/)
})

test('OAuth request timeout and caller cancellation reach fetch', async () => {
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!; signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })) as typeof fetch
  const client = new QwenOAuthClient(fetchFn, 10)
  // Keep the event loop alive: AbortSignal.timeout uses an unref'ed timer.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(client.start(), (e: unknown) => e instanceof QwenOAuthError && e.code === 'request_timeout')
    await assert.rejects(client.refresh('r'), (e: unknown) => e instanceof QwenOAuthError && e.code === 'request_timeout')
    await assert.rejects(client.userInfo('a'), (e: unknown) => e instanceof QwenOAuthError && e.code === 'request_timeout')
    const controller = new AbortController(); const pending = client.refresh('r', controller.signal); controller.abort(new Error('user cancelled'))
    await assert.rejects(pending, /user cancelled/)
  } finally { clearTimeout(keepAlive) }
})

test('two turns replay reasoning alongside the matching assistant tool call', async () => {
  const requests: Record<string, unknown>[] = []
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const delta = requests.length === 1
      ? { reasoning_content: 'I should look it up', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } }] }
      : { content: 'done' }
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  }) as typeof fetch
  const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, fetchFn, streamIdleTimeoutMs: 10000 })
  const first = { provider: 'qwen-subscription', model: 'm', messages: [] } as unknown as GenerateOptions
  const blocks = []; for await (const chunk of adapter.stream(first)) if (chunk.type === 'block-end') blocks.push(chunk.block)
  const second = { ...first, messages: [
    { role: 'assistant', content: blocks },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] },
  ] } as unknown as GenerateOptions
  for await (const _chunk of adapter.stream(second)) {}
  const messages = requests[1]!.messages as Record<string, unknown>[]
  assert.equal(messages[0]!.reasoning_content, 'I should look it up')
  assert.equal((messages[0]!.tool_calls as { id: string }[])[0]!.id, 'call-1')
  assert.equal(messages[1]!.role, 'tool')
  assert.equal(messages[1]!.tool_call_id, 'call-1')
})

test('stream maps network, idle timeout, and user cancellation distinctly', async () => {
  const options = { provider: 'qwen-subscription', model: 'm', messages: [] } as unknown as GenerateOptions
  const tokens = { async getAccessToken() { return 'token' } }
  const offline = new QwenAdapter({ tokens, streamIdleTimeoutMs: 10000, fetchFn: (async () => { throw new TypeError('offline') }) as typeof fetch })
  const consume = async (adapter: QwenAdapter, request: GenerateOptions) => { for await (const _ of adapter.stream(request)) {} }
  const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected
  await assert.rejects(consume(offline, options), code('TRANSPORT'))
  const hanging = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!; signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })) as typeof fetch
  const adapter = new QwenAdapter({ tokens, streamIdleTimeoutMs: 10, fetchFn: hanging })
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(consume(adapter, options), code('TIMEOUT'))
    const controller = new AbortController()
    const pending = consume(adapter, { ...options, signal: controller.signal })
    setTimeout(() => controller.abort(new Error('cancelled')), 1)
    await assert.rejects(pending, code('ABORTED'))
  } finally { clearTimeout(keepAlive) }
})

test('OAuth never exposes remote error strings or response bodies', async () => {
  const secret = 'secret-refresh-token-and-device-code'
  const client = new QwenOAuthClient((async () => json({ error: secret, error_description: secret }, 400)) as typeof fetch)
  await assert.rejects(client.refresh(secret), (error: unknown) => {
    assert.ok(error instanceof QwenOAuthError)
    assert.equal(error.code, 'oauth_error')
    assert.ok(!String(error).includes(secret))
    return true
  })
})

test('gateway error bodies cannot leak tokens; quota and retry metadata survive', async () => {
  const secret = 'access-secret'; let mode = 0
  const fetchFn = (async () => {
    if (mode === 0) return new Response('<html>' + secret + '</html>', { status: 502 })
    if (mode === 1) return json({ error: { code: 'insufficient_quota', message: 'Bearer ' + secret } }, 402)
    if (mode === 3) return json({ error: { code: 'other', message: 'insufficient_quota' } }, 402)
    if (mode === 4) return json({ error: { code: 'insufficient_quota' } }, 400)
    if (mode === 5) return json({ error: { code: 'context_length_exceeded', message: secret }, request_id: secret }, 400)
    if (mode === 6) return json({ error: { code: 'other', message: 'context_length_exceeded' } }, 400)
    return new Response(JSON.stringify({ error: { message: secret } }), { status: 429, headers: { 'retry-after': '7' } })
  }) as typeof fetch
  const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return secret } }, streamIdleTimeoutMs: 1000, fetchFn })
  const options = { provider: 'qwen-subscription', model: 'm', messages: [] } as unknown as GenerateOptions
  const fail = async () => { for await (const _ of adapter.stream(options)) {} }
  await assert.rejects(fail, (error: unknown) => error instanceof Error && !error.message.includes(secret) && !error.message.includes('<html>') && 'code' in error && error.code === 'SERVER')
  mode = 1; await assert.rejects(fail, (error: unknown) => error instanceof Error && !error.message.includes(secret) && 'code' in error && error.code === 'QUOTA')
  mode = 2; await assert.rejects(fail, (error: unknown) => error instanceof LlmError && !error.message.includes(secret) && error.code === 'RATE_LIMIT' && error.failure.providerRetryAfterMs === 7000)
  mode = 3; await assert.rejects(fail, (error: unknown) => error instanceof LlmError && error.code === 'HTTP_402')
  mode = 4; await assert.rejects(fail, (error: unknown) => error instanceof LlmError && error.code === 'HTTP_400')
  mode = 5; await assert.rejects(fail, (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED' && !error.message.includes(secret))
  mode = 6; await assert.rejects(fail, (error: unknown) => error instanceof LlmError && error.code === 'HTTP_400')
})

test('reasoning metadata and configured default control the wire', async () => {
  let request: Record<string, unknown> = {}
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  }) as typeof fetch
  const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, streamIdleTimeoutMs: 1000, fetchFn, defaultEffortOf: () => 'off' })
  const resolved = await adapter.resolveModel('qwen-subscription', 'm')
  assert.deepEqual(resolved.reasoning?.efforts.map(e => e.id), ['off', 'low', 'medium', 'high'])
  assert.equal(resolved.reasoning?.defaultEffort, 'off')
  for await (const _ of adapter.stream({ provider: 'qwen-subscription', model: 'm', messages: [] } as unknown as GenerateOptions)) {}
  assert.equal(request.enable_thinking, false); assert.equal(request.thinking_budget, undefined)
})

test('explicit gateway modalities remain explicit after host-compatible projection', async () => {
  const entries = [
    { id: 'audio', input_modalities: ['audio'] },
    { id: 'video', input_modalities: ['video'] },
    { id: 'pdf', input_modalities: ['pdf'] },
    { id: 'text', input_modalities: ['text'] },
    { id: 'image', input_modalities: ['text', 'image'] },
    { id: 'invalid', input_modalities: ['image', 'invalid'] },
  ]
  const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, fetchFn: (async () => json({ data: entries })) as typeof fetch, streamIdleTimeoutMs: 1000 })
  const models = await adapter.listModels('qwen-subscription')
  assert.deepEqual(models.map(m => m.inputModalities), [[], [], [], ['text'], ['text', 'image'], undefined])
  assert.deepEqual((await adapter.resolveModel('qwen-subscription', 'audio')).inputModalities, [])
  assert.deepEqual((await adapter.resolveModel('qwen-subscription', 'image')).inputModalities, ['text', 'image'])
})

test('temperature and stop preserve explicit zero and empty list without leaking prompt in errors', async () => {
  let request: Record<string, unknown> = {}
  const secret = 'private-prompt-text'
  const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, streamIdleTimeoutMs: 1000, fetchFn: (async (_url, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>
    return json({ error: { message: secret } }, 400)
  }) as typeof fetch })
  const options = { provider: 'qwen-subscription', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: secret }] }], temperature: 0, stop: [] } as unknown as GenerateOptions
  await assert.rejects(async () => { for await (const _ of adapter.stream(options)) {} }, (error: unknown) => error instanceof Error && !error.message.includes(secret))
  assert.equal(request.temperature, 0)
  assert.deepEqual(request.stop, [])
})

test('quota exhaustion parses only strict future Unix seconds and preserves conservative retry hints', async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600
  for (const retryAfter of [undefined, '1', '7200']) {
    let observed: { observedAt: number; resetsAt?: number } | undefined
    const adapter = new QwenAdapter({
      tokens: { async getAccessToken() { return 'token' } }, streamIdleTimeoutMs: 1000,
      onQuotaExhausted: value => { observed = value },
      fetchFn: async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'secret upstream', quota: { reset_at: reset } } }), { status: 402, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } }),
    })
    await assert.rejects(adapter.listModels('qwen-subscription'), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'QUOTA')
      const action = classifyPoolFailure(error, 'qwen-subscription')
      assert.equal(action.action, 'switch')
      if (action.action === 'switch' && 'cooldownMs' in action) {
        assert.equal(action.cooldownMs, error.failure.providerRetryAfterMs)
        assert.equal(action.scope, 'account')
      } else assert.fail('quota must produce account cooldown')
      assert.match(error.message, /quota exhausted/)
      assert.ok(error.message.includes(new Date(reset * 1000).toISOString()))
      assert.ok(!error.message.includes('secret upstream'))
      assert.equal(error.failure.providerRetryAfterMs, Math.max(reset * 1000 - observed!.observedAt, Number(retryAfter ?? 0) * 1000))
      return true
    })
    assert.equal(observed?.resetsAt, reset * 1000)
  }
  for (const invalid of [undefined, null, String(reset), reset + 0.1, 0, -1, Math.floor(Date.now() / 1000) - 1, 8640000000001, Number.MAX_SAFE_INTEGER]) {
    let observed: { observedAt: number; resetsAt?: number } | undefined
    const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, streamIdleTimeoutMs: 1000,
      onQuotaExhausted: value => { observed = value },
      fetchFn: async () => json({ error: { code: 'insufficient_quota', reset_at: reset, quota: { reset_at: invalid } } }, 402),
    })
    await assert.rejects(adapter.listModels('qwen-subscription'), (error: unknown) => error instanceof LlmError && error.code === 'QUOTA' && error.message.includes('reset not provided') && error.failure.providerRetryAfterMs === undefined)
    assert.ok(observed)
    assert.equal(observed.resetsAt, undefined)
  }
})

test('quota observations require both HTTP 402 and exact insufficient_quota code', async () => {
  for (const [status, code] of [[429, 'insufficient_quota'], [403, 'insufficient_quota'], [402, 'other'], [402, undefined]] as const) {
    const observations: unknown[] = []
    const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, streamIdleTimeoutMs: 1000,
      onQuotaExhausted: value => observations.push(value), fetchFn: async () => json({ error: { code, quota: { reset_at: Math.floor(Date.now() / 1000) + 60 } } }, status),
    })
    await assert.rejects(adapter.listModels('qwen-subscription'), (error: unknown) => error instanceof LlmError && error.code !== 'QUOTA')
    assert.deepEqual(observations, [])
  }
})

test('throwing quota observation hooks cannot replace sanitized QUOTA errors', async () => {
  const adapter = new QwenAdapter({ tokens: { async getAccessToken() { return 'token' } }, streamIdleTimeoutMs: 1000,
    onQuotaExhausted: () => { throw new Error('secret observer failure') },
    fetchFn: async () => json({ error: { code: 'insufficient_quota' } }, 402),
  })
  await assert.rejects(adapter.listModels('qwen-subscription'), (error: unknown) => error instanceof LlmError && error.code === 'QUOTA' && error.message.includes('quota exhausted') && !error.message.includes('secret'))
})
