import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPreferencesAdapter, accountModelId } from '../src/providers/account-preferences.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import { AntigravityStreamTranslator, toAntigravityContents } from '../src/translate/antigravity.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { poolKey } from '../src/providers/pool-family.js'

for (const mode of ['independent', 'pool'] as const) test(`${mode} routes retain signed replay only for the originating account and model`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-replay-'))
  const model = 'gemini-3-test'
  let wire: ReturnType<typeof toAntigravityContents> = []
  class Raw extends LlmAdapter {
    listOwnModels = async (provider: string) => [{ provider, id: model, name: model }]
    resolveOwnModel = async (provider: string, id: string) => ({ provider, id, name: id })
    clearAccountCatalog() {}
    async *stream(): AsyncIterable<StreamChunk> { throw new Error('use account seam') }
    async *streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
      wire = toAntigravityContents(options.messages, options.model)
      const translator = new AntigravityStreamTranslator()
      yield* translator.push({ response: { candidates: [{ content: { parts: [
        { thought: true, text: 'signed reasoning', thoughtSignature: `signature-${account}` }, { text: 'OK' },
      ] }, finishReason: 'STOP' }] } })
    }
  }
  const raw = new Raw()
  const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
  await settings.set('antigravity', { accounts: { a: { independentEntry: true }, b: { independentEntry: true } } })
  let member = 'a'
  const pool = new PoolAdapter({ adapters: { antigravity: raw }, health: new PoolHealthRegistry(), usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
    defaultAccount: async () => 'a', families: async () => new Map([[poolKey('antigravity', 'tier'), { members: [{ provider: 'antigravity', account: member, model }] }]]), tiers: {}, onWarn: () => {} })
  const route = new AccountPreferencesAdapter({ provider: 'antigravity', adapter: raw, settings, accounts: async () => ['a', 'b'].map(key => ({ key, label: key })), pool: () => mode === 'pool' ? pool : undefined })
  const llm = new LlmRuntime(new Context())
  const dispose = llm.registerAdapter(['antigravity'], route)
  const selected = mode === 'pool' ? 'tier' : accountModelId('a', model)
  const history: Message[] = []
  try {
    const content: Message['content'][number][] = []
    let replayState
    for await (const chunk of llm.stream({ provider: 'antigravity', model: selected, messages: [] })) {
      if (chunk.type === 'block-end') content.push(chunk.block)
      if (chunk.type === 'finish') replayState = chunk.replayState
    }
    assert.ok(replayState)
    history.push({ role: 'assistant', id: MessageId('signed'), source: { kind: 'model', provider: 'antigravity', model: selected, replayState }, content })
    const saved = structuredClone(history)
    for await (const _ of llm.stream({ provider: 'antigravity', model: selected, messages: history })) { /* drain */ }
    assert.ok(wire.some(message => message.parts.some(part => part.thoughtSignature === 'signature-a')), 'same route must preserve signed thinking')
    member = 'b'; pool.invalidate()
    const next = mode === 'pool' ? 'tier' : accountModelId('b', model)
    for await (const _ of llm.stream({ provider: 'antigravity', model: next, messages: history })) { /* drain */ }
    assert.equal(wire.some(message => message.parts.some(part => part.thoughtSignature === 'signature-a')), false, 'different account must not inherit private replay')
    assert.deepEqual(history, saved, 'durable history stays unchanged')
  } finally { dispose(); await rm(dir, { recursive: true, force: true }) }
})
