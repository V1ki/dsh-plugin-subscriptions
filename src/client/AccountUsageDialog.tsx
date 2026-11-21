import { useEffect, useId, useReducer, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelSums } from '../usage/usage-schema.js'
import type { ClearResult } from '../usage/service.js'
import type { AccountUsageResponse } from '../usage/usage-rpc.js'
import type { UsageView } from '../usage/window-view.js'
import { ClearUsageHistoryDialog } from './ClearUsageHistoryDialog.js'
import { dialogLayout, providerSettingsCss } from './provider-settings-styles.js'
import { useQuotaClock } from './quota-display.js'
import type { UsageProvider } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import {
  CLEAR_CONFIRM_OPEN, clearConfirmReducer, initialUsageDialogState, usageDialogReducer,
  type ClearConfirmState, type UsageDialogAction, type UsageDialogState,
} from './usage-dialog-state.js'
import {
  MARKER_KEYS, formatInstant, formatTokens, kindLabel, kindValue, parseKindValue, windowRangeText,
  type Translate,
} from './usage-format.js'

const { border, stack, actions } = dialogLayout
const hint = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
const block = { ...stack, gap: 8, border, borderRadius: 'var(--dsw-radius-lg, 12px)', padding: 12 }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function totalTokens(counts: ModelSums[string]): number {
  // The caches are separate input buckets. Reasoning is part of output,
  // so it is not counted again in the total.
  return counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens
}

function TokenModels({ models, t }: { models: ModelSums, t: Translate }) {
  const rows = Object.entries(models).sort(([a], [b]) => a.localeCompare(b))
  return <>
    <strong>{t('usageTotalTokens', { count: formatTokens(rows.reduce((sum, [, counts]) => sum + totalTokens(counts), 0)) })}</strong>
    {rows.length > 0 && <ul style={{ ...stack, gap: 6, margin: 0, paddingLeft: 0, listStyle: 'none' }}>
      {rows.map(([name, counts]) => <li key={name} style={{ ...stack, gap: 2 }}>
        <div style={{ ...actions, justifyContent: 'space-between' }}>
          <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{name}</span>
          <strong>{t('usageTokens', { count: formatTokens(totalTokens(counts)) })}</strong>
        </div>
        <small style={hint}>{t('usageTokenBuckets', {
          input: formatTokens(counts.inputTokens), output: formatTokens(counts.outputTokens),
          read: formatTokens(counts.cacheReadTokens), write: formatTokens(counts.cacheWriteTokens),
        })}</small>
        {counts.reasoningTokens > 0 && <small style={hint}>
          {t('usageReasoningTokens', { count: formatTokens(counts.reasoningTokens) })}
        </small>}
      </li>)}
    </ul>}
  </>
}

/** Daily buckets are within this window only. Do not add overlapping quota windows together. */
function DailyTokens({ days, t }: { days: Record<string, ModelSums>, t: Translate }) {
  const dates = Object.keys(days).sort().reverse()
  if (dates.length === 0) return null
  return <details>
    <summary>{t('usageDailyUtc')}</summary>
    <div style={stack}>
      {dates.map(date => <section key={date} style={block}>
        <strong><time dateTime={date}>{date}</time></strong>
        <TokenModels models={days[date]} t={t} />
      </section>)}
    </div>
  </details>
}

/** The before-tracking block is independent of the selected window; nothing after a clear. */
function ProviderTotal({ total, t }: { total: UsageView['providerTotal'], t: Translate }) {
  if (total.state === 'cleared') return null
  return <section style={block} aria-label={t('usageTotalTitle')}>
    <strong>{t('usageTotalTitle')}</strong>
    {total.state === 'stored' && <TokenModels models={total.models} t={t} />}
    {total.state === 'not-computed' && <p style={hint}>{t('usageTotalNotComputed')}</p>}
    {total.state === 'unavailable' && <p style={hint}>{t('usageTotalUnavailable')}</p>}
  </section>
}

