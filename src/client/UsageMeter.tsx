/**
 * Composer usage meter: a progress ring in the input tool row
 * (`conversation.input.right`) reporting the claude subscription limit that
 * applies to the session's current model, with a click-open panel listing
 * every limit the provider reported.
 *
 * It renders only while a claude model is selected, so it never shows a
 * reading that does not describe the turn about to be sent. The ring geometry
 * and the panel chrome follow the shell's own ContextMeter, which sits two
 * seats to the right, so the pair reads as one family.
 *
 * Every color resolves through a `--dsw-*` design token and every user-visible
 * string goes through the locale `t` of the 'settings.subscriptions'
 * namespace, same as the settings section.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'
import type { ProviderUsage, UsageWindow } from '../providers/common.js'

/** Ring geometry, matching the shell's ContextMeter: 14px box, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** ContextMeter's own hover delay. */
const TOOLTIP_DELAY_MS = 200

/**
 * Model-gate cadence. The session's current model is not on the conversation
 * snapshot and no model-change event exists, so the gate asks `sessions.models`
 * — a local host RPC with no upstream traffic, cheap enough to poll briskly.
 */
const GATE_POLL_MS = 700

/**
 * A model switch is always a user gesture, so any pointer or Enter gesture
 * additionally probes on this staircase. The poll is the safety net; the burst
 * is what makes the ring appear and disappear with the click rather than a
 * tick later.
 */
const GATE_BURST_MS: readonly number[] = [90, 260, 600, 1100]
const GATE_BURST_THROTTLE_MS = 350

/**
 * Usage revalidation. The upstream endpoint is aggressively rate limited and
 * shared with this plugin's own settings page, so the meter is deliberately
 * frugal: an idle session issues nothing at all, a running one asks on this
 * interval, and hovering the ring revalidates under the same floor.
 */
const USAGE_MIN_INTERVAL_MS = 180_000
const USAGE_RUNNING_INTERVAL_MS = 180_000

/** First rate-limit refusal stands down this long; later ones double to the cap. */
const BACKOFF_START_MS = 300_000
const BACKOFF_MAX_MS = 600_000

/** A request that never settles must not wedge the store. */
const REQUEST_TIMEOUT_MS = 15_000

/** Warning step, matching the Claude Code app; the error step follows at 95%. */
const WARN_PERCENT = 75
const DANGER_PERCENT = 95

/** What the meter renders from: the last good reading and when it landed. */
export interface UsageMeterState {
  usage: ProviderUsage | null
  at: number
}

/**
 * The shared usage cache. The slot renders once per session, so a fetcher per
 * component would multiply the request rate against the shared endpoint by the
 * number of open sessions; every instance subscribes to one store instead.
 */
export interface UsageMeterStore {
  get: () => UsageMeterState
  subscribe: (fn: (state: UsageMeterState) => void) => () => void
  /** Revalidate if — and only if — the floor and any active backoff allow it. */
  request: () => void
}

/** Whether the session's current model is a claude one, and which. */
export interface ModelGate {
  visible: boolean
  model: string | null
}

/** Injected dependencies of {@link UsageMeter} (slot `inject`, session-bound). */
export interface UsageMeterInjected {
  /** Resolve the session's current model; rejects rather than reporting "hidden". */
  checkModel: () => Promise<ModelGate>
  /** The shared usage store. */
  store: UsageMeterStore
}

/**
 * Props delivered by the slot outlet: the framework session kit and InputZone
 * owner share, the injected face, and the locale seat.
 */
export type UsageMeterProps = PropsRuntime<'conversation.input.right'>
  & Partial<UsageMeterInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, string | number>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** Recognise a rate-limit refusal from the flattened RPC failure message. */
function isRateLimited(message: string): boolean {
  return /\b429\b/.test(message) || /rate.?limit/i.test(message)
}

/**
 * The delay the provider asked for, when the node half appended one. The
 * `internal` RpcResult branch types `details` as an empty object upstream, so
 * the retry hint rides the message text (see `withRetryAfter` in auth/rpc.ts).
 */
