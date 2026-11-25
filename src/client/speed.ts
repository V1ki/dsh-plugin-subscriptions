import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'

export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value, mirrored from the node half. */
export interface SpeedState {
  tier: SpeedTier
  sessionTier?: SpeedTier
  fastModels: string[]
}

export interface SpeedSelectState {
  visible: boolean
  model?: string
  tier: SpeedTier
  sessionTier?: SpeedTier
  fastModels?: readonly string[]
}

// Structural type: the host exposes the directory through Cordis.
export interface ModelDirectoriesLike {
  directoryFor(sessionId: string): {
    load(): Promise<{ current: { provider: string; model: string } | null }>
  }
}

export interface SpeedSelectInjected {
  loadSpeed: () => Promise<SpeedSelectState>
  setSpeed: (tier: SpeedTier, displayedModel?: string) => Promise<boolean>
}

// Resolve the model service lazily; it can register after this plugin.
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
      ...(state.sessionTier !== undefined ? { sessionTier: state.sessionTier } : {}),
    }
  }
}

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
      return false
    }
  }
}
