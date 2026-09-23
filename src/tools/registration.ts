import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Tool names owned by this plugin and their collision fallbacks. */
export const TOOL_ALIASES = {
  x_search: 'dsh_subscriptions_x_search',
  video_generate: 'dsh_subscriptions_video_generate',
  image_generate: 'dsh_subscriptions_image_generate',
} as const

/**
 * Names the DSH composition already owns, so this plugin registers the tool
 * under {@link TOOL_ALIASES} without a canonical attempt.
 *
 * DSH Desktop mounts `dsh-image-generation` as its one shared image tool, and
 * that plugin claims `image_generate` unconditionally: whichever side reaches
 * the registry second is the one that fails. If this plugin claims the name
 * first, the host's `apply` throws, which aborts the whole plugin tree instead
 * of only skipping one tool. The scoped alias is the only order-independent
 * choice. `x_search` and `video_generate` have no host owner, so they keep the
 * canonical-first rule from issue #76.
 */
export const HOST_OWNED_TOOLS: ReadonlySet<string> = new Set(['image_generate'])

export interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/** Register one tool under the plugin-scoped alias, or skip it when taken. */
function registerScoped(
  registry: ToolRegistry,
  definition: ToolDefinition,
  alias: string,
  warn: (message: string) => void,
): { name: string; dispose: () => void } | undefined {
  try {
    return { name: alias, dispose: registry.register({ ...definition, name: alias }) }
  } catch (aliasError) {
    warn(`dsh-plugin-subscriptions: tool ${JSON.stringify(definition.name)} and alias ${JSON.stringify(alias)} are already registered; skipping (${aliasError instanceof Error ? aliasError.message : String(aliasError)})`)
    return undefined
  }
}

/** Register a tool under its canonical name, then a plugin-scoped alias. */
export function registerWithAlias(
  registry: ToolRegistry,
  definition: ToolDefinition,
  warn: (message: string) => void = message => console.warn(message),
): { name: string; dispose: () => void } | undefined {
  const alias = TOOL_ALIASES[definition.name as keyof typeof TOOL_ALIASES]
  if (alias === undefined) return { name: definition.name, dispose: registry.register(definition) }
  if (HOST_OWNED_TOOLS.has(definition.name)) return registerScoped(registry, definition, alias, warn)
  try {
    return { name: definition.name, dispose: registry.register(definition) }
  } catch {
    return registerScoped(registry, definition, alias, warn)
  }
}
