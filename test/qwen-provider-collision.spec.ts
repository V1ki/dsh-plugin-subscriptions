/**
 * Integration test against the real Cordis/LLM registry. The pi-ai package is
 * not a project dependency, so the other plugin below emulates its one-adapter,
 * multi-route registration and atomic replace; no installed catalog is assumed.
 * Network responses and credentials are local fixtures.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as subscriptions from '../src/index.js'
import { saveAccountSession } from '../src/auth/store.js'
import { QWEN_GATEWAY_URL } from '../src/providers/qwen.js'

const QWEN_API = 'qwen' // The existing API route described by the scenario.
const QWEN_SUBSCRIPTION = 'qwen-subscription'
// pi-ai also permits user-declared routes, so these are deliberately test-only
// names rather than assumptions about a version-specific installed catalog.
const OTHER_HOST = 'fixture-api-gateway'
const ADDED_HOST = 'fixture-api-gateway-added'
const MODEL = 'fixture-shared-model' // Same model ID on purpose; provider selects the owner.
const SESSION_TOKEN = 'fixture-subscription-access'

class HostAdapter extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'Host ' + provider } }
  override async listModels(provider: string) { return [{ provider, id: MODEL, name: 'Host model ' + provider }] }
  override async resolveModel(provider: string, model: string) {
    assert.equal(model, MODEL)
    return { provider, id: model, name: 'Host model ' + provider, context: { contextWindow: 8192 } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'host:' + options.provider }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function text(chunks: readonly StreamChunk[]): string {
  return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
function sortedProviders(llm: LlmRuntime): string[] {
  return llm.listProviders().map(provider => provider.id).sort()
}

for (const order of ['host first', 'subscriptions first'] as const) {
  test('qwen API and subscription coexist: ' + order + ', including atomic refresh and teardown', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qwen-route-collision-'))
    const previousHome = process.env.DSH_HOME
    const previousFetch = globalThis.fetch
    process.env.DSH_HOME = home
    const requests: { url: string; authorization: string | null; model?: string }[] = []
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const authorization = new Headers(init?.headers).get('authorization')
      if (url === QWEN_GATEWAY_URL + '/models') {
        requests.push({ url, authorization })
        return Response.json({ data: [{ id: MODEL, input_modalities: ['text'], context_window_tokens: 65536 }] })
      }
      if (url === QWEN_GATEWAY_URL + '/chat/completions') {
        const body = JSON.parse(String(init?.body)) as { model: string }
        requests.push({ url, authorization, model: body.model })
        return new Response('data: {"choices":[{"index":0,"delta":{"content":"subscription"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      }
      throw new Error('Unexpected network request: ' + url)
    }
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    let hostHandle: AdapterRegistrationHandle | undefined
    let hostFiber: ReturnType<typeof ctx.plugin> | undefined
    let subscriptionFiber: ReturnType<typeof ctx.plugin> | undefined
    const host = {
      name: 'fixture-pi-ai-style-adapter', inject: ['llm'],
      apply(hostCtx: Context) { hostHandle = hostCtx.llm.registerAdapter([QWEN_API, OTHER_HOST], new HostAdapter()) },
    }
    const mountHost = async () => { hostFiber = ctx.plugin(host); await hostFiber.await(); assert.ok(hostHandle) }
    // Default configuration is intentional: every subscription route must not
    // steal the host's qwen route or prevent the host's whole batch from loading.
    const mountSubscriptions = async () => {
      subscriptionFiber = ctx.plugin(subscriptions, { pool: { enabled: false } })
      await subscriptionFiber.await()
    }
    try {
      if (order === 'host first') { await mountHost(); await mountSubscriptions() }
      else { await mountSubscriptions(); await mountHost() }
      assert.ok(hostHandle)
      const all = sortedProviders(llm)
      assert.ok(all.includes(QWEN_API), 'host qwen route must be registered')
      assert.ok(all.includes(QWEN_SUBSCRIPTION), 'subscription must use its distinct route')
      assert.ok(all.includes(OTHER_HOST), 'unrelated host routes survive the batch')
      assert.equal(new Set(all).size, all.length)
      assert.equal(llm.listProviders().find(p => p.id === QWEN_API)?.name, 'Host ' + QWEN_API)
      assert.equal(llm.listProviders().find(p => p.id === QWEN_SUBSCRIPTION)?.name, 'Qwen Subscription')
      assert.equal(llm.listProviders().find(p => p.id === OTHER_HOST)?.name, 'Host ' + OTHER_HOST)

      await saveAccountSession(QWEN_SUBSCRIPTION, 'fixture-account', {
        accessToken: SESSION_TOKEN, refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000,
        account: 'fixture-account', plan: 'Plus',
      })
      const apiCatalog = await llm.listModels(QWEN_API)
      const subCatalog = await llm.listModels(QWEN_SUBSCRIPTION)
      assert.deepEqual(apiCatalog.map(model => [model.provider, model.id, model.name]), [[QWEN_API, MODEL, 'Host model ' + QWEN_API]])
      assert.deepEqual(subCatalog.map(model => [model.provider, model.id]), [[QWEN_SUBSCRIPTION, MODEL]])
      assert.equal((await llm.resolveModelInfo(QWEN_API, MODEL)).context?.contextWindow, 8192)
      assert.equal((await llm.resolveModelInfo(QWEN_SUBSCRIPTION, MODEL)).context?.contextWindow, 65536)
      assert.equal(text(await collect(llm.stream({ provider: QWEN_API, model: MODEL, messages: [] }))), 'host:' + QWEN_API)
      assert.equal(text(await collect(llm.stream({ provider: OTHER_HOST, model: MODEL, messages: [] }))), 'host:' + OTHER_HOST)
      assert.equal(text(await collect(llm.stream({ provider: QWEN_SUBSCRIPTION, model: MODEL, messages: [] }))), 'subscription')
      assert.ok(requests.some(request => request.url.endsWith('/models')))
      assert.ok(requests.some(request => request.url.endsWith('/chat/completions') && request.model === MODEL))
      assert.ok(requests.every(request => request.authorization === 'Bearer ' + SESSION_TOKEN), 'only the subscription reaches its gateway')

      // pi-ai's update replaces its whole route set atomically. A conflicting
      // subscription route must reject the candidate without losing ANY old route.
      const before = sortedProviders(llm)
      assert.throws(() => hostHandle!.replace([QWEN_API, ADDED_HOST, QWEN_SUBSCRIPTION]),
        (error: unknown) => error instanceof LlmError && error.code === 'DUPLICATE_ADAPTER')
      assert.deepEqual(sortedProviders(llm), before)
      assert.equal(text(await collect(llm.stream({ provider: OTHER_HOST, model: MODEL, messages: [] }))), 'host:' + OTHER_HOST)
      assert.equal(text(await collect(llm.stream({ provider: QWEN_SUBSCRIPTION, model: MODEL, messages: [] }))), 'subscription')
      hostHandle.replace([QWEN_API, OTHER_HOST, ADDED_HOST])
      assert.ok(sortedProviders(llm).includes(ADDED_HOST))
      assert.ok(sortedProviders(llm).includes(QWEN_SUBSCRIPTION))
      assert.equal(text(await collect(llm.stream({ provider: ADDED_HOST, model: MODEL, messages: [] }))), 'host:' + ADDED_HOST)

      if (order === 'host first') {
        await subscriptionFiber!.dispose()
        assert.deepEqual(sortedProviders(llm), [ADDED_HOST, OTHER_HOST, QWEN_API].sort())
        assert.equal(text(await collect(llm.stream({ provider: QWEN_API, model: MODEL, messages: [] }))), 'host:' + QWEN_API)
      } else {
        await hostFiber!.dispose()
        assert.ok(sortedProviders(llm).includes(QWEN_SUBSCRIPTION))
        assert.ok(!sortedProviders(llm).includes(QWEN_API))
        assert.equal(text(await collect(llm.stream({ provider: QWEN_SUBSCRIPTION, model: MODEL, messages: [] }))), 'subscription')
      }
    } finally {
      await subscriptionFiber?.dispose()
      await hostFiber?.dispose()
      globalThis.fetch = previousFetch
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
}
