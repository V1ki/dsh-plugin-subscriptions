/**
 * GLM Coding Plan model discovery.
 *
 * The Coding Plan endpoint is OpenAI-compatible and the minted plan key can
 * list the account's models through `GET {station}/api/paas/v4/models`. That
 * list tracks new releases (for example glm-5.4) before the public ZCode
 * client config does, so the picker follows it instead of a static catalog.
 * Only the current `glm-5*` generation is offered; the account-wide list also
 * contains older and domain-specific variants that the plan does not serve.
 */
import type { GlmSession } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from './common.js'

/** OpenAI-compatible API root per station (no `/api/paas/v4` suffix). */
function rootOf(station: GlmSession['station']): string {
  return station === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn'
}

/**
 * List the account's Coding Plan models.
 * @param session - the minted-key session.
 * @param fetchFn - transport (injectable for tests).
 * @param signal - caller cancellation.
 * @returns model IDs in server order; throws when the endpoint fails or is empty.
 */
export async function fetchGlmModels(
  session: GlmSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetchFn(`${rootOf(session.station)}/api/paas/v4/models`, {
    headers: { 'authorization': `Bearer ${session.accessToken}`, 'accept': 'application/json' },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(`GLM model discovery failed (HTTP ${String(response.status)})`)
  const body = await response.json() as { data?: unknown }
  const rows = Array.isArray(body.data) ? body.data : []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const id = (row as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    if (!/^glm-5(?:[.-]|$)/i.test(id) || /-legal$/i.test(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) throw new Error('GLM model discovery returned no coding-plan models')
  return ids
}
