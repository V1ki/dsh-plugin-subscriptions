/** Antigravity OAuth, catalog/quota, request conversion, and stream tests. */

import { test } from 'node:test'
import { ToolCallId } from '../src/compat.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import assert from 'node:assert/strict'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AntigravitySession } from '../src/auth/store.js'
import {
  AntigravityAdapter,
  ANTIGRAVITY_AUTHORIZE_URL,
  ANTIGRAVITY_TOKEN_URL,
  ANTIGRAVITY_USERINFO_URL,
  antigravityFlow,
  antigravityGenerateURL,
  exchangeAntigravityCode,
  fetchAntigravityModels,
  fetchAntigravityUsage,
  refreshAntigravity,
  requestAntigravityContent,
} from '../src/providers/antigravity.js'
import type { CatalogSnapshot, FetchFn } from '../src/providers/common.js'
import {
  AntigravityStreamTranslator,
  streamAntigravity,
  toAntigravityRequest,
} from '../src/translate/antigravity.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

const oauth = { clientId: 'test-client.apps.example.invalid', clientSecret: 'test-secret' }
const runtime = { baseURL: 'https://antigravity.example.invalid', onboard: false }
const session: AntigravitySession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  projectId: 'project-123',
  account: 'user@example.invalid',
  plan: 'AI Pro',
}

interface RecordedCall {
  url: string
  init?: RequestInit
}

/** URL-routed injected fetch with call recording. */
function routed(routes: Record<string, unknown | Response>, calls: RecordedCall[] = []): FetchFn {
  return async (input, init) => {
    const url = String(input)
    calls.push({ url, ...init === undefined ? {} : { init } })
    const value = routes[url]
    if (value instanceof Response) return value
    if (value === undefined) throw new Error(`unexpected fetch ${url}`)
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

function message(role: Message['role'], content: ContentBlock[], source?: Message['source']): Message {
  return {
    id: MessageId(`m-${Math.random().toString(36).slice(2)}`),
    role,
    content,
    source: source ?? (role === 'assistant'
      ? { kind: 'model', provider: 'antigravity', model: 'gemini-3-flash' }
      : { kind: 'user' }),
  }
}

function options(messages: Message[]): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-3-flash',
    messages,
    system: 'Be useful.',
    maxTokens: 2048,
    temperature: 0.2,
    tools: [{
      name: 'bash',
      description: 'run a command',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
    }],
  }
}

test('Antigravity OAuth URL uses Google PKCE, offline access, and distinct Antigravity scopes', () => {
  const flow = antigravityFlow(oauth)
  const url = new URL(flow.buildAuthorizeUrl({
    redirectUri: 'http://localhost:51121/oauth-callback',
    state: 'state-1',
    nonce: 'nonce-1',
    pkce: { verifier: 'verifier', challenge: 'challenge' },
  }))
  assert.equal(url.origin + url.pathname, ANTIGRAVITY_AUTHORIZE_URL)
  assert.equal(url.searchParams.get('client_id'), oauth.clientId)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.match(url.searchParams.get('scope') ?? '', /experimentsandconfigs/)
  assert.doesNotMatch(url.searchParams.get('scope') ?? '', /gemini-cli/i)
})

test('exchangeAntigravityCode stores tokens, project, account, and plan without real credentials', async () => {
  const calls: RecordedCall[] = []
  const fetchFn = routed({
    [ANTIGRAVITY_TOKEN_URL]: {
      access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600, scope: 'scope-a',
    },
    [`${runtime.baseURL}/v1internal:loadCodeAssist`]: {
      cloudaicompanionProject: 'project-live', paidTier: { name: 'Google AI Pro' },
    },
    [ANTIGRAVITY_USERINFO_URL]: { email: 'person@example.invalid' },
  }, calls)
  const result = await exchangeAntigravityCode(
    'code-1', 'verifier-1', 'http://localhost:51121/oauth-callback', oauth, runtime, fetchFn,
  )
  assert.equal(result.accessToken, 'fresh-access')
  assert.equal(result.refreshToken, 'fresh-refresh')
  assert.equal(result.projectId, 'project-live')
  assert.equal(result.account, 'person@example.invalid')
  assert.equal(result.plan, 'Google AI Pro')
  const tokenForm = new URLSearchParams(String(calls[0].init?.body))
  assert.equal(tokenForm.get('client_id'), oauth.clientId)
  assert.equal(tokenForm.get('client_secret'), oauth.clientSecret)
  assert.equal(tokenForm.get('code_verifier'), 'verifier-1')
})

