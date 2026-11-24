import { useMemo, useState } from 'react'
import type { TrackedProvider } from '../usage/usage-schema.js'
import type { DashboardDailyBucket } from '../usage/usage-dashboard.js'
import {
  buildHeatmapWeeks,
  formatCompactTokens,
  formatTokens,
  providerAccentColor,
  providerDisplayName,
  type Translate,
} from './usage-format.js'

interface Props {
  days: readonly DashboardDailyBucket[]
  selectedDate?: string
  onSelectDate: (date?: string) => void
  t: Translate
}

const WEEKDAY_LABELS: readonly string[] = ['', 'Mon', '', 'Wed', '', 'Fri', '']

export function UsageHeatmap({ days, selectedDate, onSelectDate, t }: Props) {
  const [hoveredDate, setHoveredDate] = useState<string | undefined>(undefined)

  const grid = useMemo(() => buildHeatmapWeeks(days), [days])

  const byDate = useMemo(() => {
    const map = new Map<string, DashboardDailyBucket>()
    for (const day of days) map.set(day.date, day)
    return map
  }, [days])

  const stats = useMemo(() => {
    let activeDays = 0
    let sum = 0
    let peak: DashboardDailyBucket | undefined
    for (const day of days) {
      if (day.totalTokens > 0) {
        activeDays += 1
        sum += day.totalTokens
        if (!peak || day.totalTokens > peak.totalTokens) peak = day
      }
    }
    return { activeDays, avgPerActiveDay: activeDays > 0 ? Math.round(sum / activeDays) : 0, peak }
  }, [days])

  const inspectedDate = selectedDate ?? hoveredDate
  const inspected = inspectedDate !== undefined ? byDate.get(inspectedDate) : undefined

  const monthByCol = useMemo(() => {
    const map = new Map<number, string>()
    for (const entry of grid.monthLabels) map.set(entry.col, entry.label)
    return map
  }, [grid.monthLabels])

  return (
    <section className="dsh-usage-card" aria-label={t('usageHeatmapTitle')}>
      <div className="dsh-usage-card-header">
        <div>
          <h2 className="dsh-usage-card-title">{t('usageHeatmapTitle')}</h2>
          <p className="dsh-usage-card-subtitle">{t('usageHeatmapSubtitle')}</p>
        </div>
        <div className="dsh-usage-heat-legend" aria-hidden="true">
          <span>{t('usageHeatmapLess')}</span>
          {([0, 1, 2, 3, 4] as const).map(level => (
            <span
              key={level}
              className="dsh-usage-heat-swatch"
              style={{ background: `var(--dsh-heat-${level})` }}
            />
          ))}
          <span>{t('usageHeatmapMore')}</span>
        </div>
      </div>

      <div className="dsh-usage-heatmap-body">
        <div className="dsh-usage-heatmap-scroll">
          <div className="dsh-usage-heatmap-inner">
            <div
              className="dsh-usage-heatmap-months"
              style={{ gridTemplateColumns: `repeat(${grid.weeks.length}, 14px)` }}
              aria-hidden="true"
            >
              {grid.weeks.map((_, col) => (
                <span key={col} className="dsh-usage-heatmap-month-label">
                  {monthByCol.get(col) ?? ''}
                </span>
              ))}
            </div>
            <div className="dsh-usage-heatmap-matrix">
              <div className="dsh-usage-heatmap-weekdays" aria-hidden="true">
                {WEEKDAY_LABELS.map((label, idx) => (
                  <span key={idx}>{label}</span>
                ))}
              </div>
              <div className="dsh-usage-heatmap-weeks" role="grid" aria-label={t('usageHeatmapTitle')}>
                {grid.weeks.map((week, col) => (
                  <div key={col} className="dsh-usage-heatmap-col" role="row">
                    {week.map((cell, row) => {
                      if (cell.date === undefined || cell.bucket === undefined) {
                        return (
                          <span
                            key={row}
                            className="dsh-usage-heat-cell"
                            data-empty="true"
                            aria-hidden="true"
                          />
                        )
                      }
                      const date = cell.date
                      const total = cell.bucket.totalTokens
                      const isSelected = selectedDate === date
                      const label = total > 0
                        ? `${date}: ${t('usageTokens', { count: formatTokens(total) })}`
                        : `${date}: ${t('usageHeatmapEmptyDay')}`
                      return (
                        <button
                          key={date}
                          type="button"
                          className="dsh-usage-heat-cell"
                          data-level={cell.level}
                          aria-label={label}
                          aria-pressed={isSelected}
                          title={label}
                          onMouseEnter={() => setHoveredDate(date)}
                          onMouseLeave={() => setHoveredDate(current => (current === date ? undefined : current))}
                          onFocus={() => setHoveredDate(date)}
                          onBlur={() => setHoveredDate(current => (current === date ? undefined : current))}
                          onClick={() => onSelectDate(isSelected ? undefined : date)}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <aside className="dsh-usage-day-inspector" aria-live="polite">
          {inspected !== undefined ? (
            <>
              <div className="dsh-usage-day-inspector-head">
                <strong style={{ fontSize: 13 }}>
                  <time dateTime={inspected.date}>{t('usageHeatmapSelectedDay', { date: inspected.date })}</time>
                </strong>
                {selectedDate !== undefined && (
                  <button
                    type="button"
                    className="dsh-usage-btn dsh-usage-btn-quiet"
                    style={{ minHeight: 24, padding: '0 8px' }}
                    onClick={() => onSelectDate(undefined)}
                  >
                    {t('usageHeatmapClearDay')}
                  </button>
                )}
              </div>

              {inspected.totalTokens === 0 ? (
                <p className="dsh-usage-card-subtitle" style={{ margin: 0 }}>{t('usageHeatmapEmptyDay')}</p>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {formatCompactTokens(inspected.totalTokens)}
                    </span>
                    <span className="dsh-usage-card-subtitle" style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {t('usageTokens', { count: formatTokens(inspected.totalTokens) })}
                    </span>
                  </div>
                  <div className="dsh-usage-kpi-sub">
                    <span>{t('usageKpiInputShort')} {formatCompactTokens(inspected.inputTokens)}</span>
                    <span>{t('usageKpiOutputShort')} {formatCompactTokens(inspected.outputTokens)}</span>
                    <span>{t('usageKpiCacheReadShort')} {formatCompactTokens(inspected.cacheReadTokens)}</span>
                    <span>{t('usageKpiCacheWriteShort')} {formatCompactTokens(inspected.cacheWriteTokens)}</span>
                    {inspected.reasoningTokens > 0 && (
                      <span>{t('usageKpiReasoning', { count: formatCompactTokens(inspected.reasoningTokens) })}</span>
                    )}
                  </div>
                  {Object.keys(inspected.byProvider).length > 0 && (
                    <div className="dsh-usage-window-models">
                      {(Object.entries(inspected.byProvider) as [TrackedProvider, number][])
                        .filter(([, value]) => value > 0)
                        .sort((a, b) => b[1] - a[1])
                        .map(([provider, value]) => (
                          <span key={provider} className="dsh-usage-badge">
                            <span className="dsh-usage-dot" style={{ background: providerAccentColor(provider) }} />
                            {providerDisplayName(provider)} · {formatCompactTokens(value)}
                          </span>
                        ))}
                    </div>
                  )}
                  {inspected.byModel.length > 0 && (
                    <ul className="dsh-usage-day-models">
                      {inspected.byModel.slice(0, 6).map(entry => (
                        <li key={`${entry.provider}:${entry.model}`} className="dsh-usage-day-model-row">
                          <span className="dsh-usage-day-model-name">
                            <span className="dsh-usage-dot" style={{ background: providerAccentColor(entry.provider) }} />
                            <span>{entry.model}</span>
                          </span>
                          <span className="dsh-usage-day-model-val" title={formatTokens(entry.totalTokens)}>
                            {formatCompactTokens(entry.totalTokens)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                <div>
                  <div className="dsh-usage-kpi-label">{t('usageHeatmapActiveDays')}</div>
                  <div style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
                    {stats.activeDays}
                  </div>
                </div>
                <div>
                  <div className="dsh-usage-kpi-label">{t('usageHeatmapAvgDay')}</div>
                  <div style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
                    {formatCompactTokens(stats.avgPerActiveDay)}
                  </div>
                </div>
                <div>
                  <div className="dsh-usage-kpi-label">{t('usageHeatmapPeakDay')}</div>
                  <div style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
                    {stats.peak ? formatCompactTokens(stats.peak.totalTokens) : '—'}
                  </div>
                  {stats.peak && (
                    <div className="dsh-usage-dist-sub">{stats.peak.date}</div>
                  )}
                </div>
              </div>
              <p className="dsh-usage-card-subtitle" style={{ margin: 0 }}>{t('usageHeatmapHint')}</p>
            </>
          )}
        </aside>
      </div>
    </section>
  )
}
