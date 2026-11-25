/** Session speed adapters used by /fast and the shared current-model readers. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value, mirrored from the node half. */
export interface SpeedState {
  tier: SpeedTier
  fastModels: string[]
}

/** Eligibility and current tier for the /fast command. */
export interface SpeedSelectState {
  visible: boolean
  model?: string
  tier: SpeedTier
  /** Codex capability list, independent of the currently selected model’s preference. */
  fastModels?: readonly string[]
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
    load(): Promise<{ current: { provider: string; model: string } | null }>
  }
}

/** Session-bound speed operations. */
export interface SpeedSelectInjected {
  /** Load the session's speed state and eligibility. */
  loadSpeed: () => Promise<SpeedSelectState>
  /** Set the session's speed tier; resolves false when the write failed. */
  setSpeed: (tier: SpeedTier, displayedModel?: string) => Promise<boolean>
}

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
export function createSpeedLoader(
  connection: ConnectionHandle,
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SpeedSelectInjected['loadSpeed'] {
  return async () => {
    const directories = models()
    const directory = directories?.directoryFor(sessionId)
    const current = (await directory?.load())?.current ?? null
    const state = await callSubscriptionsAuth<SpeedState>(connection.rpc, 'speed', {
      sessionId, ...(current?.provider === 'codex' ? { model: current.model } : {}),
    })
    const visible = current !== null && current.provider === 'codex'
      && state.fastModels.includes(current.model)
    // Selection may change while the speed RPC is pending.
    const latest = (await directory?.load())?.current ?? null
    if (latest?.provider !== current?.provider || latest?.model !== current?.model) {
      throw new Error('Model changed while loading speed')
    }
    return {
      visible, tier: state.tier,
      ...(visible && current ? { model: current.model } : {}),
      ...(current?.provider === 'codex' ? { fastModels: state.fastModels } : {}),
    }
  }
}

/** Write speed for a session and report whether it succeeded. */
export function createSpeedSetter(
  connection: ConnectionHandle,
  sessionId: string,
  models?: () => ModelDirectoriesLike | undefined,
): SpeedSelectInjected['setSpeed'] {
  return async (tier, displayedModel) => {
    try {
      const directories = models?.()
      const current = directories === undefined ? null : (await directories.directoryFor(sessionId).load()).current
      if (models !== undefined && current?.provider !== 'codex') return false
      if (displayedModel !== undefined && current?.model !== displayedModel) return false
      await callSubscriptionsAuth(connection.rpc, 'setSpeed', {
        sessionId, tier, ...(current?.provider === 'codex' ? { model: current.model } : {}),
      })
      return true
    } catch {
      return false // The control keeps its last confirmed value on load or save failure.
    }
  }
}
