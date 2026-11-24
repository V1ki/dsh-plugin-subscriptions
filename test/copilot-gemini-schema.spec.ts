/**
 * Unit tests for Copilot Gemini `/chat/completions` tool-schema sanitization.
 * Covers DSH built-in tool shapes (`str_replace_editor`, `run_workflow`,
 * `propose_action`, `cordis_inspect_query`) as well as MCP/JSON Schema
 * constructs rejected by Copilot's Gemini proxy with HTTP 400
 * `invalid_request_body`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCopilotGeminiModel,
  sanitizeCopilotGeminiChatTools,
  sanitizeCopilotGeminiSchema,
} from '../src/translate/copilot-gemini-schema.js'

test('isCopilotGeminiModel matches bare and prefixed Gemini model IDs only', () => {
  assert.equal(isCopilotGeminiModel('gemini-4-hydrogen'), true)
  assert.equal(isCopilotGeminiModel('gemini-3.8-flash'), true)
  assert.equal(isCopilotGeminiModel('google/gemini-4-argon'), true)
  assert.equal(isCopilotGeminiModel('  Gemini-2.5-Pro  '), true)
  assert.equal(isCopilotGeminiModel('claude-sonnet-5.5'), false)
  assert.equal(isCopilotGeminiModel('gpt-4.1'), false)
  assert.equal(isCopilotGeminiModel('gpt-5.6-sol'), false)
  assert.equal(isCopilotGeminiModel('grok-4.7'), false)
})

test('sanitizes DSH built-in str_replace_editor nullable oneOf parameters without mutating input', () => {
  const input: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
      path: { type: 'string', description: 'Absolute path.' },
      file_text: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Content to create.' },
      insert_line: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Line number.' },
      view_range: {
        oneOf: [
          { type: 'array', items: { type: 'integer' } },
          { type: 'null' },
        ],
        description: 'Start and end line.',
      },
    },
    required: ['command', 'path'],
  }
  const snapshot = structuredClone(input)
  const sanitized = sanitizeCopilotGeminiSchema(input)

  assert.deepEqual(sanitized, {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
      path: { type: 'string', description: 'Absolute path.' },
      file_text: { type: 'string', nullable: true, description: 'Content to create.' },
      insert_line: { type: 'integer', nullable: true, description: 'Line number.' },
      view_range: {
        type: 'array',
        items: { type: 'integer' },
        nullable: true,
        description: 'Start and end line.',
      },
    },
    required: ['command', 'path'],
  })
  assert.deepEqual(input, snapshot, 'caller schema must never be mutated')
})

test('sanitizes DSH built-in workflow/action-card free objects and cordis untyped json properties', () => {
  const workflowParams: Record<string, unknown> = {
    type: 'object',
    properties: {
      script: { type: 'string' },
      args: { type: 'object', additionalProperties: true, description: 'Optional JSON input.' },
    },
    required: ['script'],
  }
  assert.deepEqual(sanitizeCopilotGeminiSchema(workflowParams), {
    type: 'object',
    properties: {
      script: { type: 'string' },
      args: { type: 'object', properties: {}, description: 'Optional JSON input.' },
    },
    required: ['script'],
  })

  const cordisParams: Record<string, unknown> = {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      input: { description: 'Optional arbitrary JSON payload.' },
    },
    required: ['provider'],
  }
  assert.deepEqual(sanitizeCopilotGeminiSchema(cordisParams), {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      input: { type: 'string', description: 'Optional arbitrary JSON payload.' },
    },
    required: ['provider'],
  })
})

test('normalizes JSON Schema type arrays (nullable single-type and multi-type MCP schemas)', () => {
  const mcpParams: Record<string, unknown> = {
    type: 'object',
    properties: {
      folder: { type: ['string', 'null'], description: 'Target folder.' },
      count: { type: ['integer', 'number', 'null'] },
      value: {
        type: ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'],
        description: 'Arbitrary dashboard field value.',
      },
      onlyNull: { type: 'null' },
    },
  }
  const sanitized = sanitizeCopilotGeminiSchema(mcpParams)
  const props = sanitized.properties as Record<string, Record<string, unknown>>

  assert.deepEqual(props.folder, { type: 'string', nullable: true, description: 'Target folder.' })
  assert.deepEqual(props.count, { type: 'number', nullable: true })
  assert.deepEqual(props.onlyNull, { type: 'string', nullable: true })

  // Multi-type array becomes distinct-type `anyOf` with no sibling `type` or `nullable`.
  assert.equal('type' in props.value!, false)
  assert.equal('nullable' in props.value!, false)
  assert.equal(props.value!.description, 'Arbitrary dashboard field value.')
  assert.deepEqual(props.value!.anyOf, [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'object', properties: {} },
    { type: 'array', items: { type: 'string' } },
  ])
})

test('folds disjoint object unions, overlapping scalar anyOf, sibling type+anyOf, and root unions', () => {
  const schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      // Disjoint object union (Codex create_thread / WorkIQ retrieve pattern)
      target: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: { const: 'project' },
              projectId: { type: 'string' },
            },
            required: ['type', 'projectId'],
            additionalProperties: false,
          },
          {
            properties: {
              type: { type: 'string', enum: ['none'] },
            },
            required: ['type'],
            additionalProperties: false,
          },
        ],
      },
      // Overlapping scalar anyOf (magpie#5952)
      label: {
        anyOf: [
          { type: 'string', enum: ['a', 'b'] },
          { type: 'string' },
        ],
      },
      limit: {
        anyOf: [
          { type: 'integer', minimum: 1, maximum: 10 },
          { type: 'integer', minimum: 5, maximum: 20 },
        ],
      },
      // Sibling `type` beside nullable `anyOf` (magpie#4374)
      typedNullable: {
        type: 'string',
        anyOf: [{ type: 'string' }, { type: 'null' }],
      },
    },
    required: ['target'],
  }

  assert.deepEqual(sanitizeCopilotGeminiSchema(schema), {
    type: 'object',
    properties: {
      target: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['project', 'none'] },
          projectId: { type: 'string' },
        },
        required: ['type'],
      },
      label: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      typedNullable: { type: 'string', nullable: true },
    },
    required: ['target'],
  })

  // Root-level union collapses into an object schema with shared required fields.
  const rootUnion: Record<string, unknown> = {
    anyOf: [
      { type: 'object', properties: { kind: { const: 'a' }, x: { type: 'string' } }, required: ['kind', 'x'] },
      { type: 'object', properties: { kind: { const: 'b' }, y: { type: 'integer' } }, required: ['kind', 'y'] },
    ],
  }
  assert.deepEqual(sanitizeCopilotGeminiSchema(rootUnion), {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['a', 'b'] },
      x: { type: 'string' },
      y: { type: 'integer' },
    },
    required: ['kind'],
  })
})

test('handles bare arrays, tuple prefixItems, array enums, non-string enums, $ref/$defs, cycles, x-*, and bad required', () => {
  const schema: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.com/tool.json',
    type: 'object',
    $defs: {
      ById: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      ByPath: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      Node: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          next: { $ref: '#/$defs/Node' },
        },
      },
    },
    properties: {
      bareArray: { type: 'array', uniqueItems: true },
      tuple: { prefixItems: [{ type: 'string' }, { type: 'integer' }] },
      arrayWithEnum: { type: 'array', enum: ['fast', 'slow'] },
      duration: { type: 'integer', enum: [60, 1440], description: 'Auto-archive minutes.' },
      target: { anyOf: [{ $ref: '#/$defs/ById' }, { $ref: '#/$defs/ByPath' }] },
      cyclic: { $ref: '#/$defs/Node' },
      boolTrue: true,
      boolFalse: false,
      // Property names matching stripped keywords must NEVER be dropped.
      format: { type: 'string', format: 'uri', 'x-mcp-header': 'X-Test', default: 'https://a.test' },
      'x-custom': { type: 'string' },
    },
    required: ['bareArray', 'boolFalse', 'doesNotExist'],
    additionalProperties: false,
  }

  assert.deepEqual(sanitizeCopilotGeminiSchema(schema), {
    type: 'object',
    properties: {
      bareArray: { type: 'array', items: { type: 'string' } },
      tuple: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
      arrayWithEnum: { type: 'array', items: { type: 'string', enum: ['fast', 'slow'] } },
      duration: { type: 'integer', description: 'Auto-archive minutes. Allowed values: 60, 1440.' },
      target: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
        },
      },
      cyclic: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          next: { type: 'string' },
        },
      },
      boolTrue: { type: 'string' },
      format: { type: 'string' },
      'x-custom': { type: 'string' },
    },
    required: ['bareArray'],
  })
})

test('sanitizeCopilotGeminiChatTools deduplicates tool names and ensures non-empty descriptions', () => {
  const tools: Record<string, unknown>[] = [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: '',
        parameters: { type: 'object' },
      },
    },
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'duplicate should be dropped',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ping',
        description: 'ping tool',
        parameters: {},
      },
    },
  ]

  const sanitized = sanitizeCopilotGeminiChatTools(tools)
  assert.deepEqual(sanitized, [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'No description provided',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ping',
        description: 'ping tool',
        parameters: { type: 'object', properties: {} },
      },
    },
  ])
})