test('refreshAntigravity preserves a rotating-token omission and account metadata', async () => {
  const calls: RecordedCall[] = []
  const result = await refreshAntigravity(session, oauth, routed({
    [ANTIGRAVITY_TOKEN_URL]: { access_token: 'renewed', expires_in: 1800 },
  }, calls))
  assert.equal(result.accessToken, 'renewed')
  assert.equal(result.refreshToken, session.refreshToken)
  assert.equal(result.projectId, session.projectId)
  assert.equal(result.account, session.account)
  const form = new URLSearchParams(String(calls[0].init?.body))
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('refresh_token'), session.refreshToken)
})

test('model discovery and quota display map fetchAvailableModels data', async () => {
  const modelsURL = `${runtime.baseURL}/v1internal:fetchAvailableModels`
  const loadURL = `${runtime.baseURL}/v1internal:loadCodeAssist`
  const modelsPayload = {
    models: {
      'gemini-3-flash': {
        displayName: 'Gemini 3 Flash', inputTokenLimit: 500_000,
        quotaInfo: { remainingFraction: 0.7, resetTime: '2026-08-24T00:00:00Z' },
        weeklyQuotaInfo: { remainingFraction: 0.4, resetTime: '2026-08-30T00:00:00Z' },
      },
    },
  }
  const fetchFn = routed({
    [modelsURL]: modelsPayload,
    [loadURL]: { paidTier: { name: 'AI Ultra', availableCredits: [{ creditAmount: 42 }] } },
  })
  const models = await fetchAntigravityModels(session, runtime, fetchFn)
  assert.deepEqual(models, [{
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    contextWindow: 500_000,
    inputModalities: ['text', 'image'],
  }])
  const usage = await fetchAntigravityUsage(session, runtime, fetchFn)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, 'AI Ultra · 42 credits')
  assert.deepEqual(usage.windows?.map(window => [window.kind, window.scope, Math.round(window.usedPercent)]), [
    ['other', 'gemini-3-flash', 30],
    ['weekly', 'gemini-3-flash', 60],
  ])
})

test('request conversion carries system, images, tools, tool results, and signed tool replay', () => {
  const assistantSource = {
    kind: 'model' as const,
    provider: 'antigravity',
    model: 'gemini-3-flash',
    replayState: {
      response: { kind: 'antigravity', version: 1 },
      blocks: [{}, { thoughtSignature: 'signed-thought' }],
    },
  }
  const messages: TranslatableMessage[] = [
    message('user', [{ type: 'text', text: 'inspect' }]),
    message('assistant', [
      { type: 'text', text: 'running' },
      { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{"cmd":"ls"}' },
    ], assistantSource),
    message('user', [{
      type: 'tool-result', toolCallId: ToolCallId('call-1'), content: [{ type: 'text', text: '{"ok":true}' }],
    }], { kind: 'tool', callId: ToolCallId('call-1') }),
    {
      role: 'user',
      content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'aGVsbG8=' }],
    },
  ]
  const payload = toAntigravityRequest(options(messages as Message[]), messages, 'project-123')
  assert.equal(payload.project, 'project-123')
  assert.equal(payload.request.systemInstruction?.parts[0].text, 'Be useful.')
  assert.equal(payload.request.tools?.[0].functionDeclarations[0].name, 'bash')
  const modelParts = payload.request.contents.find(content => content.role === 'model')?.parts ?? []
  assert.equal(modelParts[1].functionCall?.name, 'bash')
  assert.equal(modelParts[1].thoughtSignature, 'signed-thought')
  const result = payload.request.contents.flatMap(content => content.parts).find(part => part.functionResponse)
  assert.deepEqual(result?.functionResponse?.response, { ok: true })
  const image = payload.request.contents.flatMap(content => content.parts).find(part => part.inlineData)
  assert.equal(image?.inlineData?.data, 'aGVsbG8=')
})

