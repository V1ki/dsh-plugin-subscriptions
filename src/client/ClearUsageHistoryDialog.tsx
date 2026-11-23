import { useEffect, useId, useRef } from 'react'
import type { TrackedProvider } from '../usage/usage-schema.js'
import type { DashboardClearInfo } from '../usage/usage-dashboard.js'
import type { ClearConfirmState, ProviderFilter } from './usage-dashboard-state.js'
import { formatInstant, providerDisplayName, TRACKED_PROVIDERS, type Translate } from './usage-format.js'
import { dialogLayout, providerSettingsCss } from './provider-settings-styles.js'

interface Props {
  target: ProviderFilter
  clearInfo: Readonly<Record<TrackedProvider, DashboardClearInfo>>
  state: ClearConfirmState
  t: Translate
  onTargetChange: (target: ProviderFilter) => void
  onCancel: () => void
  onConfirm: () => void
}

const { border, stack, actions } = dialogLayout

function summarizeTarget(
  target: ProviderFilter,
  clearInfo: Readonly<Record<TrackedProvider, DashboardClearInfo>>,
): { accounts: number; from?: number; to?: number; earlierHistory: boolean } {
  const list = target === 'all'
    ? TRACKED_PROVIDERS.map(p => clearInfo[p.id]).filter((info): info is DashboardClearInfo => info !== undefined)
    : clearInfo[target] ? [clearInfo[target]] : []

  let accounts = 0
  let from: number | undefined
  let to: number | undefined
  let earlierHistory = false
  for (const info of list) {
    accounts += info.accounts
    if (info.from !== undefined && (from === undefined || info.from < from)) from = info.from
    if (info.to !== undefined && (to === undefined || info.to > to)) to = info.to
    if (info.earlierHistory) earlierHistory = true
  }
  return {
    accounts,
    ...from === undefined ? {} : { from },
    ...to === undefined ? {} : { to },
    earlierHistory,
  }
}

/**
 * Confirmation modal for clearing stored usage history for one provider or all providers.
 * Opened directly from the Usage Dashboard page (never nested inside another dialog).
 */
export function ClearUsageHistoryDialog({ target, clearInfo, state, t, onTargetChange, onCancel, onConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const title = useId()
  const description = useId()
  const clearing = state.phase === 'clearing'

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const previous = document.activeElement
    element.showModal()
    // Ensure initial focus lands on Cancel even though the scope <select> precedes it in DOM order.
    cancelButton.current?.focus()
    return () => {
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const targetName = target === 'all' ? t('usageClearAllProviders') : providerDisplayName(target)
  const stored = summarizeTarget(target, clearInfo)
  const nothing = stored.accounts === 0 && !stored.earlierHistory

  return (
    <dialog
      className="dsh-subscription-manager"
      ref={dialog}
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={event => {
        event.preventDefault()
        if (!clearing) onCancel()
      }}
      style={{ width: 480, maxWidth: 'calc(100vw - 32px)' }}
    >
      <style>{providerSettingsCss}</style>
      <div style={{ ...stack, padding: 20 }}>
        <h2 id={title} style={{ margin: 0 }}>{t('usageClearTitle', { provider: targetName })}</h2>

        <label style={{ ...stack, gap: 4 }}>
          <span className="dsh-subscription-label">{t('usageClearScopeLabel')}</span>
          <select
            value={target}
            disabled={clearing}
            onChange={event => onTargetChange(event.target.value as ProviderFilter)}
          >
            <option value="all">{t('usageClearAllProviders')}</option>
            {TRACKED_PROVIDERS.map(entry => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
        </label>

        <section id={description} style={{ ...stack, gap: 6 }}>
          <strong>{t('usageClearRemoved')}</strong>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {nothing && <li>{t('usageClearNothingStored')}</li>}
            {stored.accounts > 0 && stored.from !== undefined && stored.to !== undefined && (
              <li>
                {t('usageClearRemovedWindows', {
                  count: stored.accounts,
                  from: formatInstant(stored.from),
                  to: formatInstant(stored.to),
                })}
              </li>
            )}
            {stored.earlierHistory && <li>{t('usageClearRemovedEarlier')}</li>}
          </ul>
          <strong>{t('usageClearKept')}</strong>
          <p className="dsh-subscription-hint" style={{ margin: 0 }}>{t('usageClearKeptList')}</p>
          <p style={{ margin: 0 }}>{t('usageClearIrreversible')}</p>
        </section>

        {state.phase === 'failed' && <p role="alert">{t('usageClearFailed', { message: state.error ?? '' })}</p>}

        <footer style={{ ...actions, justifyContent: 'flex-end', borderTop: border, paddingTop: 12 }}>
          <button ref={cancelButton} type="button" autoFocus disabled={clearing} onClick={onCancel}>{t('cancel')}</button>
          <button type="button" className="dsh-subscription-primary" disabled={clearing} onClick={onConfirm}>
            {clearing ? t('usageClearing') : t('usageClearConfirm')}
          </button>
        </footer>
      </div>
    </dialog>
  )
}
