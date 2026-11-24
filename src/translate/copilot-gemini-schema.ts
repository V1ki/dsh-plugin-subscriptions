/**
 * Copilot Gemini `/chat/completions` tool-schema sanitizer.
 *
 * GitHub Copilot proxies Gemini models through a Vertex/Gemini Schema
 * translation layer that rejects standard JSON Schema constructs other
 * Copilot backends (Claude, GPT) accept, returning a generic HTTP 400
 * `invalid_request_body`. This module normalizes tool definitions at the
 * Copilot Gemini chat boundary without mutating caller schemas or touching
 * non-Gemini models.
 */

type Schema = Record<string, unknown>

const MAX_REF_DEPTH = 32
const SCALAR_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean'])
const NUMERIC_TYPES = new Set(['integer', 'number'])

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a Copilot model identifier targets a Gemini model (bare `gemini-*`
 * or vendor-prefixed `google/gemini-*`, case-insensitive).
 * @param model - wire model identifier.
 * @returns true when the model is a Gemini model.
 */
export function isCopilotGeminiModel(model: string): boolean {
  const trimmed = model.trim()
  const slash = trimmed.lastIndexOf('/')
  const bare = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return bare.toLowerCase().startsWith('gemini')
}

/** Whether a raw schema node represents solely JSON Schema `null`. */
function isNullSchema(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'null') return true
  if (Array.isArray(value.type) && value.type.length === 1 && value.type[0] === 'null') return true
  if (value.const === null && value.type === undefined && value.anyOf === undefined && value.oneOf === undefined) {
    return true
  }
  return false
}

/** Resolve a local JSON Pointer (`#/...`) against `root`, or return undefined. */
function lookupLocalRef(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return isRecord(current) ? current : undefined
}

const SUBSCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const SUBSCHEMA_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
const SUBSCHEMA_SINGLE_KEYS = new Set(['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'contentSchema'])

/**
 * Resolve local `$ref` pointers (gracefully dropping cyclic or unresolvable
 * refs), coerce boolean subschemas, and strip JSON Schema meta/$defs/x-*
 * keywords without altering property names under `properties`.
 */
function preprocessSchema(
  value: unknown,
  root: Schema,
  refs: ReadonlySet<string> = new Set(),
  depth = 0,
): Schema | undefined {
  if (value === true) return {}
  if (value === false) return undefined
  if (!isRecord(value)) return undefined
  if (depth > MAX_REF_DEPTH) return {}

  if (typeof value.$ref === 'string') {
    const ref = value.$ref
    const { $ref: _ignored, ...siblings } = value
    if (!refs.has(ref)) {
      const target = lookupLocalRef(root, ref)
      if (target !== undefined) {
        const nextRefs = new Set(refs)
        nextRefs.add(ref)
        return preprocessSchema({ ...target, ...siblings }, root, nextRefs, depth + 1)
      }
    }
    return preprocessSchema(siblings, root, refs, depth + 1)
  }

  const out: Schema = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      key === '$schema'
      || key === '$id'
      || key === '$anchor'
      || key === '$dynamicRef'
      || key === '$dynamicAnchor'
      || key === '$defs'
      || key === 'definitions'
      || key === '$comment'
      || key.startsWith('x-')
    ) {
      continue
    }
    if (key === 'properties' && isRecord(item)) {
      const props: Schema = {}
      for (const [propName, propSchema] of Object.entries(item)) {
        const resolved = preprocessSchema(propSchema, root, refs, depth + 1)
        if (resolved !== undefined) props[propName] = resolved
      }
      out.properties = props
      continue
    }
    if (SUBSCHEMA_MAP_KEYS.has(key)) {
      continue
    }
    if (key === 'items') {
      if (Array.isArray(item)) {
        const tuple = item
          .map(entry => preprocessSchema(entry, root, refs, depth + 1))
          .filter((entry): entry is Schema => entry !== undefined)
        out.items = tuple
      } else {
        const resolved = preprocessSchema(item, root, refs, depth + 1)
        if (resolved !== undefined) out.items = resolved
      }
      continue
    }
    if (SUBSCHEMA_LIST_KEYS.has(key) && Array.isArray(item)) {
      const list = item
        .map(entry => preprocessSchema(entry, root, refs, depth + 1))
        .filter((entry): entry is Schema => entry !== undefined)
      out[key] = list
      continue
    }
    if (SUBSCHEMA_SINGLE_KEYS.has(key)) {
      continue
    }
    out[key] = item
  }
  return out
}