/** The empty-state sentence; undefined when the account has windows. */
function emptyText(response: AccountUsageResponse, name: string, t: Translate): string | undefined {
  const { view } = response
  switch (view.empty) {
    case undefined: return undefined
    // The view sets clearedAt with this state; without one there is no date to name.
    case 'cleared': return view.clearedAt === undefined ? t('usageEmptyAccount') : t('usageEmptyCleared', { provider: name, date: formatInstant(view.clearedAt) })
    case 'not-observed': return t('usageEmptyNotObserved')
    case 'no-usage': return response.accounts.length === 0 ? t('usageEmptyNoAccounts') : t('usageEmptyAccount')
  }
}

export interface UsageDialogBodyProps {
  name: string
  state: UsageDialogState
  t: Translate
  titleId: string
  /** Errors a clear reported after its cut-off was written. */
  clearErrors: readonly string[]
  onAction: (action: UsageDialogAction) => void
  onClear: () => void
  onClose: () => void
}

/** The presentational dialog body renders without a browser. */
export function UsageDialogBody({ name, state, t, titleId, clearErrors, onAction, onClear, onClose }: UsageDialogBodyProps) {
  const response = state.response
  const view = response?.view
  const window = view?.window
  const empty = response === undefined ? undefined : emptyText(response, name, t)
  const busy = state.phase === 'loading'
  return <div style={{ ...stack, padding: 20 }}>
    <header style={{ ...actions, justifyContent: 'space-between' }}>
      <h2 id={titleId} style={{ margin: 0 }}>{t('usageDialogTitle', { provider: name })}</h2>
      <button type="button" autoFocus onClick={onClose}>{t('imageClose')}</button>
    </header>
    {state.phase === 'error' && <div style={{ ...actions }} role="alert">
      <span>{t('usageViewFailed', { message: state.error ?? '' })}</span>
      <button type="button" onClick={() => onAction({ type: 'retry' })}>{t('usageRetry')}</button>
    </div>}
    {busy && <p role="status" style={hint}>{t('usageViewLoading')}</p>}
    {response !== undefined && view !== undefined && <>
      {response.accounts.length > 0 && <label style={{ ...stack, gap: 4 }}>
        <span className="dsh-subscription-label">{t('usageAccount')}</span>
        <select value={response.account ?? ''} disabled={busy}
          onChange={event => onAction({ type: 'account', account: event.target.value })}>
          {response.accounts.map(candidate => <option key={candidate.key} value={candidate.key}>
            {candidate.loggedIn
              ? candidate.label ?? candidate.key
              : t('usageAccountLoggedOut', { account: candidate.label ?? candidate.key })}
          </option>)}
        </select>
      </label>}
      {view.kinds.length > 0 && view.selected !== undefined && <label style={{ ...stack, gap: 4 }}>
        <span className="dsh-subscription-label">{t('usageKind')}</span>
        <select value={kindValue(view.selected)} disabled={busy}
          onChange={event => onAction({ type: 'kind', option: parseKindValue(event.target.value) })}>
          {view.kinds.map(option => <option key={kindValue(option)} value={kindValue(option)}>{kindLabel(t, option)}</option>)}
        </select>
      </label>}
      {empty === undefined && <nav style={{ ...actions, justifyContent: 'space-between' }} aria-label={t('usageNavigation')}>
        <button type="button" disabled={busy || view.previousAt === undefined} onClick={() => onAction({ type: 'previous' })}>
          {t('usagePrevious')}
        </button>
        <span style={{ textAlign: 'center' }}>
          {window === undefined ? t('usageNoWindow') : windowRangeText(t, window)}
          {window?.current === true && ` · ${t('usageCurrentWindow')}`}
        </span>
        <button type="button" disabled={busy || view.nextAt === undefined} onClick={() => onAction({ type: 'next' })}>
          {t('usageNext')}
        </button>
      </nav>}
      {window !== undefined && <section style={block}>
        {window.markers.length > 0 && <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
          {window.markers.map(marker => <li key={marker}>{t(MARKER_KEYS[marker])}</li>)}
        </ul>}
        <TokenModels models={window.models} t={t} />
        <DailyTokens days={window.days} t={t} />
      </section>}
      {empty !== undefined && <p style={{ margin: 0 }}>{empty}</p>}
      <ProviderTotal total={view.providerTotal} t={t} />
      {response.errors.length > 0 && <p style={hint}>{t('usageDataErrors', { list: response.errors.join('; ') })}</p>}
      {clearErrors.length > 0 && <p role="alert">{t('usageClearPartial', { list: clearErrors.join('; ') })}</p>}
      <footer style={{ ...actions, borderTop: border, paddingTop: 12 }}>
        {/* aria-disabled, not disabled: focus returns here when the confirmation closes, while the view reloads. */}
        <button type="button" aria-haspopup="dialog" aria-disabled={busy}
          onClick={() => { if (!busy) onClear() }}>{t('usageClear', { provider: name })}</button>
      </footer>
    </>}
  </div>
}

