/** Per-session automatic approval reviewer selector for the composer. */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** Automatic reviewer used for one session. None preserves native approvals. */
export type AutoReviewMode = 'none' | 'codex'

/** `autoReview` endpoint value, mirrored from the node half. */
export interface AutoReviewState {
  reviewer: AutoReviewMode
}

/** Exact RPC capability used by this control, without the rest of ConnectionHandle. */
export type AutoReviewRpc = ConnectionHandle['rpc']

/** Session-bound callbacks injected into {@link AutoReviewSelect}. */
export interface AutoReviewSelectInjected {
  loadAutoReview: () => Promise<AutoReviewState>
  setAutoReview: (reviewer: AutoReviewMode) => Promise<boolean>
}

/** Composer slot props plus the injected callbacks and locale seat. */
export type AutoReviewSelectProps = PropsRuntime<'conversation.input.right'>
  & Partial<AutoReviewSelectInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>

/** Bind the current session to the auto-review read endpoint. */
export function createAutoReviewLoader(
  rpc: AutoReviewRpc,
  sessionId: string,
): AutoReviewSelectInjected['loadAutoReview'] {
  return () => callSubscriptionsAuth<AutoReviewState>(rpc, 'autoReview', { sessionId })
}

/** Bind the current session to the auto-review write endpoint. */
export function createAutoReviewSetter(
  rpc: AutoReviewRpc,
  sessionId: string,
): AutoReviewSelectInjected['setAutoReview'] {
  return reviewer => callSubscriptionsAuth(rpc, 'setAutoReview', { sessionId, reviewer })
    .then(() => true, () => false)
}

function fallbackTranslate(key: SubscriptionsKey): string {
  return en[key]
}

const REVIEWERS: readonly AutoReviewMode[] = ['none', 'codex']

/** A compact None/Codex menu beside the existing Speed selector. */
export function AutoReviewSelect({ loadAutoReview, setAutoReview, t }: AutoReviewSelectProps) {
  const translate = t ?? fallbackTranslate
  const [state, setState] = useState<AutoReviewState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const loadRef = useRef(loadAutoReview)
  loadRef.current = loadAutoReview

  useEffect(() => {
    const load = loadRef.current
    if (load === undefined) return
    let cancelled = false
    void load().then(
      loaded => { if (!cancelled) setState(loaded) },
      () => { /* An unavailable endpoint leaves the optional control hidden. */ },
    )
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (loadAutoReview === undefined || setAutoReview === undefined || state === null) return null

  const reviewerName = (reviewer: AutoReviewMode): string =>
    translate(reviewer === 'codex' ? 'autoReviewCodex' : 'autoReviewNone')
  const reviewerDescription = (reviewer: AutoReviewMode): string =>
    translate(reviewer === 'codex' ? 'autoReviewCodexDescription' : 'autoReviewNoneDescription')
  const triggerLabel = `${translate('autoReview')} · ${reviewerName(state.reviewer)}`

  const choose = (reviewer: AutoReviewMode): void => {
    if (busy) return
    if (reviewer === state.reviewer) {
      setOpen(false)
      return
    }
    setBusy(true)
    void setAutoReview(reviewer).then((ok) => {
      setBusy(false)
      if (ok) {
        setState({ reviewer })
        setOpen(false)
      }
    })
  }

  const show = (): void => {
    setOpen(true)
    const load = loadRef.current
    if (load === undefined) return
    void load().then(setState, () => { /* Keep the last good state. */ })
  }

  return (
    <div
      ref={rootRef}
      style={styles.root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          setOpen(false)
        }
      }}
    >
      {open && (
        <div style={styles.menu} role="menu" aria-label={translate('autoReview')}>
          {REVIEWERS.map(reviewer => (
            <button
              key={reviewer}
              type="button"
              role="menuitemradio"
              aria-checked={reviewer === state.reviewer}
              style={styles.item}
              disabled={busy}
              onClick={() => { choose(reviewer) }}
            >
              <span style={styles.itemCheck}>{reviewer === state.reviewer ? '✓' : ''}</span>
              <span style={styles.itemText}>
                <span style={styles.itemName}>{reviewerName(reviewer)}</span>
                <span style={styles.itemDescription}>{reviewerDescription(reviewer)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        style={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
        disabled={busy}
        onClick={() => {
          if (open) setOpen(false)
          else show()
        }}
      >
        {triggerLabel}
      </button>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  root: { position: 'relative', display: 'inline-flex' },
  trigger: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit', fontSize: 12, lineHeight: '18px',
    padding: '2px 8px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  menu: {
    position: 'absolute', bottom: '100%', right: 0, marginBottom: 4,
    minWidth: 220, padding: 4, zIndex: 20,
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2,
  },
  item: {
    display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%',
    border: 'none', borderRadius: 6, background: 'transparent',
    padding: '6px 8px', cursor: 'pointer', font: 'inherit', textAlign: 'left',
  },
  itemCheck: {
    width: 14, flexShrink: 0, fontSize: 12, lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)',
  },
  itemText: { display: 'flex', flexDirection: 'column' },
  itemName: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)' },
  itemDescription: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
}
