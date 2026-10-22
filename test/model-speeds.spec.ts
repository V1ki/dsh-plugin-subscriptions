import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelSpeeds } from '../src/model-speeds.js'

test('composer model speeds persist independently and concurrent writes retain all choices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-speeds-'))
  try {
    const path = join(dir, 'speeds.json')
    const store = new ModelSpeeds(path)
    assert.equal(store.get('unseen'), undefined)
    await Promise.all([store.set('first', 'fast'), store.set('second', 'standard'), store.set('__proto__', 'fast')])
    const restored = new ModelSpeeds(path)
    assert.equal(restored.get('first'), 'fast')
    assert.equal(restored.get('second'), 'standard')
    assert.equal(restored.get('__proto__'), 'fast')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), JSON.parse('{"first":"fast","second":"standard","__proto__":"fast"}'))
    await writeFile(path, '{"first":"invalid"}')
    assert.throws(() => new ModelSpeeds(path), /Cannot read model speeds/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
