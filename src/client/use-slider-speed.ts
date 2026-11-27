import { useLayoutEffect, useRef, useState } from 'react'
import type { SpeedSelectInjected, SpeedTier } from './speed.js'

const POLL_MS = 3000

interface SliderSpeed {
  visible: boolean
  tier: SpeedTier | undefined
  busy: boolean
  failed: boolean
  toggle: () => void
}

const idle: SliderSpeed = { visible: false, tier: undefined, busy: false, failed: false, toggle: () => {} }

export function useSliderSpeed(model: string | undefined, speed: SpeedSelectInjected | undefined): SliderSpeed {
  const api = useRef(speed)
  const enabled = model !== undefined && speed !== undefined
  const [view, setView] = useState<{ model: string; value: SliderSpeed }>()
  const [fastModels, setFastModels] = useState<ReadonlySet<string>>()
  const [sessionTier, setSessionTier] = useState<SpeedTier>()
  const saving = useRef(false)

  // Slot renders may replace the adapters without changing the model or session.
  useLayoutEffect(() => { api.current = speed }, [speed])

  useLayoutEffect(() => {
    if (!enabled || model === undefined) {
      setView(undefined)
      return
    }
    const displayedModel = model

    let active = true
    let reading = false
    let revision = 0
    let value: SliderSpeed = { ...idle, toggle: () => { void save() } }
    setView({ model: displayedModel, value })

    function publish(tier: SpeedTier | undefined, busy: boolean, failed: boolean) {
      if (value.tier === tier && value.busy === busy && value.failed === failed) return
      value = { ...value, visible: tier !== undefined, tier, busy, failed }
      setView({ model: displayedModel, value })
    }

    async function load() {
      const adapter = api.current
      if (!active || !adapter || reading || saving.current) return
      const started = revision
      reading = true
      try {
        const result = await adapter.loadSpeed()
        if (!active || revision !== started) return
        if (result.visible && result.model !== displayedModel) return
        if (result.fastModels !== undefined) {
          const supported = new Set(result.fastModels)
          setFastModels(previous => previous?.size === supported.size
            && [...supported].every(id => previous.has(id)) ? previous : supported)
        }
        setSessionTier(result.sessionTier)
        publish(result.visible ? result.tier : undefined, false, false)
      } catch {
        if (active && revision === started) publish(value.tier, false, true)
      } finally {
        reading = false
      }
    }

    async function save() {
      const adapter = api.current
      const tier = value.tier
      if (!active || !adapter || tier === undefined || saving.current) return
      // Invalidate any in-flight read; it may contain the pre-write tier.
      revision++
      saving.current = true
      publish(tier, true, false)
      const next = tier === 'fast' ? 'standard' : 'fast'
      let saved = false
      try {
        saved = await adapter.setSpeed(next, displayedModel)
      } catch {
        saved = false
      } finally {
        saving.current = false
      }
      if (saved) setSessionTier(next)
      if (active) publish(saved ? next : tier, false, !saved)
    }

    void load()
    const interval = setInterval(() => { void load() }, POLL_MS)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [enabled, model])

  if (!enabled || model === undefined) return idle
  const current = view?.model === model ? view.value : idle
  // While refreshing, only a confirmed session override carries over.
  return current.tier === undefined && fastModels?.has(model)
    ? { ...current, visible: true, tier: sessionTier, busy: true } : current
}
