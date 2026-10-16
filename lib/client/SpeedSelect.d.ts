import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast';
/** `speed` endpoint value, mirrored from the node half. */
export interface SpeedState {
    tier: SpeedTier;
    fastModels: string[];
}
/** What {@link SpeedSelect} renders from: visibility plus the current tier. */
export interface SpeedSelectState {
    visible: boolean;
    tier: SpeedTier;
}
/**
 * Minimal structural face of ui-model-selection's `ctx.modelDirectories`
 * service (the sanctioned cross-plugin channel: cordis services, not value
 * imports — same mirroring discipline as ToolCallOwnerProps). Both dsh lines
 * ship it with this shape; it replaces rc.2's `connection.api.sessions.models`
 * read, which the 0.1.2-alpha removed along with the whole `.api` face.
 */
export interface ModelDirectoriesLike {
    /** Resolve one session's shared model directory (throws for unknown sessions). */
    directoryFor(sessionId: string): {
        /** Load the directory; `current` is the session's effective model selection. */
        load(): Promise<{
            current: {
                provider: string;
                model: string;
            } | null;
        }>;
    };
}
/** Injected dependencies of {@link SpeedSelect} (slot `inject`, session-bound). */
export interface SpeedSelectInjected {
    /** Load the session's speed state; `visible` false keeps the control hidden. */
    loadSpeed: () => Promise<SpeedSelectState>;
    /** Set the session's speed tier; resolves false when the write failed. */
    setSpeed: (tier: SpeedTier) => Promise<boolean>;
}
/**
 * Props delivered by the slot outlet: the framework session kit and InputZone
 * owner share (unused — everything arrives session-bound through the inject
 * face), the injected callbacks, and the locale seat.
 */
export type SpeedSelectProps = PropsRuntime<'conversation.input.right'> & Partial<SpeedSelectInjected> & Partial<PropsLocale<'settings.subscriptions'>>;
/**
 * The `loadSpeed` half of the inject face: the plugin's own speed state plus
 * the host's current model selection (the visibility gate). A model-RPC
 * failure throws rather than answering "hidden" — the caller keeps its last
 * known state, so a transient failure never locks the toggle away.
 *
 * `sessionId` is a plain string: slot and command contexts brand it through
 * different dsh-session copies, and only the service boundary needs one.
 *
 * `models` resolves lazily per call: the ui-model-selection service may
 * register after this plugin applies, and a shell without it (no model seat
 * at all) simply keeps the toggle hidden.
 */
export declare function createSpeedLoader(connection: ConnectionHandle, models: () => ModelDirectoriesLike | undefined, sessionId: string): SpeedSelectInjected['loadSpeed'];
/** The `setSpeed` half of the inject face: boolean outcome for the component's busy state. */
export declare function createSpeedSetter(connection: ConnectionHandle, sessionId: string): SpeedSelectInjected['setSpeed'];
/**
 * The composer Speed control: a trigger reading `速度 · 快速`/`速度 · 标准`
 * that opens a two-row menu (standard/fast with descriptions, check mark on
 * the current tier). The host pushes nothing on a model switch, so the
 * control re-reads on a slow poll with a single-flight guard; a failed read
 * keeps the last known state, so a transient RPC failure can never lock the
 * toggle away (the earlier mount-only load had no recovery path).
 */
export declare function SpeedSelect({ loadSpeed, setSpeed, t }: SpeedSelectProps): import("react").JSX.Element | null;
