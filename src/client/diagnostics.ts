/**
 * Composer controls (the Speed toggle and the usage badge) hide themselves
 * whenever the host's session model read or the plugin RPC fails, and a
 * transient failure must never remove them for good, so those failures are
 * swallowed and retried on the next poll. Swallowing them silently made a host
 * incompatibility indistinguishable from "nothing to show"; this logs each
 * distinct failure once per page so the browser console explains the absence.
 */
const reported = new Set<string>()

/**
 * Log one failure of a composer control, once per distinct message.
 * @param scope - the control that failed (for example `speed` or `usage-badge`).
 * @param step - the operation that failed, so a console line names what to look at.
 * @param error - the rejection value.
 */
export function warnOnce(scope: string, step: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const key = `${scope}\u0000${step}\u0000${message}`
  if (reported.has(key)) return
  reported.add(key)
  console.warn(`[dsh-plugin-subscriptions] ${scope}: ${step} failed; the control stays hidden until it succeeds: ${message}`)
}

/** Forget every logged failure (tests). */
export function resetWarnings(): void {
  reported.clear()
}
