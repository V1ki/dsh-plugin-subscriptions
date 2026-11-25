import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from './locales.js'
import { modelSliderStops, sliderProviderTarget } from './model-slider-tiers.js'
import type { SliderGroup } from './model-slider-tiers.js'
import { modelSliderCss } from './model-slider-styles.js'
import { SliderComets, sliderCometCss } from './SliderComets.js'
import type { SpeedSelectInjected } from './speed.js'
import { useSliderSpeed } from './use-slider-speed.js'
import { useComposerDisplay } from './composer-display-preferences.js'

type SliderProvider = 'codex' | 'claude'
const providerLabels: Record<SliderProvider, string> = { codex: 'Codex', claude: 'Claude' }

type Selection = { provider: string; model: string }
interface DirectoryState {
  current: Selection | null
  routable?: boolean | null
  groups: readonly (Omit<SliderGroup, 'provider'> & { id: string })[]
  status: string
}

/** Structural contract of the host's shared per-session model directory. */
export interface SliderDirectory {
  load(): Promise<unknown>
  store: { getSnapshot(): DirectoryState; subscribe(listener: () => void): () => void }
  select(selection: Selection): Promise<{ ok: boolean }>
}

export function resolveSliderDirectory(resolver: unknown, sessionId: string): SliderDirectory | undefined {
  try {
    const dir = (resolver as { directoryFor(id: string): Partial<SliderDirectory> } | undefined)?.directoryFor(sessionId)
    if (typeof dir?.load === 'function' && typeof dir.select === 'function'
      && typeof dir.store?.subscribe === 'function' && typeof dir.store.getSnapshot === 'function') {
      return dir as SliderDirectory
    }
  } catch { /* Session can already be gone; older hosts can lack the service. */ }
}

interface SliderProps {
  directory: SliderDirectory
  speed?: SpeedSelectInjected | undefined
  loadProviders?: (() => Promise<readonly SliderProvider[]>) | undefined
  t?: ((key: keyof typeof en) => string) | undefined
}
type SlotProps = PropsRuntime<'conversation.input.right'> & Omit<SliderProps, 'directory'>
  & { directory: SliderDirectory | undefined; sliderSessionId: string } & Partial<PropsLocale<'settings.subscriptions'>>

export function ModelSlider({ directory, speed, loadProviders, t, sliderSessionId }: SlotProps) {
  return directory ? <ModelSliderView key={sliderSessionId} directory={directory} speed={speed} loadProviders={loadProviders} t={t} /> : null
}

const railInset = 12
const groupsFor = (state: DirectoryState) => state.groups.map(({ id, models }) => ({ provider: id, models }))
const stopsFor = (state: DirectoryState) => modelSliderStops(groupsFor(state), state.current)

