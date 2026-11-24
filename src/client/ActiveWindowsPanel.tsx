import { useMemo, useState } from 'react'
import type { DashboardActiveWindow } from '../usage/usage-dashboard.js'
import {
  MARKER_KEYS,
  computeNiceTicks,
  formatCompactTokens,
  formatCycleAxisLabel,
  formatCycleTimeRange,
  formatPercent,
  formatRelativeDuration,
  formatTokens,
  kindLabel,
  providerAccentColor,
  providerDisplayName,
  quotaProgressTone,
  type Translate,
} from './usage-format.js'

export type CycleKindFilter = 'all' | '5h' | 'weekly'

interface Props {
  windows: readonly DashboardActiveWindow[]
  now?: number
  initialKind?: CycleKindFilter
  initialSelectedId?: string
  t: Translate
}

const MAX_CHART_CYCLES = 24
const CHART_W = 980
const CHART_H = 290
const PAD_LEFT = 58
const PAD_RIGHT = 48
const PAD_TOP = 26
const PAD_BOTTOM = 44
const PLOT_W = CHART_W - PAD_LEFT - PAD_RIGHT
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM
const QUOTA_TICKS = [0, 25, 50, 75, 100] as const

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function toneStrokeColor(tone: 'ok' | 'warn' | 'danger'): string {
  switch (tone) {
    case 'ok': return 'var(--dsw-alias-state-success-primary, #10b981)'
    case 'warn': return 'var(--dsw-alias-state-warn-primary, #f59e0b)'
    case 'danger': return 'var(--dsw-alias-state-error-primary, #ef4444)'
  }
}

function statusBadge(
  win: DashboardActiveWindow,
  now: number,
  t: Translate,
): { text: string; className: string } {
  switch (win.status) {
    case 'open': {
      const countdown = win.resetAt !== undefined && win.resetAt > now
        ? ` · ${t('usageCycleResetsIn', { time: formatRelativeDuration(win.resetAt - now) })}`
        : ''
      return {
        text: `${t('usageWindowStatusOpen')}${countdown}`,
        className: 'dsh-usage-badge dsh-usage-badge-open',
      }
    }
    case 'ended-early':
      return { text: t('usageWindowStatusEndedEarly'), className: 'dsh-usage-badge dsh-usage-badge-warn' }
    case 'closed':
      return { text: t('usageWindowStatusClosed'), className: 'dsh-usage-badge' }
  }
}

function cycleKey(win: DashboardActiveWindow, fallbackIndex: number): string {
  return win.id || `${win.provider}:${win.account}:${win.kind}:${win.scope ?? ''}:${fallbackIndex}`
}

function shortKindTag(win: DashboardActiveWindow, t: Translate): string {
  if (win.kind === '5h') return win.scope ? `5h · ${win.scope}` : '5h'
  if (win.kind === 'weekly') return win.scope ? `${t('usageWeekly')} · ${win.scope}` : t('usageWeekly')
  return kindLabel(t, win.scope === undefined ? { kind: win.kind } : { kind: win.kind, scope: win.scope })
}

/**
 * Pure-SVG Dual-Axis Combo Chart for Quota Cycles:
 * - Left Y-axis + rounded bars: Cycle Token Usage (`totalTokens`), colored by provider
 * - Right Y-axis (0–100%) + line & semantic dots: Quota Utilization % (`quotaUsedPercent`), breaking cleanly across missing gaps
 * - Top clickable strip for active (`isCurrent`) cycles + click-to-pin inline Cycle Inspector strip below
 */
