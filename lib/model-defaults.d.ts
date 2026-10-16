import { type ProviderId } from './auth/store.js';
/** One model id → its configured default reasoning effort id. */
export type ModelDefaultMap = Readonly<Record<string, string>>;
/** Provider route → model defaults. */
export type ModelDefaults = Readonly<Partial<Record<ProviderId, ModelDefaultMap>>>;
/** Absolute path of the defaults file. */
export declare function modelDefaultsFilePath(): string;
/**
 * The last load failure, or a warning about entries that were skipped while
 * loading; consumers only use it for diagnostics.
 */
export declare function modelDefaultsLoadError(): unknown;
/** A detached snapshot for the RPC surface (render + diffing). */
export declare function modelDefaultsSnapshot(): ModelDefaults;
/**
 * Set or clear one model's configured default effort, then persist. The
 * memory snapshot updates only after the atomic write succeeds, so a failed
 * write never leaves the live state ahead of the file.
 * @param provider - the subscription provider route.
 * @param model - the wire model id.
 * @param effort - the effort id, or undefined to clear the override.
 */
export declare function setDefaultEffort(provider: ProviderId, model: string, effort: string | undefined): Promise<void>;