test('stream translator emits reasoning, text, tool call, usage, finish, and replay signature', () => {
  const translator = new AntigravityStreamTranslator()
  const chunks = translator.push({
    response: {
      candidates: [{
        content: { parts: [
          { thought: true, text: 'think', thoughtSignature: 'sig-1' },
          { text: 'answer' },
          { functionCall: { id: 'call-7', name: 'bash', args: { cmd: 'pwd' } }, thoughtSignature: 'sig-2' },
        ] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 2, candidatesTokenCount: 4, thoughtsTokenCount: 1 },
    },
  })
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'reasoning-delta', 'block-start', 'text-delta',
    'block-start', 'tool-call-delta', 'block-end', 'block-end', 'block-end', 'usage', 'finish',
  ])
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.deepEqual(usage?.usage, { inputTokens: 8, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1 })
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.reason.kind, 'tool-calls')
  const replay = finish?.type === 'finish'
    ? finish.replayState as { blocks?: unknown[] } | undefined
    : undefined
  assert.deepEqual(replay?.blocks, [
    { thoughtSignature: 'sig-1' }, {}, { thoughtSignature: 'sig-2' },
  ])
})

function byteStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

test('streamGenerateContent SSE and generateContent URL/forwarding are both supported', async () => {
  assert.equal(
    antigravityGenerateURL(runtime.baseURL, true),
    `${runtime.baseURL}/v1internal:streamGenerateContent?alt=sse`,
  )
  assert.equal(
    antigravityGenerateURL(runtime.baseURL, false),
    `${runtime.baseURL}/v1internal:generateContent`,
  )
  const streamed: StreamChunk[] = []
  const frame = { response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }
  for await (const chunk of streamAntigravity(byteStream(`data: ${JSON.stringify(frame)}\n\n`))) streamed.push(chunk)
  assert.deepEqual(streamed.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])

  const calls: RecordedCall[] = []
  const payload = toAntigravityRequest(options([message('user', [{ type: 'text', text: 'hi' }])]), [
    message('user', [{ type: 'text', text: 'hi' }]),
  ], session.projectId)
  await requestAntigravityContent(session, payload, false, runtime, routed({
    [`${runtime.baseURL}/v1internal:generateContent`]: { response: {} },
  }, calls))
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer access-token')
})

/** Isolated accounts: no disk, OAuth, or real subscription calls. */
function accountTokens(refresh: (value: AntigravitySession) => Promise<AntigravitySession> = async value => value) {
  const accounts = new Map<string, AntigravitySession>([
    ['alice', { ...session, account: 'alice', accessToken: 'alice', projectId: 'project-alice' }],
    ['bob', { ...session, account: 'bob', accessToken: 'bob', projectId: 'project-bob' }],
  ])
  const tokens = new AccountTokenManager<AntigravitySession>({
    provider: 'antigravity', displayName: 'Antigravity test',
    makeOptions: () => ({ preemptMs: 0, refresh, isPermanent: () => false }),
    io: {
      list: async () => [...accounts].map(([key, session]) => ({ key, session })),
      get: async key => accounts.get(key ?? 'alice'),
      save: async (key, value) => { accounts.set(key, value) },
      remove: async key => { accounts.delete(key) },
    },
  })
  return { tokens, accounts }
}

test('Antigravity discovery retains valid output caps without confusing maxTokens with output tokens', async () => {
  const invalid = [undefined, null, 0, -1, 1.5, '65535', Number.MAX_SAFE_INTEGER + 1]
  const models = await fetchAntigravityModels(session, runtime, routed({
    [`${runtime.baseURL}/v1internal:fetchAvailableModels`]: { models: {
      'gemini-3.1-pro-low': { maxTokens: 1048576, maxOutputTokens: 65535 },
      'gpt-oss-120b-medium': { maxTokens: 131072, maxOutputTokens: 32768 },
      ...Object.fromEntries(invalid.map((value, index) => [`invalid-${index}`, { maxTokens: 131072, maxOutputTokens: value }])),
    } },
  }))
  assert.equal(models[0].maxOutputTokens, 65535)
  assert.equal(models[1].maxOutputTokens, 32768)
  for (const model of models.slice(2)) assert.equal(Object.hasOwn(model, 'maxOutputTokens'), false)
})

