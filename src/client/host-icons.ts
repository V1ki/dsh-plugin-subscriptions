/**
 * Glyphs from the host's icon set that survive its renames. DSH 0.1.7
 * renamed the 16px glyphs from `Icon<Name>16` to `Icon<Name>Regular`. The
 * client reads host modules at runtime, so a named import of a glyph the
 * host no longer exports is `undefined`, and rendering it crashes the whole
 * slot (React error #130).
 */
import type { ComponentType } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** A decorative glyph the host lacks renders nothing rather than crashing. */
const NoIcon: ComponentType<IconProps> = () => null

/**
 * Resolve one 16px glyph under either host naming.
 * @param icons - the host primitives module (`import * as`), read by name.
 * @param name - the glyph name without prefix or size, e.g. `Sparkle`.
 * @returns the host's component, or one rendering nothing.
 */
export function hostIcon(icons: object, name: string): ComponentType<IconProps> {
  const exports = icons as Record<string, ComponentType<IconProps> | undefined>
  return exports[`Icon${name}Regular`] ?? exports[`Icon${name}16`] ?? NoIcon
}