function retryHintMs(message: string): number | undefined {
  const match = /retry-after:\s*(\d+)s/i.exec(message)
  if (match === null) return undefined
  const seconds = Number(match[1])
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/**
 * Build the shared usage store.
 *
 * Stale-while-revalidate throughout: the last successful reading is always
 * what renders, and a failure — including a rate-limit refusal — never clears
 * it. A refused request only schedules a later retry, so the meter degrades to
 * slightly stale numbers rather than an empty or shouting panel.
 *
 * @param rpc - the connection's RPC caller.
 * @returns the store; call `request()` to revalidate under the floor.
 */
export function createUsageStore(rpc: ConnectionHandle['rpc']): UsageMeterStore {
  const listeners = new Set<(state: UsageMeterState) => void>()
  let state: UsageMeterState = { usage: null, at: 0 }
  let inflight = false
  let blockedUntil = 0
  let backoffMs = 0

  const publish = (next: UsageMeterState): void => {
    state = next
    for (const fn of [...listeners]) fn(state)
  }

  const request = (): void => {
    const now = Date.now()
    if (inflight || now < blockedUntil || now - state.at < USAGE_MIN_INTERVAL_MS) return
    inflight = true
    let settled = false
    const finish = (apply?: () => void): void => {
      if (settled) return
      settled = true
      inflight = false
      clearTimeout(watchdog)
      apply?.()
    }
    const watchdog = setTimeout(() => { finish() }, REQUEST_TIMEOUT_MS)
    void callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider: 'claude' }).then(
      (usage) => {
        finish(() => {
          backoffMs = 0
          blockedUntil = 0
          publish({ usage, at: Date.now() })
        })
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        finish(() => {
          if (!isRateLimited(message)) return
          const hint = retryHintMs(message)
          backoffMs = hint ?? (backoffMs === 0
            ? BACKOFF_START_MS
            : Math.min(backoffMs * 2, BACKOFF_MAX_MS))
          blockedUntil = Date.now() + backoffMs
        })
      },
    )
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    request,
  }
}

/**
 * The `checkModel` half of the inject face: the host's current model selection.
 * A failure throws rather than answering "hidden" — the caller keeps its last
 * known state, so a transient RPC failure never blinks the meter away.
 *
 * `sessionId` is a plain string: slot and command contexts brand it through
 * different dsh-session copies, and only the API-client boundary needs one.
 */