export function ActiveWindowsPanel({ windows, now = Date.now(), initialKind = 'all', initialSelectedId, t }: Props) {
  const [kindFilter, setKindFilter] = useState<CycleKindFilter>(initialKind)
  const [hoveredIdx, setHoveredIdx] = useState<number | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId)

  const kindCounts = useMemo(() => {
    let count5h = 0
    let countWeekly = 0
    for (const win of windows) {
      if (win.kind === '5h') count5h += 1
      else if (win.kind === 'weekly') countWeekly += 1
    }
    return { all: windows.length, '5h': count5h, weekly: countWeekly }
  }, [windows])

  // Keep up to MAX_CHART_CYCLES most recent cycles, ordered chronologically oldest -> newest (left -> right).
  const chartCycles = useMemo(() => {
    const matching = windows.filter(win => {
      if (kindFilter === '5h') return win.kind === '5h'
      if (kindFilter === 'weekly') return win.kind === 'weekly'
      return true
    })
    const recent = matching.slice(0, MAX_CHART_CYCLES)
    return [...recent].sort((a, b) => {
      const ta = a.startsAt ?? a.countedFrom
      const tb = b.startsAt ?? b.countedFrom
      if (ta !== tb) return ta - tb
      if (a.isCurrent !== b.isCurrent) return Number(a.isCurrent) - Number(b.isCurrent)
      return a.id.localeCompare(b.id)
    })
  }, [windows, kindFilter])

  const activePills = useMemo(() => {
    return chartCycles
      .filter(win => win.isCurrent)
      .sort((a, b) => (b.quotaUsedPercent ?? -1) - (a.quotaUsedPercent ?? -1) || b.totalTokens - a.totalTokens)
  }, [chartCycles])

  const { tokenTicks, maxTokens, xTickIndices, lineSegments } = useMemo(() => {
    let peakTok = 0
    for (const win of chartCycles) {
      if (win.totalTokens > peakTok) peakTok = win.totalTokens
    }
    const ticks = computeNiceTicks(peakTok, 4)
    const topTok = ticks[ticks.length - 1] ?? 1

    const n = chartCycles.length
    const xIndices: number[] = []
    if (n > 0) {
      const maxLabels = Math.min(n, 8)
      if (maxLabels === n) {
        for (let i = 0; i < n; i++) xIndices.push(i)
      } else {
        for (let i = 0; i < maxLabels; i++) {
          const idx = Math.round((i * (n - 1)) / (maxLabels - 1))
          if (xIndices[xIndices.length - 1] !== idx) xIndices.push(idx)
        }
      }
    }

    // Build contiguous polyline segments only across cycles with defined quotaUsedPercent (never plotting undefined as 0%).
    const stepVal = n > 0 ? PLOT_W / n : PLOT_W
    const segments: { points: string }[] = []
    let currentPts: string[] = []
    for (let i = 0; i < n; i++) {
      const pct = chartCycles[i].quotaUsedPercent
      if (pct !== undefined && Number.isFinite(pct)) {
        const cx = PAD_LEFT + i * stepVal + stepVal / 2
        const cy = PAD_TOP + PLOT_H - (clampPercent(pct) / 100) * PLOT_H
        currentPts.push(`${cx.toFixed(1)},${cy.toFixed(1)}`)
      } else {
        if (currentPts.length >= 2) segments.push({ points: currentPts.join(' ') })
        currentPts = []
      }
    }
    if (currentPts.length >= 2) segments.push({ points: currentPts.join(' ') })

    return { tokenTicks: ticks, maxTokens: topTok, xTickIndices: xIndices, lineSegments: segments }
  }, [chartCycles])

  const selectedCycle = useMemo(() => {
    if (selectedId === undefined) return undefined
    return chartCycles.find((win, idx) => cycleKey(win, idx) === selectedId)
  }, [chartCycles, selectedId])

  const hoveredCycle = hoveredIdx !== undefined ? chartCycles[hoveredIdx] : undefined
  const step = chartCycles.length > 0 ? PLOT_W / chartCycles.length : PLOT_W
  const barWidth = Math.max(10, Math.min(34, step * 0.56))

  const toggleSelect = (id: string) => {
    setSelectedId(current => (current === id ? undefined : id))
  }

  return (
    <section className="dsh-usage-card" aria-label={t('usageActiveWindowsTitle')}>
      <div className="dsh-usage-card-header">
        <div>
          <h2 className="dsh-usage-card-title">{t('usageActiveWindowsTitle')}</h2>
          <p className="dsh-usage-card-subtitle">{t('usageActiveWindowsNote')}</p>
        </div>

        {windows.length > 0 && (
          <div className="dsh-usage-cycle-controls">
            <div className="dsh-usage-segmented" role="group" aria-label={t('usageKind')}>
              <button
                type="button"
                className="dsh-usage-pill"
                aria-pressed={kindFilter === 'all'}
                onClick={() => setKindFilter('all')}
              >
                {t('usageCyclesKindAll', { count: kindCounts.all })}
              </button>
              <button
                type="button"
                className="dsh-usage-pill"
                aria-pressed={kindFilter === '5h'}
                disabled={kindCounts['5h'] === 0}
                onClick={() => setKindFilter('5h')}
              >
                {t('usageCyclesKind5h', { count: kindCounts['5h'] })}
              </button>
              <button
                type="button"
                className="dsh-usage-pill"
                aria-pressed={kindFilter === 'weekly'}
                disabled={kindCounts.weekly === 0}
                onClick={() => setKindFilter('weekly')}
              >
                {t('usageCyclesKindWeekly', { count: kindCounts.weekly })}
              </button>
            </div>
          </div>
        )}
      </div>

      {chartCycles.length === 0 ? (
        <p className="dsh-usage-card-subtitle" style={{ margin: '12px 0', textAlign: 'center' }}>
          {t('usageActiveWindowsEmpty')}
        </p>
      ) : (
        <>
          {/* Compact Active Cycles Summary Strip + Chart Legend */}
          <div className="dsh-usage-cycles-legend-row">
            {activePills.length > 0 ? (
              <div className="dsh-usage-active-strip" role="group" aria-label={t('usageCyclesActiveStripLabel')}>
                <span className="dsh-usage-active-strip-label">{t('usageCyclesActiveStripLabel')}</span>
                {activePills.map((win, idx) => {
                  const id = cycleKey(win, idx)
                  const hasQuota = win.quotaUsedPercent !== undefined && Number.isFinite(win.quotaUsedPercent)
                  const pct = hasQuota ? clampPercent(win.quotaUsedPercent as number) : undefined
                  const tone = pct !== undefined ? quotaProgressTone(pct) : 'na'
                  const accountText = win.accountLabel ?? win.account
                  const isSelected = selectedId === id
                  return (
                    <button
                      key={id}
                      type="button"
                      className="dsh-usage-active-pill"
                      aria-pressed={isSelected}
                      title={`${providerDisplayName(win.provider)} · ${accountText} · ${shortKindTag(win, t)}`}
                      onClick={() => toggleSelect(id)}
                    >
                      <span className="dsh-usage-dot" style={{ background: providerAccentColor(win.provider) }} />
                      <span>{providerDisplayName(win.provider)}</span>
                      <span className="dsh-usage-active-pill-kind">{shortKindTag(win, t)}</span>
                      <span className="dsh-usage-active-pill-tok">{formatCompactTokens(win.totalTokens)}</span>
                      <span className="dsh-usage-active-pill-pct" data-tone={tone}>
                        {pct !== undefined ? `${pct}%` : 'n/a'}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : <span />}

            <div className="dsh-usage-legend" aria-hidden="true">
              <span className="dsh-usage-legend-item">
                <span className="dsh-usage-legend-swatch" style={{ background: 'var(--dsh-tok-input)' }} />
                {t('usageCyclesLegendTokens')}
              </span>
              <span className="dsh-usage-legend-item">
                <span className="dsh-usage-legend-active-bar" />
                {t('usageCyclesLegendActive')}
              </span>
              <span className="dsh-usage-legend-item">
                <span className="dsh-usage-legend-line" />
                {t('usageCyclesLegendQuota')}
              </span>
              <span className="dsh-usage-legend-item">
                <span className="dsh-usage-legend-hollow" />
                {t('usageCyclesLegendNa')}
              </span>
            </div>
          </div>

          {/* Pure-SVG Dual-Axis Combo Chart */}
          <div className="dsh-usage-combo-wrap" onMouseLeave={() => setHoveredIdx(undefined)}>
            <svg
              className="dsh-usage-combo-svg"
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              role="img"
              aria-label={t('usageActiveWindowsTitle')}
            >
              {/* Axis titles */}
              <text
                x={PAD_LEFT - 10}
                y={13}
                textAnchor="end"
                fontSize="10"
                fontWeight="500"
                fill="var(--dsw-alias-label-tertiary)"
              >
                {t('usageCyclesAxisTokens')}
              </text>
              <text
                x={CHART_W - PAD_RIGHT + 8}
                y={13}
                textAnchor="start"
                fontSize="10"
                fontWeight="500"
                fill="var(--dsw-alias-label-tertiary)"
              >
                {t('usageCyclesAxisQuota')}
              </text>

              {/* Horizontal gridlines + Right Y-axis (0%..100%) */}
              {QUOTA_TICKS.map(pct => {
                const y = PAD_TOP + PLOT_H - (pct / 100) * PLOT_H
                return (
                  <g key={`q-${pct}`}>
                    <line
                      x1={PAD_LEFT}
                      x2={CHART_W - PAD_RIGHT}
                      y1={y}
                      y2={y}
                      stroke="var(--dsw-alias-border-l2)"
                      strokeWidth="0.75"
                      strokeDasharray={pct === 0 ? undefined : '3 3'}
                    />
                    <text
                      x={CHART_W - PAD_RIGHT + 8}
                      y={y + 3.5}
                      textAnchor="start"
                      fontSize="10.5"
                      fill="var(--dsw-alias-label-tertiary)"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {pct}%
                    </text>
                  </g>
                )
              })}

              {/* Subtle 80% quota warning guide */}
              <line
                x1={PAD_LEFT}
                x2={CHART_W - PAD_RIGHT}
                y1={PAD_TOP + PLOT_H - 0.8 * PLOT_H}
                y2={PAD_TOP + PLOT_H - 0.8 * PLOT_H}
                stroke="var(--dsw-alias-state-warn-primary, #f59e0b)"
                strokeOpacity="0.28"
                strokeWidth="1"
                strokeDasharray="4 4"
              />

              {/* Left Y-axis ticks (Token Usage) */}
              {tokenTicks.map(tick => {
                const ratio = maxTokens > 0 ? tick / maxTokens : 0
                const y = PAD_TOP + PLOT_H - ratio * PLOT_H
                return (
                  <text
                    key={`t-${tick}`}
                    x={PAD_LEFT - 10}
                    y={y + 3.5}
                    textAnchor="end"
                    fontSize="10.5"
                    fill="var(--dsw-alias-label-tertiary)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatCompactTokens(tick)}
                  </text>
                )
              })}

              {/* Cycle Bars + Provider Dots + Hit Targets */}
              {chartCycles.map((win, index) => {
                const id = cycleKey(win, index)
                const slotX = PAD_LEFT + index * step
                const cx = slotX + step / 2
                const barX = slotX + (step - barWidth) / 2
                const barH = win.totalTokens > 0 && maxTokens > 0
                  ? Math.max(3, (win.totalTokens / maxTokens) * PLOT_H)
                  : 0
                const barY = PAD_TOP + PLOT_H - barH
                const isHovered = hoveredIdx === index
                const isSelected = selectedId === id
                const emphasized = isHovered || isSelected
                const dimmed = (hoveredIdx !== undefined && !isHovered) || (hoveredIdx === undefined && selectedId !== undefined && !isSelected)
                const providerColor = providerAccentColor(win.provider)

                return (
                  <g
                    key={id}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredIdx(index)}
                    onClick={() => toggleSelect(id)}
                  >
                    {(isHovered || isSelected) && (
                      <rect
                        x={slotX + 1}
                        y={PAD_TOP}
                        width={Math.max(2, step - 2)}
                        height={PLOT_H}
                        rx={4}
                        fill={isSelected
                          ? 'var(--dsw-alias-interactive-bg-active, rgba(128,128,128,0.14))'
                          : 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08))'}
                      />
                    )}
                    {/* Full-column transparent hit area */}
                    <rect x={slotX} y={PAD_TOP} width={step} height={PLOT_H + 22} fill="transparent" />

                    {/* Token usage bar */}
                    {barH > 0 && (
                      <rect
                        x={barX}
                        y={barY}
                        width={barWidth}
                        height={barH}
                        rx={3.5}
                        fill={providerColor}
                        fillOpacity={emphasized ? 0.96 : dimmed ? 0.36 : win.isCurrent ? 0.88 : 0.68}
                        stroke={win.isCurrent ? 'var(--dsw-alias-label-primary)' : isSelected ? 'var(--dsw-alias-label-primary)' : 'none'}
                        strokeOpacity={win.isCurrent ? 0.6 : 0.85}
                        strokeWidth={win.isCurrent || isSelected ? 1.25 : 0}
                      />
                    )}

                    {/* Active cycle top dot marker */}
                    {win.isCurrent && (
                      <circle
                        cx={cx}
                        cy={Math.max(PAD_TOP + 4, barY - 7)}
                        r={3}
                        fill="var(--dsw-alias-state-success-primary, #10b981)"
                      />
                    )}

                    {/* Provider color dot beneath baseline */}
                    <circle
                      cx={cx}
                      cy={PAD_TOP + PLOT_H + 10}
                      r={2.8}
                      fill={providerColor}
                      opacity={dimmed ? 0.4 : 0.95}
                    />
                  </g>
                )
              })}

              {/* Quota % Polyline (contiguous segments only — never bridging undefined as 0%) */}
              {lineSegments.map((seg, i) => (
                <g key={`seg-${i}`} style={{ pointerEvents: 'none' }}>
                  <polyline
                    points={seg.points}
                    fill="none"
                    stroke="var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1))"
                    strokeWidth="4.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity="0.85"
                  />
                  <polyline
                    points={seg.points}
                    fill="none"
                    stroke="var(--dsw-alias-label-primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity="0.82"
                  />
                </g>
              ))}

              {/* Quota % Semantic Dots + Peak Ticks + Hollow N/A Markers */}
              {chartCycles.map((win, index) => {
                const id = cycleKey(win, index)
                const cx = PAD_LEFT + index * step + step / 2
                const isHovered = hoveredIdx === index
                const isSelected = selectedId === id
                const emphasized = isHovered || isSelected
                const pct = win.quotaUsedPercent !== undefined && Number.isFinite(win.quotaUsedPercent)
                  ? clampPercent(win.quotaUsedPercent)
                  : undefined

                if (pct === undefined) {
                  return (
                    <circle
                      key={`dot-${id}`}
                      data-quota-na="true"
                      cx={cx}
                      cy={PAD_TOP + PLOT_H - 4}
                      r={emphasized ? 4.2 : 3.2}
                      fill="var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1))"
                      stroke="var(--dsw-alias-label-tertiary)"
                      strokeWidth="1.5"
                      style={{ pointerEvents: 'none' }}
                    />
                  )
                }

                const cy = PAD_TOP + PLOT_H - (pct / 100) * PLOT_H
                const tone = quotaProgressTone(pct)
                const dotColor = toneStrokeColor(tone)
                const peakPct = win.quotaPeakPercent !== undefined && Number.isFinite(win.quotaPeakPercent)
                  ? clampPercent(win.quotaPeakPercent)
                  : undefined
                const showPeak = peakPct !== undefined && peakPct > pct
                const peakY = showPeak ? PAD_TOP + PLOT_H - (peakPct / 100) * PLOT_H : undefined

                return (
                  <g key={`dot-${id}`} style={{ pointerEvents: 'none' }}>
                    {showPeak && peakY !== undefined && (
                      <>
                        <line
                          x1={cx}
                          x2={cx}
                          y1={cy - 4}
                          y2={peakY}
                          stroke={dotColor}
                          strokeWidth="1.25"
                          strokeDasharray="2 1.5"
                          opacity="0.8"
                        />
                        <line
                          x1={cx - 3.5}
                          x2={cx + 3.5}
                          y1={peakY}
                          y2={peakY}
                          stroke={dotColor}
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </>
                    )}
                    <circle
                      cx={cx}
                      cy={cy}
                      r={emphasized ? 6.5 : 5.2}
                      fill="var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1))"
                    />
                    <circle
                      data-quota-point="true"
                      data-tone={tone}
                      cx={cx}
                      cy={cy}
                      r={emphasized ? 4.8 : 3.6}
                      fill={dotColor}
                    />
                  </g>
                )
              })}

              {/* X-axis chronological cycle labels (thinned to guarantee zero overlap) */}
              {xTickIndices.map(idx => {
                const win = chartCycles[idx]
                const x = PAD_LEFT + idx * step + step / 2
                const anchor = idx === 0 && chartCycles.length > 4
                  ? 'start'
                  : idx === chartCycles.length - 1 && chartCycles.length > 4
                    ? 'end'
                    : 'middle'
                return (
                  <text
                    key={`x-${idx}`}
                    x={x}
                    y={CHART_H - 10}
                    textAnchor={anchor}
                    fontSize="10.5"
                    fill="var(--dsw-alias-label-tertiary)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatCycleAxisLabel(win)}
                  </text>
                )
              })}
            </svg>

            {/* Interactive Auto-Flipping Hover Tooltip */}
            {hoveredCycle !== undefined && hoveredIdx !== undefined && (() => {
              const badge = statusBadge(hoveredCycle, now, t)
              const hasQuota = hoveredCycle.quotaUsedPercent !== undefined && Number.isFinite(hoveredCycle.quotaUsedPercent)
              const pct = hasQuota ? clampPercent(hoveredCycle.quotaUsedPercent as number) : undefined
              const peakPct = hoveredCycle.quotaPeakPercent !== undefined && Number.isFinite(hoveredCycle.quotaPeakPercent)
                ? clampPercent(hoveredCycle.quotaPeakPercent)
                : undefined
              const range = formatCycleTimeRange(t, {
                ...hoveredCycle.startsAt === undefined ? {} : { startsAt: hoveredCycle.startsAt },
                countedFrom: hoveredCycle.countedFrom,
                ...hoveredCycle.endsAt === undefined ? {} : { endsAt: hoveredCycle.endsAt },
              })
              const accountText = hoveredCycle.loggedIn
                ? hoveredCycle.accountLabel ?? hoveredCycle.account
                : t('usageAccountLoggedOut', { account: hoveredCycle.accountLabel ?? hoveredCycle.account })
              const label = kindLabel(t, hoveredCycle.scope === undefined ? { kind: hoveredCycle.kind } : { kind: hoveredCycle.kind, scope: hoveredCycle.scope })
              return (
                <div
                  className="dsh-usage-tooltip"
                  style={
                    hoveredIdx > chartCycles.length * 0.54
                      ? { left: 66, maxWidth: 270 }
                      : { right: 56, maxWidth: 270 }
                  }
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 2 }}>
                    <span className="dsh-usage-dot" style={{ background: providerAccentColor(hoveredCycle.provider) }} />
                    <span>{providerDisplayName(hoveredCycle.provider)}</span>
                    <span style={{ opacity: 0.6, fontWeight: 400 }}>·</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                      {accountText}
                    </span>
                  </div>
                  <div style={{ opacity: 0.8, marginBottom: 4 }}>
                    {label} · {badge.text}
                  </div>
                  <div style={{ opacity: 0.72, marginBottom: 6 }}>{range}</div>
                  <div className="dsh-usage-tooltip-row" style={{ fontWeight: 600 }}>
                    <span>{t('usageCycleTokensLabel')}</span>
                    <span>{formatCompactTokens(hoveredCycle.totalTokens)}</span>
                  </div>
                  <div className="dsh-usage-tooltip-row" style={{ fontWeight: 600, marginBottom: 4 }}>
                    <span>{t('usageCycleQuotaLabel')}</span>
                    <span style={{ color: pct !== undefined ? toneStrokeColor(quotaProgressTone(pct)) : undefined }}>
                      {pct !== undefined
                        ? `${t('usageCycleQuotaUsed', { percent: pct })}${peakPct !== undefined && peakPct > pct ? ` (${t('usageCycleQuotaPeak', { percent: peakPct })})` : ''}`
                        : t('usageCycleQuotaNa')}
                    </span>
                  </div>
                  <div style={{ opacity: 0.78, marginBottom: hoveredCycle.models.length > 0 ? 4 : 0 }}>
                    {t('usageKpiInputShort')} {formatCompactTokens(hoveredCycle.inputTokens)}
                    {' · '}{t('usageKpiOutputShort')} {formatCompactTokens(hoveredCycle.outputTokens)}
                    {' · '}{t('usageKpiCacheReadShort')} {formatCompactTokens(hoveredCycle.cacheReadTokens)}
                  </div>
                  {hoveredCycle.models.slice(0, 2).map(m => (
                    <div key={m.model} className="dsh-usage-tooltip-row" style={{ opacity: 0.85 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.model}</span>
                      <span>{formatCompactTokens(m.totalTokens)} ({formatPercent(m.share)})</span>
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>

          {/* Click-to-Pin Inline Cycle Inspector Strip */}
          {selectedCycle !== undefined ? (() => {
            const label = kindLabel(t, selectedCycle.scope === undefined ? { kind: selectedCycle.kind } : { kind: selectedCycle.kind, scope: selectedCycle.scope })
            const accountText = selectedCycle.loggedIn
              ? selectedCycle.accountLabel ?? selectedCycle.account
              : t('usageAccountLoggedOut', { account: selectedCycle.accountLabel ?? selectedCycle.account })
            const badge = statusBadge(selectedCycle, now, t)
            const cycleRange = formatCycleTimeRange(t, {
              ...selectedCycle.startsAt === undefined ? {} : { startsAt: selectedCycle.startsAt },
              countedFrom: selectedCycle.countedFrom,
              ...selectedCycle.endsAt === undefined ? {} : { endsAt: selectedCycle.endsAt },
            })
            const hasQuota = selectedCycle.quotaUsedPercent !== undefined && Number.isFinite(selectedCycle.quotaUsedPercent)
            const usedPct = hasQuota ? clampPercent(selectedCycle.quotaUsedPercent as number) : undefined
            const peakPct = selectedCycle.quotaPeakPercent !== undefined && Number.isFinite(selectedCycle.quotaPeakPercent)
              ? clampPercent(selectedCycle.quotaPeakPercent)
              : undefined
            const showPeak = usedPct !== undefined && peakPct !== undefined && peakPct > usedPct
            const tone = usedPct !== undefined ? quotaProgressTone(usedPct) : 'na'

            return (
              <aside className="dsh-usage-cycle-inspector" aria-live="polite">
                <div className="dsh-usage-window-top">
                  <span className="dsh-usage-window-id">
                    <span className="dsh-usage-dot" style={{ background: providerAccentColor(selectedCycle.provider) }} />
                    <span className="dsh-usage-window-provider">{providerDisplayName(selectedCycle.provider)}</span>
                    <span className="dsh-usage-window-sep" aria-hidden="true">·</span>
                    <span className="dsh-usage-window-account" title={accountText}>{accountText}</span>
                  </span>
                  <div className="dsh-usage-window-meta">
                    <span className="dsh-usage-badge" title={label}>{label}</span>
                    <span className={badge.className}>{badge.text}</span>
                    <span className="dsh-usage-dist-sub">{cycleRange}</span>
                    <button
                      type="button"
                      className="dsh-usage-btn dsh-usage-btn-quiet"
                      style={{ minHeight: 24, padding: '0 8px' }}
                      onClick={() => setSelectedId(undefined)}
                    >
                      {t('usageCyclesClearSelection')}
                    </button>
                  </div>
                </div>

                <div className="dsh-usage-cycle-inspector-grid">
                  <div className="dsh-usage-cycle-inspector-col">
                    <div className="dsh-usage-cycle-metrics">
                      <div>
                        <div className="dsh-usage-cycle-metric-label">{t('usageCycleTokensLabel')}</div>
                        <span
                          className="dsh-usage-window-total"
                          title={t('usageTokens', { count: formatTokens(selectedCycle.totalTokens) })}
                        >
                          {formatCompactTokens(selectedCycle.totalTokens)}
                        </span>
                      </div>
                      <div className="dsh-usage-cycle-quota-col">
                        <div className="dsh-usage-cycle-metric-label">{t('usageCycleQuotaLabel')}</div>
                        <span className="dsh-usage-cycle-quota-val" data-tone={tone}>
                          {usedPct !== undefined
                            ? t('usageCycleQuotaUsed', { percent: usedPct })
                            : t('usageCycleQuotaNa')}
                        </span>
                        {showPeak && (
                          <span className="dsh-usage-dist-sub">
                            {t('usageCycleQuotaPeak', { percent: peakPct })}
                          </span>
                        )}
                      </div>
                    </div>

                    <div
                      className="dsh-usage-quota-track"
                      data-na={usedPct === undefined ? 'true' : 'false'}
                      role={usedPct !== undefined ? 'progressbar' : undefined}
                      aria-valuenow={usedPct}
                      aria-valuemin={usedPct !== undefined ? 0 : undefined}
                      aria-valuemax={usedPct !== undefined ? 100 : undefined}
                      aria-label={usedPct !== undefined ? t('usageCycleQuotaUsed', { percent: usedPct }) : t('usageCycleQuotaNa')}
                    >
                      {usedPct !== undefined && (
                        <div className="dsh-usage-quota-fill" data-tone={tone} style={{ width: `${usedPct}%` }} />
                      )}
                      {showPeak && peakPct !== undefined && (
                        <div
                          className="dsh-usage-quota-peak-mark"
                          style={{ left: `calc(${peakPct}% - 1px)` }}
                          title={t('usageCycleQuotaPeak', { percent: peakPct })}
                        />
                      )}
                    </div>

                    <div className="dsh-usage-dist-sub">
                      {t('usageKpiInputShort')} {formatCompactTokens(selectedCycle.inputTokens)}
                      {' · '}{t('usageKpiOutputShort')} {formatCompactTokens(selectedCycle.outputTokens)}
                      {' · '}{t('usageKpiCacheReadShort')} {formatCompactTokens(selectedCycle.cacheReadTokens)}
                      {selectedCycle.cacheWriteTokens > 0 && ` · ${t('usageKpiCacheWriteShort')} ${formatCompactTokens(selectedCycle.cacheWriteTokens)}`}
                      {selectedCycle.reasoningTokens > 0 && ` · ${t('usageKpiReasoning', { count: formatCompactTokens(selectedCycle.reasoningTokens) })}`}
                    </div>
                  </div>

                  <div className="dsh-usage-cycle-inspector-col">
                    {selectedCycle.models.length > 0 && (
                      <div className="dsh-usage-window-models">
                        {selectedCycle.models.slice(0, 5).map(entry => (
                          <span key={entry.model} className="dsh-usage-model-chip" title={formatTokens(entry.totalTokens)}>
                            <span>{entry.model}</span>
                            <strong>{formatCompactTokens(entry.totalTokens)}</strong>
                            {entry.share > 0 && <span>({formatPercent(entry.share)})</span>}
                          </span>
                        ))}
                        {selectedCycle.models.length > 5 && (
                          <span className="dsh-usage-model-chip">+{selectedCycle.models.length - 5}</span>
                        )}
                      </div>
                    )}
                    {selectedCycle.markers.length > 0 && (
                      <ul className="dsh-usage-markers">
                        {selectedCycle.markers.map(marker => (
                          <li key={marker}>{t(MARKER_KEYS[marker])}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </aside>
            )
          })() : (
            <p className="dsh-usage-card-subtitle" style={{ margin: 0 }}>
              {t('usageCyclesInspectorHint')}
            </p>
          )}
        </>
      )}
    </section>
  )
}