/** Append an extra hint sentence to a description without duplicating it. */
function appendDescription(existing: unknown, note: string): string {
  const base = typeof existing === 'string' ? existing.trim() : ''
  if (base.length === 0) return note
  if (base.includes(note)) return base
  return `${base} ${note}`
}

/** Deduplicate string lists in insertion order. */
function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value === 'string' && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

/** Merge `extra` into `target` for `allOf` intersections. */
function absorbIntersection(target: Schema, extra: Schema): void {
  const { properties, required, ...rest } = extra
  for (const [key, value] of Object.entries(rest)) {
    if (target[key] === undefined) target[key] = value
  }
  if (isRecord(properties)) {
    const mergedProps: Schema = isRecord(target.properties) ? { ...target.properties } : {}
    for (const [name, prop] of Object.entries(properties)) {
      if (!Object.hasOwn(mergedProps, name)) {
        mergedProps[name] = prop
      } else if (isRecord(mergedProps[name]) && isRecord(prop)) {
        const combined: Schema = { ...mergedProps[name] }
        absorbIntersection(combined, prop)
        mergedProps[name] = combined
      }
    }
    target.properties = mergedProps
  }
  if (Array.isArray(required)) {
    const prev = Array.isArray(target.required) ? target.required : []
    const next = uniqueStrings([...prev, ...required])
    if (next.length > 0) target.required = next
  }
}

/** Expand a JSON Schema `type: [...]` array into single-type branches. */
function expandTypeArray(node: Schema, types: readonly string[]): Schema[] {
  const branches: Schema[] = []
  const seen = new Set<string>()
  for (const rawType of types) {
    if (!SCALAR_TYPES.has(rawType) || seen.has(rawType)) continue
    seen.add(rawType)
    const branch: Schema = { type: rawType }
    if (rawType === 'object') {
      if (isRecord(node.properties)) branch.properties = node.properties
      if (Array.isArray(node.required)) branch.required = node.required
    } else if (rawType === 'array') {
      if (node.items !== undefined) branch.items = node.items
      if (typeof node.minItems === 'number') branch.minItems = node.minItems
      if (typeof node.maxItems === 'number') branch.maxItems = node.maxItems
    } else if (rawType === 'string') {
      if (Array.isArray(node.enum)) {
        const strings = uniqueStrings(node.enum)
        if (strings.length > 0) branch.enum = strings
      }
      if (typeof node.minLength === 'number') branch.minLength = node.minLength
      if (typeof node.maxLength === 'number') branch.maxLength = node.maxLength
      if (typeof node.pattern === 'string') branch.pattern = node.pattern
    } else if (rawType === 'integer' || rawType === 'number') {
      if (typeof node.minimum === 'number') branch.minimum = node.minimum
      if (typeof node.maximum === 'number') branch.maximum = node.maximum
    }
    branches.push(normalizeNode(branch, false))
  }
  return branches
}

