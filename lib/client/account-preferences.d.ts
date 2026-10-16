import type { AccountPreferences, ProviderPreferences } from '../provider-settings.js';
export interface AccountCatalogRow {
    key: string;
    label: string;
    models: {
        id: string;
        name: string;
    }[];
    unavailable?: boolean;
}
/** Missing allowlist follows discovery; explicit [] must remain empty. */
export declare function accountPoolSelection(account: AccountPreferences, models: readonly {
    id: string;
}[]): Set<string>;
/** Retain unavailable saved IDs so a temporary catalog failure cannot erase them. */
export declare function accountModelRows(account: AccountCatalogRow, preferences: AccountPreferences): {
    unavailable: boolean;
    id: string;
    name: string;
}[];
/** The model editor owns everything except the separately managed accounts. */
export declare function mergeLatestAccounts(draft: ProviderPreferences, latest: ProviderPreferences): ProviderPreferences;
/** Only touched accounts replace their latest preferences; other settings survive. */
export declare function mergeAccountChanges(latest: ProviderPreferences, changes: Record<string, AccountPreferences>): ProviderPreferences;
