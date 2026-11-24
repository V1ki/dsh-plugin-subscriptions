import type { AccountPreferences, ProviderPreferences } from '../provider-settings.js'
import type { ProviderId } from '../auth/store.js'
import { antigravitySelectionId } from '../antigravity-model-id.js'

export interface AccountCatalogRow {
  key: string
  label: string
  models: { id: string; name: string }[]
  unavailable?: boolean
}

/** Missing allowlist follows discovery; explicit [] must remain empty. */
export function accountPoolSelection(account: AccountPreferences, models: readonly { id: string }[], provider?: ProviderId): Set<string> {
  const selected = account.poolModels ?? models.map(model => model.id)
  return new Set(provider === 'antigravity' ? selected.map(id => antigravitySelectionId(id, models)) : selected)
}

/** Retain unavailable saved IDs so a temporary catalog failure cannot erase them. */
export function accountModelRows(account: AccountCatalogRow, preferences: AccountPreferences, provider?: ProviderId) {
  const known = new Set(account.models.map(model => model.id))
  return [
    ...account.models.map(model => ({ ...model, unavailable: false })),
    ...[...accountPoolSelection(preferences, account.models, provider)].filter(id => !known.has(id)).map(id => ({ id, name: id, unavailable: true })),
  ]
}

/** The model editor owns everything except the separately managed accounts. */
export function mergeLatestAccounts(draft: ProviderPreferences, latest: ProviderPreferences): ProviderPreferences {
  const { accounts: _stale, ...settings } = draft
  return { ...settings, ...(latest.accounts === undefined ? {} : { accounts: latest.accounts }) }
}

/** Only touched accounts replace their latest preferences; other settings survive. */
export function mergeAccountChanges(
  latest: ProviderPreferences,
  changes: Record<string, AccountPreferences>,
): ProviderPreferences {
  return { ...latest, accounts: { ...latest.accounts, ...changes } }
}