test('Antigravity resolves per-model output defaults and bounds configured defaults to the catalog', async () => {
  const { tokens } = accountTokens()
  const limits: Record<string, number> = {
    'gemini-3.1-pro-low': 65535,
    'gpt-oss-120b-medium': 32768,
    'claude-sonnet-4-6': 64000,
    'gemini-3-flash': 65536,
    'tab_flash_lite_preview': 4096,
  }
  let fetches = 0
  const fetchFn: FetchFn = async () => {
    fetches++
    return Response.json({ models: Object.fromEntries(Object.entries(limits).map(([id, maxOutputTokens]) => [id, { maxOutputTokens }])) })
  }
  const adapter = new AntigravityAdapter({ tokens, models: [], discovery: true, streamIdleTimeoutMs: 1000, runtime, fetchFn })
  for (const [model, limit] of Object.entries(limits)) {
    const info = await adapter.resolveOwnModel('antigravity', model, 'alice')
    assert.equal(info.defaultMaxTokens, limit)
    const payload = toAntigravityRequest({ ...options([]), model, maxTokens: info.defaultMaxTokens }, [], session.projectId, true)
    assert.equal(payload.request.generationConfig?.maxOutputTokens, limit)
  }
  assert.equal(fetches, 1, 'successive model resolutions reuse the catalog')
  const configured = new AntigravityAdapter({
    tokens, discovery: true, streamIdleTimeoutMs: 1000, runtime, fetchFn,
    models: [{ id: 'gemini-3.1-pro-low', maxTokens: 8192 }, { id: 'gpt-oss-120b-medium', maxTokens: 65536 }],
  })
  assert.equal((await configured.resolveOwnModel('antigravity', 'gemini-3.1-pro-low', 'alice')).defaultMaxTokens, 8192)
  assert.equal((await configured.resolveOwnModel('antigravity', 'gpt-oss-120b-medium', 'alice')).defaultMaxTokens, 32768)
})

test('Antigravity output defaults remain account-scoped', async () => {
  const { tokens } = accountTokens()
  const adapter = new AntigravityAdapter({
    tokens, models: [], discovery: true, streamIdleTimeoutMs: 1000, runtime,
    fetchFn: async (_input, init) => Response.json({ models: {
      shared: { maxOutputTokens: new Headers(init?.headers).get('authorization') === 'Bearer alice' ? 65535 : 32768 },
    } }),
  })
  assert.equal((await adapter.resolveOwnModel('antigravity', 'shared', 'alice')).defaultMaxTokens, 65535)
  assert.equal((await adapter.resolveOwnModel('antigravity', 'shared', 'bob')).defaultMaxTokens, 32768)
})

test('Antigravity uses persisted output limits after restart without a network request', async () => {
  const { tokens } = accountTokens()
  let saved: CatalogSnapshot | undefined
  const catalogStore = {
    load: async () => saved,
    save: async (snapshot: CatalogSnapshot) => { saved = structuredClone(snapshot) },
    clear: async () => { saved = undefined },
  }
  const initial = new AntigravityAdapter({
    tokens, models: [], discovery: true, streamIdleTimeoutMs: 1000, runtime, catalogStore,
    fetchFn: async () => Response.json({ models: { 'gemini-3.1-pro-low': { maxOutputTokens: 65535 } } }),
  })
  assert.equal((await initial.resolveOwnModel('antigravity', 'gemini-3.1-pro-low', 'alice')).defaultMaxTokens, 65535)
  assert.equal(saved?.models[0].maxOutputTokens, 65535)
  let fetches = 0
  const restarted = new AntigravityAdapter({
    tokens, models: [], discovery: true, streamIdleTimeoutMs: 1000, runtime, catalogStore,
    fetchFn: async () => { fetches++; throw new Error('offline') },
  })
  assert.equal((await restarted.resolveOwnModel('antigravity', 'gemini-3.1-pro-low', 'alice')).defaultMaxTokens, 65535)
  assert.equal(fetches, 0)
})

