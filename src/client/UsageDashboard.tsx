import { useEffect, useReducer, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClearResult } from '../usage/service.js'
import type { TrackedProvider } from '../usage/usage-schema.js'
import type { DashboardRange, UsageDashboardResponse } from '../usage/usage-dashboard.js'
import { en, type SubscriptionsKey } from './locales.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { usageDashboardCss } from './usage-dashboard-styles.js'
import {
  CLEAR_CONFIRM_OPEN,
  clearConfirmReducer,
  initialUsageDashboardState,
  usageDashboardReducer,
  type ClearConfirmState,
  type ProviderFilter,
  type UsageDashboardAction,
  type UsageDashboardState,
} from './usage-dashboard-state.js'
import {
  TRACKED_PROVIDERS,
  formatCompactTokens,
  formatTokens,
  providerDisplayName,
  type Translate,
} from './usage-format.js'
import { UsageHeatmap } from './UsageHeatmap.js'
import { UsageCharts } from './UsageCharts.js'
import { ActiveWindowsPanel } from './ActiveWindowsPanel.js'
import { ClearUsageHistoryDialog } from './ClearUsageHistoryDialog.js'

/** Injected dependencies of {@link UsageDashboard} (slot `main` inject). */
export interface UsageDashboardInjected {
  rpc: ConnectionHandle['rpc']
  t: Translate
}

export type UsageDashboardProps = Partial<UsageDashboardInjected> & {
  /** Omit outer full-viewport scroll container and padding when hosted inside SubscriptionsPage. */
  embedded?: boolean
  /** Incremented by a parent tab container to trigger a silent background refresh. */
  refreshKey?: number
}

const RANGES: readonly { id: DashboardRange; key: SubscriptionsKey }[] = [
  { id: '7d', key: 'usageRange7d' },
  { id: '30d', key: 'usageRange30d' },
  { id: '90d', key: 'usageRange90d' },
  { id: 'all', key: 'usageRangeAll' },
]

function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatClockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export interface UsageDashboardViewProps {
  state: UsageDashboardState
  t: Translate
  onAction: (action: UsageDashboardAction) => void
  onOpenClear: () => void
  embedded?: boolean
}