export function createModelChecker(
  connection: ConnectionHandle,
  sessionId: string,
): UsageMeterInjected['checkModel'] {
  return async () => {
    const { result } = await connection.api.sessions.models({ sessionId: sessionId as SessionId })
    if (!result.ok) throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`)
    const current = result.value.current
    if (current === null || current.provider !== 'claude') return { visible: false, model: null }
    return { visible: true, model: current.model }
  }
}

/**
 * The window the ring represents: on a model with its own weekly limit (Fable
 * today) that limit, otherwise the shared weekly pool — the two readings a
 * user is actually spending. Falls back to the most consumed window so the
 * ring still means something on a plan shape this code has not seen.
 */
export function pickWindow(windows: readonly UsageWindow[], model: string | null): UsageWindow | null {
  if (windows.length === 0) return null
  const weekly = windows.filter(w => w.kind === 'weekly')
  if (typeof model === 'string') {
    const scoped = weekly.find(w => typeof w.scope === 'string' && w.scope.length > 0
      && model.toLowerCase().includes(w.scope.toLowerCase()))
    if (scoped !== undefined) return scoped
  }
  const overall = weekly.find(w => w.scope === undefined || w.scope === '')
  if (overall !== undefined) return overall
  return weekly[0] ?? [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0] ?? null
}

/** Clamp a reported percentage into the range the meter can draw. */
function clamp(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/** Ring and bar tint: neutral while healthy, warning from 75%, error from 95%. */
function meterColor(percent: number): string {
  if (percent >= DANGER_PERCENT) return 'var(--dsw-alias-state-error-primary)'
  if (percent >= WARN_PERCENT) return 'var(--dsw-alias-state-warn-label)'
  return 'var(--dsw-static-blue-450)'
}

/** Localized label of one window: the kind, plus the model scope when named. */
function windowLabel(t: NonNullable<UsageMeterProps['t']>, window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  const scope = window.scope !== undefined && window.scope !== '' ? window.scope : t('meterAllModels')
  return window.kind === 'weekly' ? `${base} · ${scope}` : base
}

/**
 * Localized reset phrasing: a countdown while the window is close, and a
 * weekday clock time beyond a day, where a countdown would be noise.
 */
function resetLabel(
  t: NonNullable<UsageMeterProps['t']>,
  resetsAt: number | undefined,
  now = Date.now(),
): string {
  if (resetsAt === undefined) return ''
  const diff = resetsAt - now
  const HOUR = 3_600_000
  if (diff > 0 && diff < 24 * HOUR) {
    const totalMinutes = Math.round(diff / 60_000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    const duration = hours === 0
      ? t('meterMinutes', { count: minutes })
      : minutes === 0
        ? t('meterHours', { count: hours })
        : t('meterHoursMinutes', { hours, minutes })
    return t('meterResetsIn', { duration })
  }
  const date = new Date(resetsAt)
  return t('meterResetsAt', {
    date: date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
  })
}

const styles = {
  root: { display: 'inline-flex', position: 'relative' },
  trigger: {
    width: 28, height: 28, padding: 0, border: 'none', borderRadius: 999,
    background: 'transparent', cursor: 'pointer', flex: 'none',
    display: 'grid', placeItems: 'center',
  },
  track: { fill: 'none', stroke: 'var(--dsw-alias-border-l3)', strokeWidth: 2 },
  ring: { fill: 'none', strokeWidth: 2, strokeLinecap: 'round', transition: 'stroke-dasharray .3s ease, stroke .3s ease' },
  panel: {
    position: 'absolute', right: 0, bottom: 'calc(100% + 8px)', zIndex: 100,
    boxSizing: 'border-box', width: 320, maxWidth: 'calc(100vw - 32px)', padding: 12,
    border: '1px solid var(--dsw-alias-border-inverted)', borderRadius: 12,
    background: 'var(--dsw-specific-menu)', boxShadow: 'var(--dsw-shadow-lv3)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '20px', cursor: 'default',
  },
  // Leading trim: a 12px glyph in a 20px line box carries 4px of half-leading,
  // so without this the caption's ink sits 16px below the top edge while the
  // last bar — a solid block with no leading — sits 12px above the bottom.
  caption: { margin: '-4px 0 10px', color: 'var(--dsw-alias-label-tertiary)' },
  limit: { marginTop: 12 },
  line: { display: 'flex', alignItems: 'baseline', gap: 8 },
  name: {
    minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  reset: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', flex: 'none' },
  percent: {
    color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flex: 'none',
  },
  bar: {
    height: 4, marginTop: 6, borderRadius: 999, overflow: 'hidden',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  barFill: { height: '100%', borderRadius: 999, transition: 'width .3s ease, background-color .3s ease' },
  empty: { color: 'var(--dsw-alias-label-tertiary)' },
} satisfies Record<string, CSSProperties>

/**
 * The composer meter. Renders nothing until the model gate proves a claude
 * model is selected; from then on the ring tracks {@link pickWindow} and the
 * panel lists every reported limit.
 */
export function UsageMeter({ checkModel, store, useSession, t }: UsageMeterProps) {
  const translate = t ?? fallbackTranslate
  const running = useSession?.(snapshot => snapshot.running) === true
  const [gate, setGate] = useState<ModelGate>({ visible: false, model: null })
  const [usageState, setUsageState] = useState<UsageMeterState>(() => store?.get() ?? { usage: null, at: 0 })
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  // The inject face may be re-evaluated on re-render; the effects mount once
  // and read through refs, so identity churn neither resets the timers nor
  // multiplies in-flight requests.
  const checkRef = useRef(checkModel)
  checkRef.current = checkModel
  const storeRef = useRef(store)
  storeRef.current = store

  useEffect(() => {
    const current = storeRef.current
    if (current === undefined) return
    setUsageState(current.get())
    return current.subscribe(setUsageState)
  }, [])

  useEffect(() => {
    if (checkRef.current === undefined) return
    let cancelled = false
    let inflight = false
    let lastBurst = 0
    const burstTimers: ReturnType<typeof setTimeout>[] = []

    const check = (): void => {
      const resolve = checkRef.current
      if (cancelled || inflight || resolve === undefined) return
      inflight = true
      void resolve().then(
        (next) => {
          if (cancelled) return
          setGate(prev => (prev.visible === next.visible && prev.model === next.model ? prev : next))
        },
        () => { /* keep the last known gate; the next tick retries */ },
      ).finally(() => { inflight = false })
    }

    const clearBurst = (): void => {
      while (burstTimers.length > 0) clearTimeout(burstTimers.pop())
    }

    const burst = (event: Event): void => {
      // Enter commits the /model popup; other keys are ordinary typing.
      if (event.type === 'keyup' && (event as KeyboardEvent).key !== 'Enter') return
      const now = Date.now()
      if (now - lastBurst < GATE_BURST_THROTTLE_MS) return
      lastBurst = now
      clearBurst()
      for (const delay of GATE_BURST_MS) burstTimers.push(setTimeout(check, delay))
    }

    check()
    const poll = setInterval(check, GATE_POLL_MS)
    document.addEventListener('pointerdown', burst, true)
    document.addEventListener('keyup', burst, true)
    return () => {
      cancelled = true
      clearBurst()
      clearInterval(poll)
      document.removeEventListener('pointerdown', burst, true)
      document.removeEventListener('keyup', burst, true)
    }
  }, [])

  // Revalidate only while a turn is running; an idle session issues nothing,
  // which is what keeps the shared endpoint available to the settings page.
  useEffect(() => {
    if (!gate.visible || !running) return
    const timer = setInterval(() => { storeRef.current?.request() }, USAGE_RUNNING_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [running, gate.visible])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!gate.visible && open) setOpen(false)
  }, [gate.visible, open])

  const windows = usageState.usage?.windows ?? []
  const selected = pickWindow(windows, gate.model)
  const percent = selected === null ? 0 : clamp(selected.usedPercent)
  const color = meterColor(percent)
  const label = selected === null
    ? translate('usageTitle')
    : `${windowLabel(translate, selected)} ${String(Math.round(percent))}%`

  /**
   * Hovering is the revalidation trigger: pointing at the ring is the earliest
   * honest signal of intent, so the panel opens onto an already-fresh reading
   * instead of refetching underneath the user. The Tooltip resolves its label
   * only while the bubble is visible, which makes it the natural hook.
   */
  const resolveLabel = useCallback(() => {
    storeRef.current?.request()
    return label
  }, [label])

  if (!gate.visible) return null

  const plan = usageState.usage?.plan
  const caption = plan === undefined || plan === ''
    ? translate('meterCaption')
    : translate('meterCaptionPlan', { plan })

  return (
    <span style={styles.root} ref={rootRef}>
      <Tooltip label={resolveLabel} side="top" delayMs={TOOLTIP_DELAY_MS} disabled={open}>
        <button
          type="button"
          style={{ ...styles.trigger, color }}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle style={styles.track} cx="7" cy="7" r={RADIUS} />
            <circle
              style={styles.ring}
              cx="7"
              cy="7"
              r={RADIUS}
              stroke={color}
              strokeDasharray={`${String(CIRCUMFERENCE * percent / 100)} ${String(CIRCUMFERENCE)}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div style={styles.panel} role="dialog" aria-label={translate('usageTitle')}>
          <p style={styles.caption}>{caption}</p>
          {windows.length === 0
            ? <div style={styles.empty}>{translate('meterEmpty')}</div>
            : windows.map((window, index) => {
              const used = clamp(window.usedPercent)
              const reset = resetLabel(translate, window.resetsAt)
              return (
                <div style={index === 0 ? undefined : styles.limit} key={`${window.kind}:${window.scope ?? ''}`}>
                  <div style={styles.line}>
                    <span style={styles.name}>{windowLabel(translate, window)}</span>
                    {reset !== '' && <span style={styles.reset}>{reset}</span>}
                    <span style={reset === '' ? { ...styles.percent, marginLeft: 'auto' } : styles.percent}>
                      {`${String(Math.round(used))}%`}
                    </span>
                  </div>
                  <div style={styles.bar}>
                    <div style={{ ...styles.barFill, width: `${String(used)}%`, background: meterColor(used) }} />
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </span>
  )
}