export function ModelSliderView({ directory, speed, loadProviders, t = key => en[key] }: SliderProps) {
  const state = useSyncExternalStore(
    useCallback(callback => directory.store.subscribe(callback), [directory]),
    () => directory.store.getSnapshot(),
  )
  const stops = stopsFor(state)
  const current = state.current
  const selected = stops.findIndex(stop => stop.id === current?.model)
  const [preview, setPreview] = useState<string | null>(null)
  const [pending, setPending] = useState<Selection | null>(null)
  const [failed, setFailed] = useState(false)
  const drag = useRef<{ pointerId: number; origin: Selection; order: string[]; directory: SliderDirectory } | null>(null)
  const saving = useRef(false)
  const remembered = useRef<Partial<Record<SliderProvider, string>>>({})
  const [providers, setProviders] = useState<readonly SliderProvider[]>([])
  const [opened, setOpened] = useState(false)
  const loadingProviders = useRef(false)
  const refreshProviders = useCallback(async () => {
    if (!loadProviders || loadingProviders.current) return
    loadingProviders.current = true
    try { setProviders(await loadProviders()) } catch { /* Keep the last confirmed roster. */ }
    finally { loadingProviders.current = false }
  }, [loadProviders])
  useEffect(() => {
    if (current?.provider === 'codex' || current?.provider === 'claude') remembered.current[current.provider] = current.model
  }, [current?.provider, current?.model])
  const busy = pending !== null || state.status === 'selecting'

  const sliderShown = useComposerDisplay('slider') === 'shown'
  // The directory can retain a saved selection after its route leaves the catalog.
  // Match the native picker and wait for confirmation when the host is resolving it.
  const resolved = state.routable !== false && state.routable !== null
  const showTrack = sliderShown && resolved && selected >= 0
  const codexModel = resolved && current?.provider === 'codex'
    && state.groups.some(group => group.id === 'codex' && group.models.some(model => model.id === current.model))
    ? current.model : undefined
  useEffect(() => {
    if (!sliderShown) { drag.current = null; setPreview(null); setFailed(false); setOpened(false) }
  }, [sliderShown])
  const fast = useSliderSpeed(codexModel, speed)
  useEffect(() => { void directory.load().catch(() => {}) }, [directory])
  useEffect(() => { if (sliderShown) void refreshProviders() }, [sliderShown, refreshProviders])
  const providerOptions = providers.filter(provider => sliderProviderTarget(groupsFor(state), provider) !== undefined)
  const canSwitchProvider = showTrack && providerOptions.some(provider => provider !== current?.provider)
  const showFast = codexModel !== undefined && fast.visible
  if (!showTrack && !showFast) return null

  const fastDescription = t(current?.model === 'gpt-6.2-astra' || current?.model === 'gpt-5.6'
    ? 'speedFastMeasuredDescription' : 'speedFastDescription')
  const fastButton = showFast && (
    <button type="button" className="dsh-model-slider-fast"
      aria-label={t('modelSliderFast')} aria-pressed={fast.tier === undefined ? undefined : fast.tier === 'fast'} aria-disabled={busy || fast.busy}
      title={fast.failed ? t('modelSliderFastFailed') : `${t('speedFast')} · ${fastDescription}`}
      onClick={() => { if (!busy && !fast.busy) fast.toggle() }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    </button>
  )

  const max = stops.length - 1
  const atPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(max, Math.round(max * (event.clientX - rect.left - railInset) / Math.max(1, rect.width - 2 * railInset))))
  }
  const distance = (index: number) => `${100 * index / max}%`
  const thumb = stops.findIndex(stop => stop.id === (preview ?? (pending?.provider === current?.provider ? pending?.model : undefined)))
  const shown = thumb === -1 ? selected : thumb
  const hint = stops[shown]
  // Fast is per model: while scrubbing, do not attribute the old preference to the preview.
  const detail = failed ? t('modelSliderFailed')
    : fast.tier === 'fast' && hint && hint.id === current?.model ? fastDescription
    : hint?.premium ? t('modelSliderPremium') : undefined
  const cancel = () => { drag.current = null; setPreview(null) }

  const commit = async (origin: Selection | null, target: Selection) => {
    // The native picker may have changed the shared selection during a drag.
    const latest = directory.store.getSnapshot()
    if (saving.current || latest.status === 'selecting'
      || latest.current?.provider !== origin?.provider || latest.current?.model !== origin?.model
      || (target.provider === origin?.provider && target.model === origin.model)) return
    saving.current = true
    setFailed(false)
    setPending(target)
    try {
      // As in the native picker, switching model uses the new model's default effort.
      setFailed(!(await directory.select(target)).ok)
    } catch {
      setFailed(true)
    } finally {
      saving.current = false
      setPending(null)
    }
  }

  const commitStop = (origin: Selection, model: string) => {
    if (stopsFor(directory.store.getSnapshot()).some(stop => stop.id === model)) {
      void commit(origin, { provider: origin.provider, model })
    }
  }
  const switchProvider = (provider: SliderProvider) => {
    const latest = directory.store.getSnapshot()
    const target = sliderProviderTarget(groupsFor(latest), provider, remembered.current[provider])
    if (target && provider !== current?.provider) void commit(current, { provider, model: target.id })
  }

  return (
    <div className="dsh-model-slider" onPointerEnter={() => { if (sliderShown) void refreshProviders() }}
      onFocusCapture={() => { if (sliderShown) void refreshProviders() }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpened(false) }}
      onKeyDown={event => { if (event.key === 'Escape') setOpened(false) }}
      data-subscriptions-model-slider-active={showTrack ? "true" : undefined}
      data-open={opened} data-fast={fast.tier === 'fast'} data-preview={preview !== null} data-failed={failed}>
      <style>{modelSliderCss}{sliderCometCss}</style>
      {showTrack && <div className="dsh-model-slider-hint">
        <div className="dsh-model-slider-caption">
          {canSwitchProvider && <div className="dsh-model-slider-providers" role="group" aria-label={t('modelSliderProviders')}
            onPointerDown={event => event.stopPropagation()}
          >
            {providerOptions.map(provider => <button key={provider} type="button"
              aria-pressed={current?.provider === provider} aria-disabled={busy}
              onClick={() => { if (!busy) switchProvider(provider) }}
            >{providerLabels[provider]}</button>)}
          </div>}
          {hint && <span>{hint.name}</span>}
          {detail && <small>{detail}</small>}
        </div>
      </div>}
      {fastButton}
      {showTrack && <div className="dsh-model-slider-track"
        style={{ '--slider-inset': `${railInset}px` } as CSSProperties}
      >
        <div className="dsh-model-slider-hit" role="slider" tabIndex={0}
          aria-label={t('modelSliderLabel')} aria-valuemin={1} aria-valuemax={stops.length}
          aria-valuenow={shown + 1} aria-valuetext={stops[shown]!.name} aria-disabled={busy} aria-busy={busy}
          onPointerDown={event => {
            if (busy || !current || !event.isPrimary || event.button !== 0) return
            if (event.pointerType === 'touch' && canSwitchProvider) setOpened(true)
            const index = atPointer(event)
            event.currentTarget.focus({ preventScroll: true })
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { pointerId: event.pointerId, origin: current, order: stops.map(stop => stop.id), directory }
            setFailed(false)
            setPreview(stops[index]!.id)
          }}
          onPointerMove={event => {
            if (busy) return
            if (drag.current?.pointerId === event.pointerId) setPreview(stops[atPointer(event)]!.id)
          }}
          onPointerUp={event => {
            const active = drag.current
            if (active?.pointerId !== event.pointerId) return
            const model = stops[atPointer(event)]!.id
            cancel()
            if (active.directory === directory && active.order.join('/') === stops.map(stop => stop.id).join('/')) {
              commitStop(active.origin, model)
            }
          }}
          onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancel() }}
          onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancel() }}
          onBlur={() => { cancel(); setFailed(false) }}
          onKeyDown={event => {
            if (event.key === 'Escape' && (drag.current || failed)) {
              event.stopPropagation()
              cancel()
              setFailed(false)
              return
            }
            const next = ({ ArrowLeft: selected - 1, ArrowDown: selected - 1, ArrowRight: selected + 1, ArrowUp: selected + 1, Home: 0, End: max } as Record<string, number | undefined>)[event.key]
            if (next === undefined) return
            event.preventDefault()
            event.stopPropagation()
            if (!busy && current && drag.current === null) commitStop(current, stops[Math.max(0, Math.min(max, next))]!.id)
          }}
        >
          <div className="dsh-model-slider-rail" aria-hidden="true" data-premium={stops[shown]!.premium}>
            <div className="dsh-model-slider-progress">
              <span className="dsh-model-slider-fill" style={{ right: shown === max ? 'var(--fill-start)' : distance(max - shown) }} />
            </div>
            {(stops[shown]!.premium || fast.tier === 'fast') && <SliderComets />}
            <div className="dsh-model-slider-steps">
              {stops.map((stop, index) => (
                <span key={stop.id} className="dsh-model-slider-tick" data-filled={index < shown} style={{ left: distance(index) }} />
              ))}
              <span className="dsh-model-slider-thumb" style={{ left: distance(shown) }} />
            </div>
          </div>
        </div>
      </div>}
      <span className="dsh-model-slider-status" role="status">
        {fast.failed ? t('modelSliderFastFailed') : failed && selected >= 0 ? t('modelSliderFailed') : ''}
      </span>
    </div>
  )
}