/** Merge two normalized schemas of the same scalar type into one widened schema. */
function mergeSameTypeGroup(typeKey: string, branches: readonly Schema[]): Schema {
  if (branches.length === 1) return { ...branches[0]! }

  const description = branches.map(b => b.description).find(d => typeof d === 'string' && d.length > 0)
  const title = branches.map(b => b.title).find(t => typeof t === 'string' && t.length > 0)
  const nullable = branches.some(b => b.nullable === true)

  if (typeKey === 'object') {
    const properties: Schema = {}
    for (const branch of branches) {
      if (!isRecord(branch.properties)) continue
      for (const [name, prop] of Object.entries(branch.properties)) {
        if (!isRecord(prop)) continue
        if (!Object.hasOwn(properties, name)) {
          properties[name] = prop
        } else if (isRecord(properties[name]) && JSON.stringify(properties[name]) !== JSON.stringify(prop)) {
          properties[name] = mergeUnionBranches([properties[name], prop], false, false)
        }
      }
    }
    const requiredSets = branches.map(branch =>
      new Set(Array.isArray(branch.required) ? uniqueStrings(branch.required) : []),
    )
    const sharedRequired = [...(requiredSets[0] ?? [])].filter(name =>
      Object.hasOwn(properties, name) && requiredSets.every(set => set.has(name)),
    )
    return {
      type: 'object',
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
      properties,
      ...sharedRequired.length > 0 ? { required: sharedRequired } : {},
      ...nullable ? { nullable: true } : {},
    }
  }

  if (typeKey === 'array') {
    const itemSchemas = branches
      .map(branch => (isRecord(branch.items) ? branch.items : { type: 'string' }))
    const items = mergeUnionBranches(itemSchemas, false, false)
    return {
      type: 'array',
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
      items,
      ...nullable ? { nullable: true } : {},
    }
  }

  if (typeKey === 'string') {
    // Only keep enum if EVERY branch constrains via string enum; an unconstrained
    // string branch subsumes any enum branch (Copilot Gemini 400s on overlapping
    // scalar anyOf like [{type:"string",enum:[...]}, {type:"string"}]).
    const allHaveEnums = branches.every(b => Array.isArray(b.enum) && b.enum.length > 0)
    const enumValues = allHaveEnums
      ? uniqueStrings(branches.flatMap(b => (Array.isArray(b.enum) ? b.enum : [])))
      : []
    return {
      type: 'string',
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
      ...enumValues.length > 0 ? { enum: enumValues } : {},
      ...nullable ? { nullable: true } : {},
    }
  }

  if (typeKey === 'numeric') {
    const allInteger = branches.every(b => b.type === 'integer')
    const minimums = branches.map(b => b.minimum).filter((v): v is number => typeof v === 'number')
    const maximums = branches.map(b => b.maximum).filter((v): v is number => typeof v === 'number')
    return {
      type: allInteger ? 'integer' : 'number',
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
      ...minimums.length === branches.length ? { minimum: Math.min(...minimums) } : {},
      ...maximums.length === branches.length ? { maximum: Math.max(...maximums) } : {},
      ...nullable ? { nullable: true } : {},
    }
  }

  return {
    type: typeKey,
    ...title === undefined ? {} : { title },
    ...description === undefined ? {} : { description },
    ...nullable ? { nullable: true } : {},
  }
}

/**
 * Merge normalized non-null union branches into the narrowest Gemini-accepted
 * representation:
 * - Root unions always collapse into one `object` schema.
 * - Single branch unwraps directly (preserving `nullable: true`).
 * - Same-type / numeric branches fold into one widened schema (eliminating
 *   disjoint object `anyOf` and overlapping scalar `anyOf` 400s).
 * - Multi-type unions keep at most one branch per canonical type under `anyOf`
 *   with no sibling `type` or `nullable`.
 */