/** Presentational dashboard view (pure & SSR-testable without RPC or browser DOM). */
export function UsageDashboardView({ state, t, onAction, onOpenClear, embedded = false }: UsageDashboardViewProps) {
  const { response, request, phase } = state
  const busy = phase === 'loading'

  const providerTotals = new Map<TrackedProvider, number>()
  for (const entry of response?.providers ?? []) {
    providerTotals.set(entry.provider, entry.totalTokens)
  }

  const allProviderTotal = (response?.providers ?? []).reduce((sum, p) => sum + p.totalTokens, 0)
  const selectedProviderInfo = request.provider === 'all'
    ? undefined
    : response?.providers.find(p => p.provider === request.provider)

  const accountSelectValue = request.account === 'all'
    ? 'all'
    : request.provider === 'all'
      ? request.account
      : `${request.provider}\u0000${request.account}`

  const handleAccountSelect = (raw: string) => {
    if (raw === 'all') {
      onAction({ type: 'account', account: 'all' })
      return
    }
    const sep = raw.indexOf('\u0000')
    if (sep > 0) {
      const provider = raw.slice(0, sep) as TrackedProvider
      const account = raw.slice(sep + 1)
      if (request.provider === 'all') {
        onAction({ type: 'providerAccount', provider, account })
      } else {
        onAction({ type: 'account', account })
      }
      return
    }
    onAction({ type: 'account', account: raw })
  }

  const summary = response?.summary
  const hasVisibleUsage = response !== undefined && (
    response.summary.totalTokens > 0
    || response.heatmap.some(d => d.totalTokens > 0)
    || response.quotaCycles.length > 0
    || response.activeWindows.length > 0
  )
  const hasAnyGlobalUsage = allProviderTotal > 0
  const isFiltered = request.provider !== 'all' || request.account !== 'all' || request.range !== 'all'

  const ioTotal = (summary?.inputTokens ?? 0) + (summary?.outputTokens ?? 0)
  const inputPct = ioTotal > 0 ? ((summary?.inputTokens ?? 0) / ioTotal) * 100 : 50
  const cacheBase = (summary?.inputTokens ?? 0) + (summary?.cacheReadTokens ?? 0) + (summary?.cacheWriteTokens ?? 0)
  const cacheHitPct = cacheBase > 0 ? Math.round(((summary?.cacheReadTokens ?? 0) / cacheBase) * 100) : 0

  return (
    <div className={embedded ? 'dsh-usage-dashboard dsh-usage-dashboard-embedded' : 'dsh-usage-dashboard'}>
      {!embedded && <style>{usageDashboardCss}</style>}
      <div className="dsh-usage-container">
        {/* Header */}
        <header className="dsh-usage-header">
          <div className="dsh-usage-title-group">
            <h1 className="dsh-usage-title">{t('usageDashboardTitle')}</h1>
            <p className="dsh-usage-subtitle">{t('usageDashboardSubtitle')}</p>
          </div>
          <div className="dsh-usage-header-actions">
            {response !== undefined && (
              <span className="dsh-usage-updated">
                {t('usageLastUpdated', { time: formatClockTime(response.generatedAt) })}
              </span>
            )}
            <button
              type="button"
              className="dsh-usage-btn"
              disabled={busy}
              onClick={() => onAction({ type: 'refresh' })}
            >
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
              {busy ? t('usageViewLoading') : t('usageRefresh')}
            </button>
            <button
              type="button"
              className="dsh-usage-btn dsh-usage-btn-danger"
              aria-haspopup="dialog"
              disabled={busy || response === undefined}
              onClick={onOpenClear}
            >
              {t('usageClearOpen')}
            </button>
          </div>
        </header>

        {/* Filter Bar */}
        <nav className="dsh-usage-filters" aria-label={t('providerTabs')}>
          <div className="dsh-usage-segmented dsh-usage-provider-pills" role="group" aria-label={t('providerTabs')}>
            <button
              type="button"
              className="dsh-usage-pill"
              aria-pressed={request.provider === 'all'}
              disabled={busy}
              onClick={() => onAction({ type: 'provider', provider: 'all' })}
            >
              <span>{t('usageProviderAll')}</span>
              {allProviderTotal > 0 && (
                <span className="dsh-usage-pill-badge">{formatCompactTokens(allProviderTotal)}</span>
              )}
            </button>
            {TRACKED_PROVIDERS.map(entry => {
              const total = providerTotals.get(entry.id) ?? 0
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="dsh-usage-pill"
                  aria-pressed={request.provider === entry.id}
                  disabled={busy}
                  onClick={() => onAction({ type: 'provider', provider: entry.id })}
                >
                  <span className="dsh-usage-dot" style={{ background: entry.colorVar }} />
                  <span>{entry.name}</span>
                  {total > 0 && (
                    <span className="dsh-usage-pill-badge">{formatCompactTokens(total)}</span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="dsh-usage-filter-right">
            <select
              className="dsh-usage-select"
              aria-label={t('usageAccount')}
              value={accountSelectValue}
              disabled={busy || response === undefined}
              onChange={event => handleAccountSelect(event.target.value)}
            >
              <option value="all">{t('usageAccountAll')}</option>
              {selectedProviderInfo !== undefined
                ? selectedProviderInfo.accounts.map(acct => (
                    <option key={acct.key} value={`${selectedProviderInfo.provider}\u0000${acct.key}`}>
                      {acct.loggedIn
                        ? acct.label ?? acct.key
                        : t('usageAccountLoggedOut', { account: acct.label ?? acct.key })}
                    </option>
                  ))
                : (response?.providers ?? [])
                    .filter(p => p.accounts.length > 0)
                    .map(p => (
                      <optgroup key={p.provider} label={providerDisplayName(p.provider)}>
                        {p.accounts.map(acct => (
                          <option key={`${p.provider}:${acct.key}`} value={`${p.provider}\u0000${acct.key}`}>
                            {acct.loggedIn
                              ? acct.label ?? acct.key
                              : t('usageAccountLoggedOut', { account: acct.label ?? acct.key })}
                          </option>
                        ))}
                      </optgroup>
                    ))}
            </select>

            <div className="dsh-usage-segmented" role="group" aria-label={t('usageKind')}>
              {RANGES.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className="dsh-usage-pill"
                  aria-pressed={request.range === item.id}
                  disabled={busy}
                  onClick={() => onAction({ type: 'range', range: item.id })}
                >
                  {t(item.key)}
                </button>
              ))}
            </div>
          </div>
        </nav>

        {/* Error & Partial Notices */}
        {phase === 'error' && (
          <div className="dsh-usage-banner dsh-usage-banner-error" role="alert">
            <span>{t('usageViewFailed', { message: state.error ?? '' })}</span>
            <button type="button" className="dsh-usage-btn" onClick={() => onAction({ type: 'retry' })}>
              {t('usageRetry')}
            </button>
          </div>
        )}
        {response !== undefined && response.errors.length > 0 && (
          <div className="dsh-usage-banner dsh-usage-banner-warn" role="status">
            <span>{t('usageDataErrors', { list: response.errors.join('; ') })}</span>
          </div>
        )}
        {state.clearErrors.length > 0 && (
          <div className="dsh-usage-banner dsh-usage-banner-warn" role="alert">
            <span>{t('usageClearPartial', { list: state.clearErrors.join('; ') })}</span>
          </div>
        )}

        {/* Initial loading state before first response */}
        {response === undefined && phase === 'loading' && (
          <div className="dsh-usage-empty" role="status">
            <p className="dsh-usage-empty-desc">{t('usageViewLoading')}</p>
          </div>
        )}

        {/* Empty states */}
        {response !== undefined && !hasVisibleUsage && (
          <div className="dsh-usage-empty">
            <h2 className="dsh-usage-empty-title">
              {hasAnyGlobalUsage && isFiltered
                ? t('usageEmptyFilter')
                : t('usageEmptyDashboard')}
            </h2>
            <p className="dsh-usage-empty-desc">
              {hasAnyGlobalUsage && isFiltered
                ? t('usageDashboardSubtitle')
                : response.cleared
                  ? t('usageEmptyDashboardCleared')
                  : t('usageEmptyDashboardHint')}
            </p>
            {hasAnyGlobalUsage && isFiltered && (
              <button
                type="button"
                className="dsh-usage-btn"
                style={{ marginTop: 6 }}
                onClick={() => onAction({ type: 'resetFilters' })}
              >
                {t('usageEmptyResetFilter')}
              </button>
            )}
          </div>
        )}

        {/* Main Dashboard Visualizations */}
        {response !== undefined && summary !== undefined && hasVisibleUsage && (
          <>
            {/* KPI Summary Cards */}
            <section className="dsh-usage-kpi-grid" aria-label={t('usageDashboardTitle')}>
              <article className="dsh-usage-kpi-card">
                <span className="dsh-usage-kpi-label">{t('usageKpiTotal')}</span>
                <span className="dsh-usage-kpi-value" title={formatTokens(summary.totalTokens)}>
                  {formatCompactTokens(summary.totalTokens)}
                </span>
                <div className="dsh-usage-kpi-sub">
                  <span>{t('usageKpiExact', { count: formatTokens(summary.totalTokens) })}</span>
                </div>
              </article>

              <article className="dsh-usage-kpi-card">
                <span className="dsh-usage-kpi-label">{t('usageKpiInputOutput')}</span>
                <span className="dsh-usage-kpi-value" style={{ fontSize: 19 }}>
                  {formatCompactTokens(summary.inputTokens)} / {formatCompactTokens(summary.outputTokens)}
                </span>
                <div className="dsh-usage-split-bar" aria-hidden="true">
                  <div style={{ width: `${inputPct}%`, background: 'var(--dsh-tok-input)' }} />
                  <div style={{ width: `${100 - inputPct}%`, background: 'var(--dsh-tok-output)' }} />
                </div>
                <div className="dsh-usage-kpi-sub">
                  <span>{t('usageKpiInputShort')} {formatCompactTokens(summary.inputTokens)}</span>
                  <span>{t('usageKpiOutputShort')} {formatCompactTokens(summary.outputTokens)}</span>
                  {summary.reasoningTokens > 0 && (
                    <span>{t('usageKpiReasoning', { count: formatCompactTokens(summary.reasoningTokens) })}</span>
                  )}
                </div>
              </article>

              <article className="dsh-usage-kpi-card">
                <span className="dsh-usage-kpi-label">{t('usageKpiCache')}</span>
                <span className="dsh-usage-kpi-value" style={{ fontSize: 19 }}>
                  {formatCompactTokens(summary.cacheReadTokens)} / {formatCompactTokens(summary.cacheWriteTokens)}
                </span>
                <div className="dsh-usage-split-bar" aria-hidden="true">
                  <div
                    style={{
                      width: `${cacheHitPct}%`,
                      background: 'var(--dsh-tok-cache-read)',
                    }}
                  />
                  <div
                    style={{
                      width: `${Math.max(0, 100 - cacheHitPct)}%`,
                      background: 'var(--dsh-tok-cache-write)',
                      opacity: summary.cacheWriteTokens > 0 ? 0.85 : 0.15,
                    }}
                  />
                </div>
                <div className="dsh-usage-kpi-sub">
                  {cacheBase > 0 ? (
                    <span>{t('usageKpiCacheHit', { percent: cacheHitPct })}</span>
                  ) : (
                    <span>
                      {t('usageKpiCacheReadShort')} 0 · {t('usageKpiCacheWriteShort')} 0
                    </span>
                  )}
                </div>
              </article>

              <article className="dsh-usage-kpi-card">
                <span className="dsh-usage-kpi-label">{t('usageKpiActivity')}</span>
                <span className="dsh-usage-kpi-value">
                  {t('usageKpiModelsCount', { count: summary.activeModels })}
                </span>
                <div className="dsh-usage-kpi-sub">
                  <span>{t('usageKpiDaysCount', { days: summary.activeDays })}</span>
                  <span>·</span>
                  <span>{t('usageKpiAccountsCount', { accounts: summary.activeAccounts })}</span>
                </div>
              </article>
            </section>

            {/* Calendar Heatmap */}
            <UsageHeatmap
              days={response.heatmap}
              {...state.selectedDate === undefined ? {} : { selectedDate: state.selectedDate }}
              onSelectDate={date => onAction(date === undefined ? { type: 'selectDate' } : { type: 'selectDate', date })}
              t={t}
            />

            {/* Daily Stacked Bar Trend + Model/Provider Distribution */}
            <UsageCharts
              daily={response.daily}
              models={response.models}
              providerBreakdown={response.providerBreakdown}
              distributionMode={state.distributionMode}
              onDistributionMode={mode => onAction({ type: 'distribution', mode })}
              onSelectDate={date => onAction({ type: 'selectDate', date })}
              t={t}
            />

            {/* Current & Recent Quota Cycles */}
            <ActiveWindowsPanel
              windows={response.quotaCycles.length > 0 ? response.quotaCycles : response.activeWindows}
              now={response.generatedAt}
              t={t}
            />
          </>
        )}
      </div>
    </div>
  )
}

/** Sidebar plugin home page for Subscription Usage. */
export function UsageDashboard(props: UsageDashboardProps) {
  const { rpc, embedded = false, refreshKey = 0 } = props
  const t = props.t ?? fallbackTranslate
  const [state, dispatch] = useReducer(usageDashboardReducer, undefined, initialUsageDashboardState)
  const [clearTarget, setClearTarget] = useState<ProviderFilter | undefined>(undefined)
  const [clearConfirm, setClearConfirm] = useState<ClearConfirmState | undefined>(undefined)
  const aliveRef = useRef(true)
  const lastRefreshKey = useRef(refreshKey)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    if (refreshKey !== lastRefreshKey.current) {
      lastRefreshKey.current = refreshKey
      dispatch({ type: 'refresh' })
    }
  }, [refreshKey])

  useEffect(() => {
    if (rpc === undefined) return
    let active = true
    void callSubscriptionsAuth<UsageDashboardResponse>(rpc, 'usageDashboard', {
      provider: state.request.provider,
      account: state.request.account,
      range: state.request.range,
    })
      .then(response => {
        if (active) dispatch({ type: 'loaded', response })
      })
      .catch(error => {
        if (active) dispatch({ type: 'failed', message: messageOf(error) })
      })
    return () => { active = false }
  }, [rpc, state.load, state.request.provider, state.request.account, state.request.range])

  async function runClear(): Promise<void> {
    if (rpc === undefined || clearTarget === undefined || clearConfirm?.phase === 'clearing') return
    setClearConfirm(clearConfirmReducer(clearConfirm ?? CLEAR_CONFIRM_OPEN, { type: 'confirm' }))
    try {
      const result = await callSubscriptionsAuth<ClearResult>(rpc, 'clearUsageHistory', {
        provider: clearTarget,
        confirm: true,
      })
      if (!aliveRef.current) return
      setClearConfirm(undefined)
      setClearTarget(undefined)
      dispatch({ type: 'cleared', clearErrors: result.errors })
    } catch (error) {
      if (!aliveRef.current) return
      setClearConfirm(current => clearConfirmReducer(current ?? CLEAR_CONFIRM_OPEN, { type: 'failed', message: messageOf(error) }))
      dispatch({ type: 'refresh' })
    }
  }

  if (rpc === undefined) {
    return (
      <div className={embedded ? 'dsh-usage-dashboard dsh-usage-dashboard-embedded' : 'dsh-usage-dashboard'}>
        {!embedded && <style>{usageDashboardCss}</style>}
        <div className="dsh-usage-container">
          <div className="dsh-usage-empty">
            <p className="dsh-usage-empty-desc">{t('usageDashboardUnavailable')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <UsageDashboardView
        state={state}
        t={t}
        embedded={embedded}
        onAction={dispatch}
        onOpenClear={() => {
          setClearTarget(state.request.provider)
          setClearConfirm(CLEAR_CONFIRM_OPEN)
        }}
      />
      {clearConfirm !== undefined && clearTarget !== undefined && state.response !== undefined && (
        <ClearUsageHistoryDialog
          target={clearTarget}
          clearInfo={state.response.clearInfo}
          state={clearConfirm}
          t={t}
          onTargetChange={setClearTarget}
          onCancel={() => {
            setClearConfirm(undefined)
            setClearTarget(undefined)
          }}
          onConfirm={() => { void runClear() }}
        />
      )}
    </>
  )
}
