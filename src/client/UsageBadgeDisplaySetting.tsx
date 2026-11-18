import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { SubscriptionsKey } from './locales.js'
import { setUsageBadgeMode, useUsageBadgeMode, setQuotaDisplayMode, useQuotaDisplayMode, setUsageBadgeStyle, useUsageBadgeStyle, setBudgetTargetLine, useBudgetTargetLine } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Browser-local display preference; never changes provider or account settings. */
export function UsageBadgeDisplaySetting({ t }: { t: Translate }) {
  const mode = useUsageBadgeMode()
  const quotaMode = useQuotaDisplayMode()
  const styleMode = useUsageBadgeStyle()
  const budgetTargetEnabled = useBudgetTargetLine()
  const [failed, setFailed] = useState(false)
  return (
    <div style={styles.card}>
      <label style={styles.field}>
        <span>{t('usageBadgeDisplay')}</span>
        <select
          style={styles.select}
          aria-label={t('usageBadgeDisplay')}
          value={mode}
          onChange={event => {
            const value = event.currentTarget.value
            if (value !== 'recent' && value !== 'hidden') return
            try {
              setUsageBadgeMode(value)
              setFailed(false)
            } catch (error) {
              if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
              setFailed(true)
            }
          }}
        >
          <option value="recent">{t('usageBadgeDisplayRecent')}</option>
          <option value="hidden">{t('usageBadgeDisplayHidden')}</option>
        </select>
      </label>
      <p style={styles.hint}>{t('usageBadgeDisplayHint')}</p>
      <label style={styles.field}>
        <span>{t('usageBadgeStyle')}</span>
        <select style={styles.select} aria-label={t('usageBadgeStyle')} value={styleMode}
          onChange={event => {
            const value = event.currentTarget.value
            if (value !== 'compact' && value !== 'text') return
            try {
              setUsageBadgeStyle(value)
              setFailed(false)
            } catch (error) {
              if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
              setFailed(true)
            }
          }}>
          <option value="compact">{t('usageBadgeStyleCompact')}</option>
          <option value="text">{t('usageBadgeStyleText')}</option>
        </select>
      </label>
      <p style={styles.hint}>{t('usageBadgeStyleHint')}</p>
      <div style={styles.switchRow}>
        <span style={styles.switchLabel}>{t('budgetTargetTitle')}</span>
        <button
          type="button"
          role="switch"
          className="dsh-subscription-budget-switch"
          data-subscription-budget-switch="true"
          aria-label={t('budgetTargetTitle')}
          aria-checked={budgetTargetEnabled}
          title={t(budgetTargetEnabled ? 'budgetTargetOn' : 'budgetTargetOff')}
          style={{ ...styles.switchTrack, ...(budgetTargetEnabled ? styles.switchTrackOn : {}) }}
          onClick={() => {
            try {
              setBudgetTargetLine(!budgetTargetEnabled)
              setFailed(false)
            } catch (error) {
              if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
              setFailed(true)
            }
          }}
        >
          <span aria-hidden="true" style={{ ...styles.switchThumb, ...(budgetTargetEnabled ? styles.switchThumbOn : {}) }} />
        </button>
      </div>
      <p style={styles.hint}>{t('budgetTargetHint')}</p>
      <label style={styles.field}>
        <span>{t('quotaDisplay')}</span>
        <select style={styles.select} aria-label={t('quotaDisplay')} value={quotaMode}
          onChange={event => {
            const value = event.currentTarget.value
            if (value !== 'used' && value !== 'remaining') return
            try {
              setQuotaDisplayMode(value)
              setFailed(false)
            } catch (error) {
              if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
              setFailed(true)
            }
          }}>
          <option value="used">{t('quotaUsed')}</option>
          <option value="remaining">{t('quotaRemaining')}</option>
        </select>
      </label>
      <p style={styles.hint}>{t('quotaDisplayHint')}</p>
      {failed && <p role="alert" style={{ ...styles.hint, color: 'var(--dsw-alias-state-error-primary)' }}>{t('usageBadgeDisplaySaveFailed')}</p>}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: '0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))',
    borderRadius: 'var(--dsw-radius-xl, 20px)', background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))',
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 500, lineHeight: '20px' },
  select: { width: '100%' },
  switchRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 30 },
  switchLabel: { fontSize: 13, fontWeight: 500, lineHeight: '20px' },
  switchTrack: {
    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
    boxSizing: 'border-box', width: 42, height: 24, padding: 3, border: 'none',
    borderRadius: 999, background: 'var(--dsw-alias-border-l2, #777)',
    cursor: 'pointer', transition: 'background-color 150ms ease',
  },
  switchTrackOn: { background: 'var(--dsw-alias-state-success-primary, #22c55e)' },
  switchThumb: {
    display: 'block', width: 18, height: 18, borderRadius: '50%',
    background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
    transform: 'translateX(0px)', transition: 'transform 150ms ease',
    pointerEvents: 'none',
  },
  switchThumbOn: { transform: 'translateX(18px)' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}
