import { useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { SettingHelp } from './SettingHelp.js'
import type { SubscriptionsKey } from './locales.js'
import { setUsageBadgeMode, useUsageBadgeMode, setQuotaDisplayMode, useQuotaDisplayMode } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Browser-local display preference; never changes provider or account settings. */
export function UsageBadgeDisplaySetting({ t }: { t: Translate }) {
  const mode = useUsageBadgeMode()
  const quotaMode = useQuotaDisplayMode()
  const [failed, setFailed] = useState(false)
  const badgeId = useId()
  const quotaId = useId()
  return (
    <div style={styles.card}>
      <div style={styles.field}>
        <div style={styles.labelRow}>
          <label htmlFor={badgeId}>{t('usageBadgeDisplay')}</label>
          <SettingHelp title={t('usageBadgeDisplay')} hint={t('usageBadgeDisplayHint')} t={t} />
        </div>
        <select id={badgeId}
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
      </div>
      <div style={styles.field}>
        <div style={styles.labelRow}>
          <label htmlFor={quotaId}>{t('quotaDisplay')}</label>
          <SettingHelp title={t('quotaDisplay')} hint={t('quotaDisplayHint')} t={t} />
        </div>
        <select id={quotaId} style={styles.select} aria-label={t('quotaDisplay')} value={quotaMode}
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
      </div>
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
  labelRow: { display: 'flex', alignItems: 'center', gap: 4 },
  select: { width: '100%' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}
