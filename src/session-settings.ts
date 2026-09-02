/** Shared lookup for settings inherited through DSH session fork lineage. */

/** Resolve the nearest explicit value, walking from one session to its ancestors. */
export function inheritedSessionSetting<T>(
  values: ReadonlyMap<string, T>,
  sessionId: string,
  parentOf: (sessionId: string) => string | undefined,
): T | undefined {
  const seen = new Set<string>()
  let current: string | undefined = sessionId
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (values.has(current)) return values.get(current)
    current = parentOf(current)
  }
  return undefined
}
