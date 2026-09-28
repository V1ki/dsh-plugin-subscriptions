/** Model-specific tool schemas for Antigravity's Gemini and custom-tool bridges. */
import { LlmError } from '@deepseek-ai/dsh-llm'

type Schema = Record<string, unknown>
const CUSTOM_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum'])

function object(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve local references before removing definitions; reject cycles and remote references. */
function resolve(value: unknown, root: Schema, refs = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map(item => resolve(item, root, refs))
  if (!object(value)) return value
  if (typeof value.$ref === 'string') {
    const ref = value.$ref
    if (!ref.startsWith('#/') || refs.has(ref)) {
      throw new LlmError(`Antigravity tool schema has an unsupported reference: ${ref}`, 'INVALID_REQUEST')
    }
    let target: unknown = root
    for (const segment of ref.slice(2).split('/')) {
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~')
      target = object(target) && Object.hasOwn(target, key) ? target[key] : undefined
    }
    if (!object(target)) throw new LlmError(`Antigravity tool schema reference is missing: ${ref}`, 'INVALID_REQUEST')
    const { $ref: _ref, ...siblings } = value
    return resolve({ ...target, ...siblings }, root, new Set([...refs, ref]))
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['$schema', '$id', '$defs', 'definitions'].includes(key))
    .map(([key, item]) => [key, key === 'properties' && object(item)
      ? Object.fromEntries(Object.entries(item).map(([name, property]) => [name, resolve(property, root, refs)]))
      : resolve(item, root, refs)]))
}

/** Numeric types widen to `number`: every integer is also a number. */
const NUMERIC = new Set(['integer', 'number'])

/** The strings one alternative is limited to (`enum` or `const`), or undefined when unconstrained. */
function stringChoices(schema: Schema): string[] | undefined {
  if (typeof schema.const === 'string') return [schema.const]
  return Array.isArray(schema.enum) && schema.enum.every(entry => typeof entry === 'string') ? schema.enum : undefined
}

/**
 * Fold schema alternatives into one shape this bridge can express, never
 * narrower than any alternative: picking one branch would make the tool
 * uncallable with the others' values, which is worse than a looser contract
 * the tool still validates. Objects keep the union of their properties and
 * only the fields every alternative requires; scalars of one type keep that
 * type (and a string choice union); anything heterogeneous is unconstrained.
 */
function widen(variants: readonly unknown[]): Schema {
  const members = variants.filter(object)
  if (members.length === 0 || members.length !== variants.length) return {}
  const types = new Set(members.map(member => member.type))
  const type = types.size === 1 ? [...types][0]
    : [...types].every(entry => typeof entry === 'string' && NUMERIC.has(entry)) ? 'number' : undefined
  if (typeof type !== 'string') return {}
  if (type === 'object') {
    const properties: Schema = {}
    for (const member of members) {
      if (!object(member.properties)) continue
      for (const [name, property] of Object.entries(member.properties)) {
        properties[name] = !Object.hasOwn(properties, name) || JSON.stringify(properties[name]) === JSON.stringify(property)
          ? property
          : widen([properties[name], property])
      }
    }
    const required = members
      .map(member => Array.isArray(member.required) ? member.required.filter(entry => typeof entry === 'string') : [])
      .reduce((shared, next) => shared.filter(name => next.includes(name)))
    return {
      type,
      ...Object.keys(properties).length === 0 ? {} : { properties },
      ...required.length === 0 ? {} : { required },
    }
  }
  if (type === 'array') {
    return { type, items: widen(members.map(member => member.items ?? {})) }
  }
  const choices = members.map(stringChoices)
  return choices.every(entry => entry !== undefined)
    ? { type, enum: [...new Set(choices.flat())] }
    : { type }
}

/** Merge `extra` into `schema`: properties and required accumulate, other keywords override. */
function absorb(schema: Schema, extra: Schema): void {
  const { properties, required, ...rest } = extra
  Object.assign(schema, rest)
  if (object(properties)) schema.properties = { ...object(schema.properties) ? schema.properties : {}, ...properties }
  if (Array.isArray(required)) {
    schema.required = [...new Set([...Array.isArray(schema.required) ? schema.required : [], ...required])]
  }
}

/** Keep property names intact while reducing schema keywords for Claude/GPT-OSS. */
function custom(value: unknown): unknown {
  if (!object(value)) return value
  const schema = { ...value }
  // An intersection holds every member's constraints at once.
  if (Array.isArray(schema.allOf)) {
    const members = schema.allOf.filter(object)
    delete schema.allOf
    for (const member of members) absorb(schema, member)
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[keyword])) continue
    const variants = schema[keyword].filter(item => !object(item) || item.type !== 'null')
    delete schema[keyword]
    absorb(schema, variants.length === 1 && object(variants[0]) ? variants[0] : widen(variants))
  }
  const out: Schema = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_KEYS.has(key)) continue
    if (key === 'properties' && object(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, custom(property)]))
    } else if (key === 'items') out[key] = custom(value)
    else if (key === 'type' && Array.isArray(value)) {
      const types = value.filter(type => type !== 'null')
      const type = types.length === 1 ? types[0]
        : types.length > 0 && types.every(entry => NUMERIC.has(entry as string)) ? 'number' : undefined
      if (type !== undefined) out[key] = type
    } else if (key !== 'enum' || Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
      out[key] = value
    }
  }
  return out
}

/** Detach and normalize one tool's root object without changing the registry schema. */
export function antigravityToolParameters(parameters: Schema, legacy: boolean): Schema {
  const resolved = resolve(parameters, parameters) as Schema
  const root = { ...resolved, type: resolved.type ?? 'object' }
  if (root.type !== 'object') throw new LlmError('Antigravity tool parameters must be an object schema', 'INVALID_REQUEST')
  return (legacy ? custom(root) : root) as Schema
}
