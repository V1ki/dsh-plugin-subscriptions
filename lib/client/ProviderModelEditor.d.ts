import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
import type { ProviderPreferences } from '../provider-settings.js';
import type { SubscriptionProvider } from './SubscriptionsSection.js';
import type { SubscriptionsKey } from './locales.js';
interface Props {
    provider: SubscriptionProvider;
    rpc: ConnectionHandle['rpc'];
    t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string;
    /** Freeze the editor while the owning dialog submits. */
    disabled?: boolean;
    /** Reports whether the draft differs from the loaded catalog. */
    onDirtyChange?: (dirty: boolean) => void;
}
/** The editor's unsaved edits, collected by the owning dialog's single Save. */
export interface ModelDraft {
    /** Provider settings minus `accounts`; absent when the draft has no edits. */
    settings?: ProviderPreferences;
    /** Reasoning-effort overrides that differ from the catalog; '' clears one. */
    efforts: {
        model: string;
        effort: string;
    }[];
}
export interface ProviderModelEditorHandle {
    /**
     * Validate and collect the draft without mutating it, so a failed submit
     * keeps every edit. Returns undefined when a value is invalid; the editor
     * shows the reason itself.
     */
    collect(): ModelDraft | undefined;
}
/**
 * Embedded section of the account manager dialog. It owns the model draft
 * (visibility, effort, context, tools) but not its submission: the dialog
 * collects the draft through the handle and saves it with the account edits
 * in one go, so there is a single Save/Cancel pair.
 */
export declare const ProviderModelEditor: import("react").ForwardRefExoticComponent<Props & import("react").RefAttributes<ProviderModelEditorHandle>>;
export {};
