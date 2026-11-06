import type { AccountCatalogRow } from './account-preferences.js'
import type { SubagentSpeedTier } from '../provider-settings.js'

/** What the model editor shows for the current filter state. */
export type ModelListState = 'provider-empty' | 'filter-empty' | 'rows'

/**
 * Which empty state the model list is in.
 *
 * `provider-empty` means the provider shows NO rows at all — the filter box cannot match
 * anything in that state, and printing `No model matches “”.` next to it reads like a broken
 * control rather than like an explanation (issue #147).
 *
 * `filter-empty` keeps the existing message for a query that filtered everything out of a
 * provider that does have rows.
 */
export function modelListState(total: number, matched: number): ModelListState {
  if (total === 0) return 'provider-empty'
  return matched === 0 ? 'filter-empty' : 'rows'
}

/**
 * Row ids the editor can still show when discovery returned nothing: saved visibility,
 * display names and subagent speeds must count towards the total —
 * otherwise a temporary catalog failure would hide the rows that edit them.
 */
export function savedModelIds(
  visibleModels: readonly string[] | undefined,
  displayNames: Readonly<Record<string, string>> | undefined,
  subagentSpeeds: Readonly<Record<string, SubagentSpeedTier>> | undefined = undefined,
): string[] {
  return [...new Set([...(visibleModels ?? []), ...Object.keys(displayNames ?? {}), ...Object.keys(subagentSpeeds ?? {})])]
}

/** Which notice the editor shows instead of the (inert) model controls. */
export type ModelEditorNotice = 'noAccount' | 'discoveryFailed' | 'noModels'

/**
 * Why the provider has no models — read from the data the host already sends.
 *
 * `total === 0` alone cannot tell these apart, and guessing wrong re-creates the very
 * defect issue #147 is about: telling a user who IS logged in to go and log in. The
 * catalog payload carries one row per connected account with `unavailable: true` when that
 * account's discovery failed or timed out (src/index.ts).
 *
 *  · no account at all                       → `noAccount`;
 *  · accounts exist, every discovery failed  → `discoveryFailed` (retry, not log in);
 *  · a connected account answered (possibly with an empty catalog) → `noModels`.
 */
export function modelEditorNotice(accounts: readonly AccountCatalogRow[]): ModelEditorNotice {
  if (accounts.length === 0) return 'noAccount'
  return accounts.every((account) => account.unavailable === true) ? 'discoveryFailed' : 'noModels'
}

/** Everything the component needs to decide between rows and one honest notice. */
export interface ModelEditorState {
  listState: ModelListState
  /** Locale key for the empty state; only rendered when `listState` is provider-empty. */
  noticeKey: (typeof NOTICE_KEYS)[ModelEditorNotice]
}

/** Locale keys for the three honest empty states. */
export const NOTICE_KEYS = {
  noAccount: 'modelDefaultsNoAccount',
  discoveryFailed: 'modelDefaultsDiscoveryFailed',
  noModels: 'modelDefaultsNoModels',
} as const

/**
 * The editor's whole empty-state decision, in one testable place: how many rows exist
 * (discovered + the user's saved ids), whether a query filtered them all out, and which
 * notice to show when there are none.
 */
export function modelEditorState(input: {
  discovered: number
  saved: number
  matched: number
  accounts: readonly AccountCatalogRow[]
}): ModelEditorState {
  return {
    listState: modelListState(input.discovered + input.saved, input.matched),
    noticeKey: NOTICE_KEYS[modelEditorNotice(input.accounts)],
  }
}