test('Antigravity falls back for legacy caches, absent caps, failed discovery and discovery disabled', async () => {
  const { tokens } = accountTokens()
  const model = 'gemini-3.1-pro-low'
  for (const mode of ['legacy-cache', 'missing-cap', 'offline', 'disabled'] as const) {
    const adapter = new AntigravityAdapter({
      tokens, models: [], discovery: mode !== 'disabled', streamIdleTimeoutMs: 1000, runtime,
      ...(mode === 'legacy-cache' ? { catalogStore: {
        load: async () => ({ at: Date.now(), models: [{ id: model, name: model }] }),
        save: async () => {}, clear: async () => {},
      } } : {}),
      fetchFn: async () => {
        if (mode !== 'missing-cap') throw new Error('offline')
        return Response.json({ models: { [model]: {} } })
      },
    })
    assert.equal((await adapter.resolveOwnModel('antigravity', model, 'alice')).defaultMaxTokens, 32768, mode)
  }
  const configured = new AntigravityAdapter({
    tokens, models: [{ id: model, maxTokens: 8192 }], discovery: false, streamIdleTimeoutMs: 1000,
  })
  assert.equal((await configured.resolveOwnModel('antigravity', model, 'alice')).defaultMaxTokens, 8192)
})

test('Antigravity catalogs stay account-scoped and invalidate after account changes', async () => {
  const { tokens, accounts } = accountTokens()
  const reads: string[] = []
  const adapter = new AntigravityAdapter({
    tokens, models: [], discovery: true, streamIdleTimeoutMs: 1000, runtime,
    fetchFn: async (_input, init) => {
      const token = new Headers(init?.headers).get('authorization')!.slice(7)
      reads.push(token)
      return Response.json({ models: { [token]: { displayName: token, inputTokenLimit: token === 'alice' ? 100 : 200 } } })
    },
  })
  assert.deepEqual((await adapter.listModels('antigravity')).map(model => model.id), ['alice', 'bob'])
  assert.equal((await adapter.resolveOwnModel('antigravity', 'bob', 'bob')).context?.contextWindow, 200)
  assert.deepEqual((await adapter.listOwnModels('antigravity', 'alice')).map(model => model.id), ['alice'])
  assert.deepEqual(reads.sort(), ['alice', 'bob'])
  accounts.set('bob', { ...accounts.get('bob')!, accessToken: 'bob-new' })
  adapter.clearAccountCatalog('bob')
  assert.deepEqual((await adapter.listModels('antigravity')).map(model => model.id), ['alice', 'bob-new'])
  accounts.delete('alice')
  adapter.clearAccountCatalog('alice')
  assert.deepEqual((await adapter.listModels('antigravity')).map(model => model.id), ['bob-new'])
})