function mergeUnionBranches(
  branches: readonly Schema[],
  nullable: boolean,
  isRoot: boolean,
  annotations?: { description?: string; title?: string },
): Schema {
  const flat: Schema[] = []
  for (const branch of branches) {
    if (Array.isArray(branch.anyOf)) {
      for (const inner of branch.anyOf) {
        if (isRecord(inner)) flat.push(inner)
      }
    } else {
      flat.push(branch)
    }
  }

  if (isRoot) {
    const objectBranches = flat.filter(b => b.type === 'object')
    const merged = objectBranches.length > 0
      ? mergeSameTypeGroup('object', objectBranches)
      : { type: 'object', properties: {} }
    delete merged.nullable
    if (annotations?.title !== undefined && merged.title === undefined) merged.title = annotations.title
    if (annotations?.description !== undefined && merged.description === undefined) {
      merged.description = annotations.description
    }
    return merged
  }

  if (flat.length === 0) {
    return {
      type: 'string',
      ...annotations?.title === undefined ? {} : { title: annotations.title },
      ...annotations?.description === undefined ? {} : { description: annotations.description },
      ...nullable ? { nullable: true } : {},
    }
  }

  // Group branches by canonical type (grouping integer+number together so
  // overlapping numeric ranges fold cleanly into one branch).
  const groups = new Map<string, Schema[]>()
  for (const branch of flat) {
    const rawType = typeof branch.type === 'string' ? branch.type : undefined
    if (rawType === undefined || !SCALAR_TYPES.has(rawType)) {
      // Untyped branch: degrade gracefully to string rather than sending an
      // untyped union branch that Copilot Gemini rejects with 400.
      return {
        type: 'string',
        ...annotations?.title === undefined ? {} : { title: annotations.title },
        ...annotations?.description === undefined ? {} : { description: annotations.description },
        ...nullable ? { nullable: true } : {},
      }
    }
    const groupKey = NUMERIC_TYPES.has(rawType) ? 'numeric' : rawType
    const existing = groups.get(groupKey)
    if (existing === undefined) groups.set(groupKey, [branch])
    else existing.push(branch)
  }

  const mergedGroups = [...groups.entries()].map(([key, group]) => mergeSameTypeGroup(key, group))
  if (mergedGroups.length === 1) {
    const single = { ...mergedGroups[0]! }
    if (nullable) single.nullable = true
    if (annotations?.title !== undefined) single.title = annotations.title
    if (annotations?.description !== undefined) single.description = annotations.description
    return single
  }

  // Distinct multi-type union: emit pure `anyOf` (no sibling `type`,
  // `nullable`, `properties`, or `items`, which Copilot Gemini rejects).
  return {
    ...annotations?.title === undefined ? {} : { title: annotations.title },
    ...annotations?.description === undefined ? {} : { description: annotations.description },
    anyOf: mergedGroups,
  }
}