interface Props {
  provider: UsageProvider
  name: string
  /** The clicked account, or the default account or empty state when omitted. */
  account?: string
  rpc: ConnectionHandle['rpc']
  t: Translate
  onClose: () => void
}

/**
 * One window at a time for one account. A native modal like
 * `ProviderAccountManager`, so Esc
 * closes it and focus returns to the button that opened it.
 */
export function AccountUsageDialog({ provider, name, account, rpc, t, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [state, dispatch] = useReducer(usageDialogReducer, account, initialUsageDialogState)
  const [confirm, setConfirm] = useState<ClearConfirmState>()
  const [clearErrors, setClearErrors] = useState<string[]>([])
  const now = useQuotaClock()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const element = dialog.current!
    const previous = document.activeElement
    element.showModal()
    return () => {
      alive.current = false
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    let current = true
    void callSubscriptionsAuth<AccountUsageResponse>(rpc, 'accountUsage', { provider, ...state.request })
      .then(response => { if (current) dispatch({ type: 'loaded', response }) })
      .catch(error => { if (current) dispatch({ type: 'failed', message: messageOf(error) }) })
    return () => { current = false }
  }, [rpc, provider, state.load])
  // Re-read expired current windows at a bounded cadence. The reducer keeps
  // the gate across loading and response changes.
  useEffect(() => {
    dispatch({ type: 'clock', now })
  }, [now, state.phase, state.response])
  async function clear() {
    if (confirm?.phase === 'clearing') return
    setConfirm(clearConfirmReducer(confirm ?? CLEAR_CONFIRM_OPEN, { type: 'confirm' }))
    try {
      const result = await callSubscriptionsAuth<ClearResult>(rpc, 'clearUsageHistory', { provider, confirm: true })
      if (!alive.current) return
      setConfirm(undefined)
      setClearErrors(result.errors)
      dispatch({ type: 'cleared' })
    } catch (error) {
      if (!alive.current) return
      setConfirm(current => clearConfirmReducer(current ?? CLEAR_CONFIRM_OPEN, { type: 'failed', message: messageOf(error) }))
      // The cut-off may have been written even though the purge failed: show what the server now reports.
      dispatch({ type: 'refresh' })
    }
  }
  return <dialog className="dsh-subscription-manager" ref={dialog} aria-labelledby={titleId}
    onCancel={event => { if (confirm !== undefined) event.preventDefault() }} onClose={onClose}
    style={{ width: 620, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto' }}>
    <style>{providerSettingsCss}</style>
    <UsageDialogBody name={name} state={state} t={t} titleId={titleId} clearErrors={clearErrors}
      onAction={dispatch} onClear={() => setConfirm(CLEAR_CONFIRM_OPEN)} onClose={onClose} />
    {confirm !== undefined && state.response !== undefined && <ClearUsageHistoryDialog name={name} stored={state.response.stored}
      state={confirm} t={t} onCancel={() => setConfirm(undefined)} onConfirm={() => { void clear() }} />}
  </dialog>
}