test('Antigravity retries a 401 with the selected account and refreshed project', async () => {
  const refreshed: string[] = []
  const { tokens, accounts } = accountTokens(async value => {
    refreshed.push(value.account!)
    return { ...value, accessToken: 'bob-refreshed', projectId: 'project-refreshed' }
  })
  const calls: { token: string | null; project: string }[] = []
  const adapter = new AntigravityAdapter({
    tokens, models: [], discovery: false, streamIdleTimeoutMs: 1000, runtime,
    fetchFn: async (_input, init) => {
      calls.push({ token: new Headers(init?.headers).get('authorization'), project: JSON.parse(String(init?.body)).project })
      if (calls.length === 1) return new Response('', { status: 401 })
      return new Response(byteStream(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } })}\n\n`))
    },
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.streamAccount(options([]), 'bob')) chunks.push(chunk)
  assert.deepEqual(refreshed, ['bob'])
  assert.deepEqual(calls, [
    { token: 'Bearer bob', project: 'project-bob' },
    { token: 'Bearer bob-refreshed', project: 'project-refreshed' },
  ])
  assert.equal(accounts.get('alice')?.accessToken, 'alice')
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('Antigravity discovery propagates cancellation instead of serving a fallback catalog', async () => {
  const { tokens } = accountTokens()
  const controller = new AbortController()
  controller.abort()
  const adapter = new AntigravityAdapter({
    tokens, models: [{ id: 'fallback' }], discovery: true, streamIdleTimeoutMs: 1000, runtime,
    fetchFn: async (_input, init) => { init?.signal?.throwIfAborted(); throw new Error('missing signal') },
  })
  await assert.rejects(adapter.listOwnModels('antigravity', 'alice', controller.signal), { name: 'AbortError' })
})

test('Antigravity preserves tool-result images after parallel tool responses', () => {
  const id = ToolCallId('image-call')
  const messages: TranslatableMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', id, name: 'inspect', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: id, content: [
      { type: 'text', text: 'screenshot' }, { type: 'image', mediaType: 'image/png', dataBase64: 'aW1hZ2U=' },
    ] }] },
  ]
  const parts = toAntigravityRequest(options([]), messages, session.projectId).request.contents.flatMap(content => content.parts)
  const responseIndex = parts.findIndex(part => part.functionResponse)
  const imageIndex = parts.findIndex(part => part.inlineData)
  assert.ok(responseIndex >= 0 && imageIndex > responseIndex)
  assert.equal(parts[imageIndex].inlineData?.data, 'aW1hZ2U=')
})

test('Antigravity fails over between accounts through the shared pool before emitting content', async () => {
  const { tokens } = accountTokens()
  const { PoolAdapter } = await import('../src/providers/pool.js')
  const { PoolHealthRegistry } = await import('../src/providers/pool-health.js')
  const { PoolUsageTracker } = await import('../src/providers/pool-usage.js')
  const { poolKey } = await import('../src/providers/pool-family.js')
  const visited: string[] = []
  let pool: InstanceType<typeof PoolAdapter> | undefined
  const adapter = new AntigravityAdapter({
    tokens, models: [{ id: 'gemini-3-flash' }], discovery: false, streamIdleTimeoutMs: 1000, runtime,
    pool: () => pool,
    fetchFn: async (_input, init) => {
      const token = new Headers(init?.headers).get('authorization')!
      visited.push(token)
      if (token === 'Bearer alice') return new Response('quota limited', { status: 429, headers: { 'retry-after': '60' } })
      return new Response(byteStream(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } })}\n\n`))
    },
  })
  pool = new PoolAdapter({
    adapters: { antigravity: adapter }, health: new PoolHealthRegistry(),
    usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
    defaultAccount: () => tokens.defaultAccount(), onWarn: () => {}, tiers: {},
    families: async () => new Map([[poolKey('antigravity', 'gemini-3-flash'), { members: [
      { provider: 'antigravity', model: 'gemini-3-flash', account: 'alice' },
      { provider: 'antigravity', model: 'gemini-3-flash', account: 'bob' },
    ] }]]),
  })
  assert.equal((await adapter.resolveModel('antigravity', 'gemini-3-flash')).id, 'gemini-3-flash')
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options([]))) chunks.push(chunk)
  assert.deepEqual(visited, ['Bearer alice', 'Bearer bob'])
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('Antigravity uses JSON Schema for Gemini and a detached custom-tool subset for Claude', () => {
  const input = options([])
  input.tools = [{ name: 'inspect', description: 'inspect', parameters: {
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    $defs: { path: { type: ['string', 'null'], description: 'path', minLength: 1 } },
    properties: { path: { $ref: '#/$defs/path' }, sandbox_permissions: { type: 'string', enum: ['danger-full-access'] } },
    required: ['path'], additionalProperties: false,
  } }]
  const original = structuredClone(input.tools)
  const gemini = toAntigravityRequest(input, [], session.projectId).request.tools![0].functionDeclarations[0]
  assert.equal(gemini.parameters, undefined)
  const json = gemini.parametersJsonSchema as Record<string, unknown>
  assert.equal(json.$schema, undefined)
  assert.equal(json.$defs, undefined)
  assert.deepEqual((json.properties as Record<string, unknown>).path, { type: ['string', 'null'], description: 'path', minLength: 1 })
  const claude = toAntigravityRequest({ ...input, model: 'claude-sonnet-4-6' }, [], session.projectId).request.tools![0].functionDeclarations[0]
  assert.equal(claude.parametersJsonSchema, undefined)
  const legacy = claude.parameters as Record<string, unknown>
  assert.deepEqual(legacy.required, ['path'])
  assert.equal(legacy.additionalProperties, undefined)
  assert.deepEqual((legacy.properties as Record<string, unknown>).path, { type: 'string', description: 'path' })
  assert.deepEqual(input.tools, original, 'do not mutate DSH registry schemas')
})