/** Recursively normalize one preprocessed schema node for Copilot Gemini. */
function normalizeNode(input: Schema, isRoot: boolean): Schema {
  const working: Schema = { ...input }

  // 1. Fold `allOf` intersections into `working` first.
  if (Array.isArray(working.allOf)) {
    const members = working.allOf.filter(isRecord)
    delete working.allOf
    for (const member of members) {
      absorbIntersection(working, normalizeNode(member, false))
    }
  }

  const title = typeof working.title === 'string' && working.title.length > 0 ? working.title : undefined
  let description = typeof working.description === 'string' && working.description.length > 0
    ? working.description
    : undefined
  let nullable = working.nullable === true

  // 2. Normalize tuple arrays (`prefixItems` or array-valued `items`).
  const tupleItems = Array.isArray(working.prefixItems)
    ? working.prefixItems.filter(isRecord)
    : Array.isArray(working.items)
      ? working.items.filter(isRecord)
      : undefined
  if (tupleItems !== undefined || working.prefixItems !== undefined) {
    delete working.prefixItems
    if (!isRecord(working.items)) {
      const normalizedTuple = (tupleItems ?? []).map(entry => normalizeNode(entry, false))
      working.items = normalizedTuple.length > 0
        ? mergeUnionBranches(normalizedTuple, false, false)
        : { type: 'string' }
    }
    if (working.type === undefined) working.type = 'array'
  }

  // 3. Handle `const`.
  if (Object.hasOwn(working, 'const')) {
    const constValue = working.const
    delete working.const
    if (constValue === null) {
      nullable = true
    } else if (typeof constValue === 'string') {
      if (working.type === undefined) working.type = 'string'
      working.enum = [constValue]
    } else if (typeof constValue === 'number') {
      if (working.type === undefined) working.type = Number.isInteger(constValue) ? 'integer' : 'number'
      description = appendDescription(description, `Must be ${String(constValue)}.`)
    } else if (typeof constValue === 'boolean') {
      if (working.type === undefined) working.type = 'boolean'
      description = appendDescription(description, `Must be ${String(constValue)}.`)
    }
  }

  // 4. Handle union keywords (`oneOf` / `anyOf`) before scalar `type` arrays so
  //    nullable unions like `str_replace_editor`'s `oneOf: [T, {type: "null"}]`
  //    collapse cleanly to `{ ...T, nullable: true }`.
  const rawUnion = [
    ...Array.isArray(working.anyOf) ? working.anyOf : [],
    ...Array.isArray(working.oneOf) ? working.oneOf : [],
  ]
  if (rawUnion.length > 0) {
    const nonNullBranches: Schema[] = []
    for (const branch of rawUnion) {
      if (isNullSchema(branch)) {
        nullable = true
      } else if (isRecord(branch)) {
        nonNullBranches.push(normalizeNode(branch, false))
      }
    }
    return mergeUnionBranches(nonNullBranches, nullable, isRoot, {
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
    })
  }

  // 5. Handle JSON Schema `type: [...]` arrays.
  if (Array.isArray(working.type)) {
    const rawTypes = uniqueStrings(working.type)
    if (rawTypes.includes('null')) nullable = true
    const nonNullTypes = rawTypes.filter(t => t !== 'null' && SCALAR_TYPES.has(t))
    if (nonNullTypes.length === 0) {
      working.type = 'string'
    } else if (nonNullTypes.length === 1) {
      working.type = nonNullTypes[0]
    } else if (nonNullTypes.every(t => NUMERIC_TYPES.has(t))) {
      working.type = 'number'
    } else {
      const branches = expandTypeArray(working, nonNullTypes)
      return mergeUnionBranches(branches, nullable, isRoot, {
        ...title === undefined ? {} : { title },
        ...description === undefined ? {} : { description },
      })
    }
  }

  // 6. Handle standalone `{ type: 'null' }`.
  if (working.type === 'null') {
    nullable = true
    working.type = 'string'
  }

  // 7. Handle `enum` (Gemini Schema only accepts string enums; non-string enums
  //    and array-level enums trigger HTTP 400).
  let stringEnum: string[] | undefined
  if (Array.isArray(working.enum)) {
    const rawEnum = working.enum
    const hasNull = rawEnum.includes(null)
    if (hasNull) nullable = true
    const nonNull = rawEnum.filter(value => value !== null)

    if (working.type === 'array') {
      // Enum placed directly on an array belongs on its string items, else drop.
      if (nonNull.length > 0 && nonNull.every(v => typeof v === 'string')) {
        const itemsObj: Schema = isRecord(working.items) ? { ...working.items } : { type: 'string' }
        if (itemsObj.type === undefined || itemsObj.type === 'string') {
          itemsObj.type = 'string'
          itemsObj.enum = uniqueStrings(nonNull)
          working.items = itemsObj
        }
      }
    } else if (
      nonNull.length > 0
      && nonNull.every(v => typeof v === 'string')
      && (working.type === undefined || working.type === 'string')
    ) {
      working.type = 'string'
      stringEnum = uniqueStrings(nonNull)
    } else if (nonNull.length > 0) {
      // Non-string enum (e.g. integer/number/boolean enum): infer scalar type
      // if omitted, drop enum from wire schema, and preserve choices in description.
      if (working.type === undefined) {
        if (nonNull.every(v => typeof v === 'number' && Number.isInteger(v))) working.type = 'integer'
        else if (nonNull.every(v => typeof v === 'number')) working.type = 'number'
        else if (nonNull.every(v => typeof v === 'boolean')) working.type = 'boolean'
        else working.type = 'string'
      }
      const preview = nonNull.map(v => String(v)).join(', ')
      description = appendDescription(description, `Allowed values: ${preview}.`)
    }
  }

  // 8. Resolve final scalar `type`.
  let resolvedType: string
  if (isRoot) {
    resolvedType = 'object'
  } else if (typeof working.type === 'string' && SCALAR_TYPES.has(working.type)) {
    resolvedType = working.type
  } else if (isRecord(working.properties)) {
    resolvedType = 'object'
  } else if (isRecord(working.items)) {
    resolvedType = 'array'
  } else if (typeof working.minimum === 'number' || typeof working.maximum === 'number') {
    resolvedType = 'number'
  } else {
    resolvedType = 'string'
  }

  // 9. Emit a clean type-allowlisted Gemini schema node.
  const out: Schema = { type: resolvedType }
  if (title !== undefined) out.title = title
  if (description !== undefined) out.description = description

  if (resolvedType === 'object') {
    const properties: Schema = {}
    if (isRecord(working.properties)) {
      for (const [propName, propSchema] of Object.entries(working.properties)) {
        if (isRecord(propSchema)) {
          properties[propName] = normalizeNode(propSchema, false)
        }
      }
    }
    out.properties = properties
    if (Array.isArray(working.required)) {
      const validRequired = uniqueStrings(working.required).filter(name => Object.hasOwn(properties, name))
      if (validRequired.length > 0) out.required = validRequired
    }
  } else if (resolvedType === 'array') {
    out.items = isRecord(working.items) ? normalizeNode(working.items, false) : { type: 'string' }
    if (typeof working.minItems === 'number') out.minItems = working.minItems
    if (typeof working.maxItems === 'number') out.maxItems = working.maxItems
  } else if (resolvedType === 'string') {
    if (stringEnum !== undefined && stringEnum.length > 0) out.enum = stringEnum
    if (typeof working.minLength === 'number') out.minLength = working.minLength
    if (typeof working.maxLength === 'number') out.maxLength = working.maxLength
    if (typeof working.pattern === 'string') out.pattern = working.pattern
  } else if (resolvedType === 'integer' || resolvedType === 'number') {
    if (typeof working.minimum === 'number') out.minimum = working.minimum
    if (typeof working.maximum === 'number') out.maximum = working.maximum
  }

  if (nullable && !isRoot) out.nullable = true
  return out
}

