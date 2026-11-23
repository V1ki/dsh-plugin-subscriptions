import { useMemo, useState } from 'react'
import type {
  DashboardDailyBucket,
  DashboardModelSummary,
  DashboardProviderBreakdown,
  TokenTotals,
} from '../usage/usage-dashboard.js'
import type { DistributionMode } from './usage-dashboard-state.js'
import {
  computeNiceTicks,
  formatCompactTokens,
  formatPercent,
  formatShortUtcDate,
  formatTokens,
  providerAccentColor,
  providerDisplayName,
  type Translate,
} from './usage-format.js'

interface Props {
  daily: readonly DashboardDailyBucket[]
  models: readonly DashboardModelSummary[]
  providerBreakdown: readonly DashboardProviderBreakdown[]
  distributionMode: DistributionMode
  onDistributionMode: (mode: DistributionMode) => void
  onSelectDate?: (date: string) => void
  t: Translate
}

const CHART_W = 580
const CHART_H = 224
const PAD_LEFT = 48
const PAD_RIGHT = 12
const PAD_TOP = 12
const PAD_BOTTOM = 28
const PLOT_W = CHART_W - PAD_LEFT - PAD_RIGHT
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM

function DailyTrendChart({
  daily,
  onSelectDate,
  t,
}: {
  daily: readonly DashboardDailyBucket[]
  onSelectDate?: (date: string) => void
  t: Translate
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | undefined>(undefined)

  const { maxVal, ticks, hasData, xTickIndices } = useMemo(() => {
    let max = 0
    for (const day of daily) {
      if (day.totalTokens > max) max = day.totalTokens
    }
    const niceTicks = computeNiceTicks(max, 4)
    const top = niceTicks[niceTicks.length - 1] ?? 1
    const indices: number[] = []
    if (daily.length > 0) {
      const target = Math.min(6, daily.length)
      if (target === 1) {
        indices.push(0)
      } else {
        for (let i = 0; i < target; i++) {
          const idx = Math.round((i * (daily.length - 1)) / (target - 1))
          if (indices[indices.length - 1] !== idx) indices.push(idx)
        }
      }
    }
    return { maxVal: top, ticks: niceTicks, hasData: max > 0, xTickIndices: indices }
  }, [daily])

  const hovered = hoveredIdx !== undefined ? daily[hoveredIdx] : undefined
  const step = daily.length > 0 ? PLOT_W / daily.length : PLOT_W
  const barWidth = Math.max(2, Math.min(24, step * 0.68))

  return (
    <section className="dsh-usage-card" aria-label={t('usageTrendTitle')}>
      <div className="dsh-usage-card-header">
        <div>
          <h2 className="dsh-usage-card-title">{t('usageTrendTitle')}</h2>
          <p className="dsh-usage-card-subtitle">{t('usageTrendSubtitle')}</p>
        </div>
        <div className="dsh-usage-legend" aria-hidden="true">
          <span className="dsh-usage-legend-item">
            <span className="dsh-usage-legend-swatch" style={{ background: 'var(--dsh-tok-input)' }} />
            {t('usageLegendInput')}
          </span>
          <span className="dsh-usage-legend-item">
            <span className="dsh-usage-legend-swatch" style={{ background: 'var(--dsh-tok-output)' }} />
            {t('usageLegendOutput')}
          </span>
          <span className="dsh-usage-legend-item">
            <span className="dsh-usage-legend-swatch" style={{ background: 'var(--dsh-tok-cache-read)' }} />
            {t('usageLegendCacheRead')}
          </span>
          <span className="dsh-usage-legend-item">
            <span className="dsh-usage-legend-swatch" style={{ background: 'var(--dsh-tok-cache-write)' }} />
            {t('usageLegendCacheWrite')}
          </span>
        </div>
      </div>

      {!hasData ? (
        <p className="dsh-usage-card-subtitle" style={{ margin: '24px 0', textAlign: 'center' }}>
          {t('usageTrendEmpty')}
        </p>
      ) : (
        <div className="dsh-usage-chart-wrap" onMouseLeave={() => setHoveredIdx(undefined)}>
          <svg
            className="dsh-usage-chart-svg"
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            role="img"
            aria-label={t('usageTrendTitle')}
          >
            {/* Horizontal gridlines + Y ticks */}
            {ticks.map(tick => {
              const y = PAD_TOP + PLOT_H - (tick / maxVal) * PLOT_H
              return (
                <g key={tick}>
                  <line
                    x1={PAD_LEFT}
                    x2={CHART_W - PAD_RIGHT}
                    y1={y}
                    y2={y}
                    stroke="var(--dsw-alias-border-l2)"
                    strokeWidth="0.75"
                    strokeDasharray={tick === 0 ? undefined : '3 3'}
                  />
                  <text
                    x={PAD_LEFT - 8}
                    y={y + 3.5}
                    textAnchor="end"
                    fontSize="10.5"
                    fill="var(--dsw-alias-label-tertiary)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatCompactTokens(tick)}
                  </text>
                </g>
              )
            })}

            {/* Stacked bars */}
            {daily.map((day, index) => {
              const slotX = PAD_LEFT + index * step
              const barX = slotX + (step - barWidth) / 2
              const segments = [
                { key: 'input', value: day.inputTokens, color: 'var(--dsh-tok-input)' },
                { key: 'output', value: day.outputTokens, color: 'var(--dsh-tok-output)' },
                { key: 'cacheRead', value: day.cacheReadTokens, color: 'var(--dsh-tok-cache-read)' },
                { key: 'cacheWrite', value: day.cacheWriteTokens, color: 'var(--dsh-tok-cache-write)' },
              ]
              let yCursor = PAD_TOP + PLOT_H
              const isHovered = hoveredIdx === index
              return (
                <g
                  key={day.date}
                  style={{ cursor: onSelectDate ? 'pointer' : 'default' }}
                  onMouseEnter={() => setHoveredIdx(index)}
                  onClick={() => onSelectDate?.(day.date)}
                >
                  {isHovered && (
                    <rect
                      x={slotX}
                      y={PAD_TOP}
                      width={step}
                      height={PLOT_H}
                      rx={3}
                      fill="var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08))"
                    />
                  )}
                  {/* Transparent hit target across full column height for effortless hover */}
                  <rect x={slotX} y={PAD_TOP} width={step} height={PLOT_H} fill="transparent" />
                  {segments.map(seg => {
                    if (seg.value <= 0) return null
                    const h = Math.max(1, (seg.value / maxVal) * PLOT_H)
                    yCursor -= h
                    return (
                      <rect
                        key={seg.key}
                        x={barX}
                        y={yCursor}
                        width={barWidth}
                        height={h}
                        rx={1.2}
                        fill={seg.color}
                        opacity={hoveredIdx === undefined || isHovered ? 0.94 : 0.52}
                      />
                    )
                  })}
                </g>
              )
            })}

            {/* X-axis ticks */}
            {xTickIndices.map(idx => {
              const day = daily[idx]
              const x = PAD_LEFT + idx * step + step / 2
              const anchor = idx === 0 ? 'start' : idx === daily.length - 1 ? 'end' : 'middle'
              return (
                <text
                  key={day.date}
                  x={x}
                  y={CHART_H - 6}
                  textAnchor={anchor}
                  fontSize="10.5"
                  fill="var(--dsw-alias-label-tertiary)"
                >
                  {formatShortUtcDate(day.date)}
                </text>
              )
            })}
          </svg>

          {hovered !== undefined && hoveredIdx !== undefined && (
            <div
              className="dsh-usage-tooltip"
              style={
                hoveredIdx > daily.length * 0.58
                  ? { left: 12 }
                  : { right: 12 }
              }
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {hovered.date} (UTC)
              </div>
              <div className="dsh-usage-tooltip-row" style={{ fontWeight: 600, marginBottom: 4 }}>
                <span>{t('usageKpiTotal')}</span>
                <span>{formatTokens(hovered.totalTokens)}</span>
              </div>
              <div className="dsh-usage-tooltip-row">
                <span style={{ color: 'var(--dsh-tok-input)' }}>{t('usageLegendInput')}</span>
                <span>{formatTokens(hovered.inputTokens)}</span>
              </div>
              <div className="dsh-usage-tooltip-row">
                <span style={{ color: 'var(--dsh-tok-output)' }}>{t('usageLegendOutput')}</span>
                <span>{formatTokens(hovered.outputTokens)}</span>
              </div>
              <div className="dsh-usage-tooltip-row">
                <span style={{ color: 'var(--dsh-tok-cache-read)' }}>{t('usageLegendCacheRead')}</span>
                <span>{formatTokens(hovered.cacheReadTokens)}</span>
              </div>
              <div className="dsh-usage-tooltip-row">
                <span style={{ color: 'var(--dsh-tok-cache-write)' }}>{t('usageLegendCacheWrite')}</span>
                <span>{formatTokens(hovered.cacheWriteTokens)}</span>
              </div>
              {hovered.reasoningTokens > 0 && (
                <div style={{ marginTop: 4, opacity: 0.8 }}>
                  {t('usageKpiReasoning', { count: formatTokens(hovered.reasoningTokens) })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function TokenProgressBar({ totals, maxTokens }: { totals: TokenTotals; maxTokens: number }) {
  if (maxTokens <= 0 || totals.totalTokens <= 0) {
    return <div className="dsh-usage-dist-track" aria-hidden="true" />
  }
  const widthPct = (value: number) => `${(value / maxTokens) * 100}%`
  return (
    <div className="dsh-usage-dist-track" aria-hidden="true">
      {totals.inputTokens > 0 && (
        <div style={{ width: widthPct(totals.inputTokens), background: 'var(--dsh-tok-input)' }} />
      )}
      {totals.outputTokens > 0 && (
        <div style={{ width: widthPct(totals.outputTokens), background: 'var(--dsh-tok-output)' }} />
      )}
      {totals.cacheReadTokens > 0 && (
        <div style={{ width: widthPct(totals.cacheReadTokens), background: 'var(--dsh-tok-cache-read)' }} />
      )}
      {totals.cacheWriteTokens > 0 && (
        <div style={{ width: widthPct(totals.cacheWriteTokens), background: 'var(--dsh-tok-cache-write)' }} />
      )}
    </div>
  )
}

function DistributionChart({
  models,
  providerBreakdown,
  mode,
  onMode,
  t,
}: {
  models: readonly DashboardModelSummary[]
  providerBreakdown: readonly DashboardProviderBreakdown[]
  mode: DistributionMode
  onMode: (mode: DistributionMode) => void
  t: Translate
}) {
  const [expanded, setExpanded] = useState(false)
  const MAX_VISIBLE = 7

  const rows = mode === 'model' ? models : providerBreakdown
  const visibleRows = mode === 'model' && !expanded ? models.slice(0, MAX_VISIBLE) : rows
  const maxTokens = rows.length > 0 ? rows[0].totalTokens : 0

  return (
    <section className="dsh-usage-card" aria-label={t('usageDistributionTitle')}>
      <div className="dsh-usage-card-header">
        <h2 className="dsh-usage-card-title">{t('usageDistributionTitle')}</h2>
        <div className="dsh-usage-segmented dsh-usage-segmented-compact" role="group" aria-label={t('usageDistributionTitle')}>
          <button
            type="button"
            className="dsh-usage-pill"
            aria-pressed={mode === 'model'}
            onClick={() => onMode('model')}
          >
            {t('usageByModel')}
          </button>
          <button
            type="button"
            className="dsh-usage-pill"
            aria-pressed={mode === 'provider'}
            onClick={() => onMode('provider')}
          >
            {t('usageByProvider')}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="dsh-usage-card-subtitle" style={{ margin: '24px 0', textAlign: 'center' }}>
          {t('usageDistributionEmpty')}
        </p>
      ) : (
        <div className="dsh-usage-dist-list">
          {mode === 'model'
            ? (visibleRows as readonly DashboardModelSummary[]).map(entry => (
                <div key={`${entry.provider}:${entry.model}`} className="dsh-usage-dist-row">
                  <div className="dsh-usage-dist-head">
                    <span className="dsh-usage-dist-label" title={`${providerDisplayName(entry.provider)} · ${entry.model}`}>
                      <span className="dsh-usage-dot" style={{ background: providerAccentColor(entry.provider) }} />
                      <span>{entry.model}</span>
                    </span>
                    <span className="dsh-usage-dist-val" title={formatTokens(entry.totalTokens)}>
                      <strong>{formatCompactTokens(entry.totalTokens)}</strong> · {formatPercent(entry.share)}
                    </span>
                  </div>
                  <TokenProgressBar totals={entry} maxTokens={maxTokens} />
                  <div className="dsh-usage-dist-sub">
                    {providerDisplayName(entry.provider)} · {t('usageKpiInputShort')} {formatCompactTokens(entry.inputTokens)}
                    {' · '}{t('usageKpiOutputShort')} {formatCompactTokens(entry.outputTokens)}
                    {' · '}{t('usageKpiCacheReadShort')} {formatCompactTokens(entry.cacheReadTokens)}
                    {entry.cacheWriteTokens > 0 && ` · ${t('usageKpiCacheWriteShort')} ${formatCompactTokens(entry.cacheWriteTokens)}`}
                    {entry.reasoningTokens > 0 && ` · ${t('usageKpiReasoning', { count: formatCompactTokens(entry.reasoningTokens) })}`}
                  </div>
                </div>
              ))
            : (visibleRows as readonly DashboardProviderBreakdown[]).map(entry => (
                <div key={entry.provider} className="dsh-usage-dist-row">
                  <div className="dsh-usage-dist-head">
                    <span className="dsh-usage-dist-label">
                      <span className="dsh-usage-dot" style={{ background: providerAccentColor(entry.provider) }} />
                      <span>{providerDisplayName(entry.provider)}</span>
                    </span>
                    <span className="dsh-usage-dist-val" title={formatTokens(entry.totalTokens)}>
                      <strong>{formatCompactTokens(entry.totalTokens)}</strong> · {formatPercent(entry.share)}
                    </span>
                  </div>
                  <TokenProgressBar totals={entry} maxTokens={maxTokens} />
                  <div className="dsh-usage-dist-sub">
                    {t('usageKpiModelsCount', { count: entry.activeModels })}
                    {' · '}{t('usageKpiAccountsCount', { accounts: entry.activeAccounts })}
                    {' · '}{t('usageKpiInputShort')} {formatCompactTokens(entry.inputTokens)}
                    {' · '}{t('usageKpiOutputShort')} {formatCompactTokens(entry.outputTokens)}
                    {' · '}{t('usageKpiCacheReadShort')} {formatCompactTokens(entry.cacheReadTokens)}
                  </div>
                </div>
              ))}
          {mode === 'model' && models.length > MAX_VISIBLE && (
            <button
              type="button"
              className="dsh-usage-btn dsh-usage-btn-quiet"
              style={{ alignSelf: 'flex-start', padding: '0 6px', minHeight: 26 }}
              onClick={() => setExpanded(prev => !prev)}
            >
              {expanded
                ? t('usageDistributionShowLess')
                : t('usageDistributionShowMore', { count: models.length - MAX_VISIBLE })}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

export function UsageCharts({
  daily,
  models,
  providerBreakdown,
  distributionMode,
  onDistributionMode,
  onSelectDate,
  t,
}: Props) {
  return (
    <div className="dsh-usage-charts-grid">
      <DailyTrendChart daily={daily} {...onSelectDate ? { onSelectDate } : {}} t={t} />
      <DistributionChart
        models={models}
        providerBreakdown={providerBreakdown}
        mode={distributionMode}
        onMode={onDistributionMode}
        t={t}
      />
    </div>
  )
}