test('Antigravity rejects unresolved and recursive tool references before provider I/O', () => {
  for (const parameters of [
    { type: 'object', properties: { path: { $ref: '#/$defs/missing' } } },
    { type: 'object', $defs: { node: { $ref: '#/$defs/node' } }, properties: { node: { $ref: '#/$defs/node' } } },
  ]) {
    assert.throws(() => toAntigravityRequest({ ...options([]), tools: [{ name: 'test', description: '', parameters }] }, [], session.projectId), /reference/)
  }
})

test('Antigravity reasoning uses supported runtime budgets and rejects unsupported effort or token limits', async () => {
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  for (const [model, effort, budget] of [
    ['gemini-3-flash', 'high', -1], ['gemini-3.1-pro-high', 'high', 10001],
    ['claude-sonnet-4-6', 'high', 1024], ['gpt-oss-120b', 'medium', 8192],
  ] as const) {
    const payload = toAntigravityRequest({ ...options([]), model, reasoningEffort: ReasoningEffortId(effort), maxTokens: 20000 }, [], session.projectId)
    assert.deepEqual(payload.request.generationConfig?.thinkingConfig, { includeThoughts: true, thinkingBudget: budget })
  }
  assert.throws(() => toAntigravityRequest({ ...options([]), model: 'claude-sonnet-4-6', reasoningEffort: ReasoningEffortId('high'), maxTokens: 512 }, [], session.projectId), /thinking budget/)
  assert.throws(() => toAntigravityRequest({ ...options([]), reasoningEffort: ReasoningEffortId('ultra') }, [], session.projectId), /does not support/)
  const { tokens } = accountTokens()
  const adapter = new AntigravityAdapter({ tokens, models: [], discovery: false, streamIdleTimeoutMs: 1000, defaultEffortOf: () => 'high' })
  const info = await adapter.resolveModel('antigravity', 'gemini-3-flash')
  assert.deepEqual(info.reasoning?.efforts.map(entry => entry.id), ['low', 'medium', 'high'])
  assert.equal(info.reasoning?.defaultEffort, 'high')
})

test('Claude streaming caps maxOutputTokens at 64000 to avoid INVALID_ARGUMENT on high limits', () => {
  const claudeStream = toAntigravityRequest({ ...options([]), model: 'claude-opus-4-6-thinking', maxTokens: 65536 }, [], session.projectId, true)
  assert.equal(claudeStream.request.generationConfig?.maxOutputTokens, 64000)
  const claudeNonStream = toAntigravityRequest({ ...options([]), model: 'claude-opus-4-6-thinking', maxTokens: 65536 }, [], session.projectId, false)
  assert.equal(claudeNonStream.request.generationConfig?.maxOutputTokens, 65536)
  const geminiStream = toAntigravityRequest({ ...options([]), model: 'gemini-3-flash', maxTokens: 65536 }, [], session.projectId, true)
  assert.equal(geminiStream.request.generationConfig?.maxOutputTokens, 65536)
  const claudeStreamLow = toAntigravityRequest({ ...options([]), model: 'claude-sonnet-4-6', maxTokens: 2048 }, [], session.projectId, true)
  assert.equal(claudeStreamLow.request.generationConfig?.maxOutputTokens, 2048)
})

test('Antigravity replays signed text and reasoning only for the same provider and model', () => {
  const source = {
    kind: 'model' as const, provider: 'antigravity', model: 'gemini-3-flash',
    replayState: { response: { kind: 'antigravity', version: 1 }, blocks: [
      { thoughtSignature: 'reasoning-signature' }, { thoughtSignature: 'text-signature' },
    ] },
  }
  const messages = [message('assistant', [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }], source)]
  const payload = toAntigravityRequest(options(messages), messages, session.projectId)
  assert.deepEqual(payload.request.contents[0].parts, [
    { thought: true, text: 'thought', thoughtSignature: 'reasoning-signature' },
    { text: 'answer', thoughtSignature: 'text-signature' },
  ])
  const changed = toAntigravityRequest({ ...options(messages), model: 'claude-sonnet-4-6' }, messages, session.projectId)
  assert.deepEqual(changed.request.contents[0].parts, [{ text: 'answer' }])
})