/**
 * Sanitize one tool's JSON Schema `parameters` object for GitHub Copilot's
 * Gemini `/chat/completions` endpoint without mutating the input.
 * @param parameters - tool parameter schema.
 * @returns a Gemini-compatible object-rooted JSON Schema.
 */
export function sanitizeCopilotGeminiSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const preprocessed = preprocessSchema(parameters, parameters) ?? {}
  return normalizeNode(preprocessed, true)
}

/**
 * Sanitize a Chat Completions `tools` array for GitHub Copilot's Gemini models:
 * deduplicates tools by function name (keeping the first declaration), ensures
 * a non-empty description, and normalizes every `function.parameters` schema.
 * Input objects are never mutated.
 * @param tools - wire Chat Completions tools produced by `toChatTools`.
 * @returns sanitized tools array ready for Copilot Gemini `/chat/completions`.
 */
export function sanitizeCopilotGeminiChatTools(
  tools: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const seenNames = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const tool of tools) {
    const fn = isRecord(tool.function) ? tool.function : undefined
    if (fn === undefined) {
      out.push(tool)
      continue
    }
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (name.length > 0) {
      if (seenNames.has(name)) continue
      seenNames.add(name)
    }
    const description = typeof fn.description === 'string' && fn.description.trim().length > 0
      ? fn.description
      : 'No description provided'
    const parameters = isRecord(fn.parameters)
      ? sanitizeCopilotGeminiSchema(fn.parameters)
      : { type: 'object', properties: {} }
    out.push({
      ...tool,
      function: {
        ...fn,
        description,
        parameters,
      },
    })
  }
  return out
}
