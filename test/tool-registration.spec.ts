import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerWithAlias, TOOL_ALIASES } from '../src/tools/registration.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

function definition(name: string): ToolDefinition {
  return { name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'ok' } as unknown as ToolDefinition
}

function registry(occupied: string[]) {
  const names = new Set(occupied)
  return {
    names,
    register(tool: ToolDefinition) {
      if (names.has(tool.name)) throw new Error(`${tool.name} already registered`)
      names.add(tool.name)
      return () => names.delete(tool.name)
    },
  }
}

test('registerWithAlias uses the canonical name when available', () => {
  const tools = registry([])
  const result = registerWithAlias(tools, definition('x_search'))
  assert.equal(result?.name, 'x_search')
  assert.deepEqual([...tools.names], ['x_search'])
})

test('registerWithAlias falls back to the plugin namespace on collision', () => {
  const tools = registry(['x_search'])
  const result = registerWithAlias(tools, definition('x_search'))
  assert.equal(result?.name, TOOL_ALIASES.x_search)
  assert.deepEqual([...tools.names].sort(), ['dsh_subscriptions_x_search', 'x_search'])
})

test('registerWithAlias skips and warns when canonical and alias collide', () => {
  const tools = registry(['x_search', TOOL_ALIASES.x_search])
  const warnings: string[] = []
  const result = registerWithAlias(tools, definition('x_search'), message => warnings.push(message))
  assert.equal(result, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /x_search/)
  assert.deepEqual([...tools.names].sort(), ['dsh_subscriptions_x_search', 'x_search'])
})

test('registerWithAlias uses the plugin namespace for a host-owned tool even when the canonical name is free', () => {
  const tools = registry([])
  const result = registerWithAlias(tools, definition('image_generate'))
  assert.equal(result?.name, TOOL_ALIASES.image_generate)
  assert.deepEqual([...tools.names], [TOOL_ALIASES.image_generate])
})

test('registerWithAlias never claims the canonical name of a host-owned tool', () => {
  const tools = registry([TOOL_ALIASES.image_generate])
  const warnings: string[] = []
  const result = registerWithAlias(tools, definition('image_generate'), message => warnings.push(message))
  assert.equal(result, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /image_generate/)
  assert.deepEqual([...tools.names], [TOOL_ALIASES.image_generate])
})