test('Antigravity falls back from daily to production before streaming on endpoint failure', async () => {
  const calls: string[] = []
  const payload = toAntigravityRequest(options([]), [], session.projectId)
  const response = await requestAntigravityContent(session, payload, true, {}, async (input, init) => {
    calls.push(String(input))
    assert.deepEqual(JSON.parse(String(init?.body)), payload)
    return calls.length === 1 ? new Response('unavailable', { status: 503 }) : new Response('ok')
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  ])
})

test('Antigravity does not route around auth, quota, explicit endpoints, or cancellation', async () => {
  const payload = toAntigravityRequest(options([]), [], session.projectId)
  for (const status of [400, 401, 403, 429]) {
    let calls = 0
    const response = await requestAntigravityContent(session, payload, false, {}, async () => { calls++; return new Response('', { status }) })
    assert.equal(response.status, status)
    assert.equal(calls, 1)
  }
  let calls = 0
  await requestAntigravityContent(session, payload, false, runtime, async input => {
    calls++; assert.ok(String(input).startsWith(runtime.baseURL)); return new Response('', { status: 503 })
  })
  assert.equal(calls, 1)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(requestAntigravityContent(session, payload, true, {}, async () => {
    assert.fail('cancelled request must not reach any endpoint')
  }, controller.signal), { name: 'AbortError' })
})

test('Antigravity catalog discovery shares endpoint fallback', async () => {
  const calls: string[] = []
  const models = await fetchAntigravityModels(session, {}, async input => {
    calls.push(String(input))
    if (calls.length === 1) throw new TypeError('network failure')
    return Response.json({ models: { 'gemini-3-flash': { displayName: 'Gemini' } } })
  })
  assert.equal(models[0].id, 'gemini-3-flash')
  assert.equal(calls.length, 2)
  assert.ok(calls[1].startsWith('https://cloudcode-pa.googleapis.com/'))
})

test('Antigravity OAuth selects defaults or one complete override source without mixing secrets', async () => {
  const { resolveAntigravityOAuthConfig } = await import('../src/providers/antigravity.js')
  const clientId = process.env.ANTIGRAVITY_CLIENT_ID
  const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET
  try {
    delete process.env.ANTIGRAVITY_CLIENT_ID
    delete process.env.ANTIGRAVITY_CLIENT_SECRET
    const defaults = resolveAntigravityOAuthConfig()
    assert.match(defaults.clientId, /\.apps\.googleusercontent\.com$/)
    assert.ok(defaults.clientSecret && defaults.clientSecret.length > 10)
    assert.deepEqual(resolveAntigravityOAuthConfig({ clientId: '  ', clientSecret: ' ' }), defaults)
    assert.deepEqual(resolveAntigravityOAuthConfig(oauth), oauth)
    assert.deepEqual(resolveAntigravityOAuthConfig({ clientId: 'pkce-client' }), { clientId: 'pkce-client' })
    process.env.ANTIGRAVITY_CLIENT_ID = ' env-client '
    process.env.ANTIGRAVITY_CLIENT_SECRET = ' env-secret '
    assert.deepEqual(resolveAntigravityOAuthConfig(), { clientId: 'env-client', clientSecret: 'env-secret' })
    assert.deepEqual(resolveAntigravityOAuthConfig(oauth), oauth)
    assert.deepEqual(resolveAntigravityOAuthConfig({ clientId: 'pkce-client' }), { clientId: 'pkce-client' })
    delete process.env.ANTIGRAVITY_CLIENT_SECRET
    assert.deepEqual(resolveAntigravityOAuthConfig(), { clientId: 'env-client' })
    assert.throws(() => resolveAntigravityOAuthConfig({ clientSecret: 'unpaired' }), /requires config.antigravity.clientId/)
    delete process.env.ANTIGRAVITY_CLIENT_ID
    process.env.ANTIGRAVITY_CLIENT_SECRET = 'unpaired'
    assert.throws(() => resolveAntigravityOAuthConfig(), /requires ANTIGRAVITY_CLIENT_ID/)
  } finally {
    if (clientId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID
    else process.env.ANTIGRAVITY_CLIENT_ID = clientId
    if (clientSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET
    else process.env.ANTIGRAVITY_CLIENT_SECRET = clientSecret
  }
})
