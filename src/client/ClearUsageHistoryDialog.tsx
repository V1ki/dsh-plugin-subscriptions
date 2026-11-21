import { useEffect, useId, useRef } from 'react'
import type { StoredSummary } from '../usage/service.js'
import type { ClearConfirmState } from './usage-dialog-state.js'
import { formatInstant, type Translate } from './usage-format.js'
import { dialogLayout, providerSettingsCss } from './provider-settings-styles.js'

interface Props {
  /** The provider's display name; the clear covers every account of it. */
  name: string
  stored: StoredSummary
  state: ClearConfirmState
  t: Translate
  onCancel: () => void
  onConfirm: () => void
}

const { border, stack, actions } = dialogLayout

/**
 * The clear confirmation names the provider and lists what
 * is removed (accounts and date range, the earlier-history total without
 * dates, or "nothing stored") and what is not touched, and states that it
 * cannot be undone. Focus starts on Cancel; Esc is Cancel, except while the
 * clear runs. A native modal dialog, like `ProviderAccountManager`.
 */
export function ClearUsageHistoryDialog({ name, stored, state, t, onCancel, onConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const description = useId()
  const clearing = state.phase === 'clearing'
  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement
    element.showModal()
    return () => {
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const nothing = stored.accounts === 0 && !stored.earlierHistory
  return <dialog className="dsh-subscription-manager" ref={dialog} aria-labelledby={title} aria-describedby={description}
    onCancel={event => { event.preventDefault(); if (!clearing) onCancel() }}
    style={{ width: 480, maxWidth: 'calc(100vw - 32px)' }}>
    <style>{providerSettingsCss}</style>
    <div style={{ ...stack, padding: 20 }}>
      <h2 id={title} style={{ margin: 0 }}>{t('usageClearTitle', { provider: name })}</h2>
      <section id={description} style={{ ...stack, gap: 6 }}>
        <strong>{t('usageClearRemoved')}</strong>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {nothing && <li>{t('usageClearNothingStored')}</li>}
          {stored.accounts > 0 && stored.from !== undefined && stored.to !== undefined && <li>{t('usageClearRemovedWindows', {
            count: stored.accounts, from: formatInstant(stored.from), to: formatInstant(stored.to),
          })}</li>}
          {stored.earlierHistory && <li>{t('usageClearRemovedEarlier')}</li>}
        </ul>
        <strong>{t('usageClearKept')}</strong>
        <p className="dsh-subscription-hint" style={{ margin: 0 }}>{t('usageClearKeptList')}</p>
        <p style={{ margin: 0 }}>{t('usageClearIrreversible')}</p>
      </section>
      {state.phase === 'failed' && <p role="alert">{t('usageClearFailed', { message: state.error ?? '' })}</p>}
      <footer style={{ ...actions, justifyContent: 'flex-end', borderTop: border, paddingTop: 12 }}>
        <button type="button" autoFocus disabled={clearing} onClick={onCancel}>{t('cancel')}</button>
        <button type="button" className="dsh-subscription-primary" disabled={clearing} onClick={onConfirm}>
          {clearing ? t('usageClearing') : t('usageClearConfirm')}
        </button>
      </footer>
    </div>
  </dialog>
}
