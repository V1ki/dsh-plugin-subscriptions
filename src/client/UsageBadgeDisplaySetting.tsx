import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { SubscriptionsKey } from './locales.js'
import { setUsageBadgeMode, useUsageBadgeMode } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Browser-local display preference; never changes provider or account settings. */
export function UsageBadgeDisplaySetting({ t }: { t: Translate }) {
  const mode = useUsageBadgeMode()
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
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}
