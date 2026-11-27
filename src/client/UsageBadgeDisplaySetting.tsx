import { useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { hostIcon } from './host-icons.js'
import { SettingHelp } from './SettingHelp.js'
import type { SubscriptionsKey } from './locales.js'
import { setUsageBadgeMode, useUsageBadgeMode, setQuotaDisplayMode, useQuotaDisplayMode, setUsageBadgeStyle, useUsageBadgeStyle, setBudgetTargetLine, useBudgetTargetLine } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

function SelectChevron() {
  return (
    <svg
      aria-hidden="true"
      className="dsh-subscription-select-chevron"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  )
}

/** Browser-local display preference; never changes provider or account settings. */
export function UsageBadgeDisplaySetting({ t }: { t: Translate }) {
  const mode = useUsageBadgeMode()
  const quotaMode = useQuotaDisplayMode()
  const styleMode = useUsageBadgeStyle()
  const budgetTargetEnabled = useBudgetTargetLine()
  const [failed, setFailed] = useState(false)
  const badgeId = useId()
  const quotaId = useId()
  const styleId = useId()
  const [styleOpen, setStyleOpen] = useState(false)
  const Chevron = hostIcon(primitives, "ChevronDownOutline")
  const styleAnchor = (<Button id={styleId} variant="outline" style={{ width: '100%', justifyContent: 'space-between' }}
            className="dsh-subscription-native-control" aria-label={t('usageBadgeStyle')}
            aria-haspopup="menu" aria-expanded={styleOpen} onClick={() => setStyleOpen(value => !value)}>
            {t(styleMode === 'compact' ? 'usageBadgeStyleCompact' : 'usageBadgeStyleText')}<Chevron />
          </Button>)
  return (
    <div className="dsh-subscription-settings-card" style={styles.card}>
      <div style={styles.field}>
        <div style={styles.labelRow}>
          <label htmlFor={badgeId}>{t('usageBadgeDisplay')}</label>
          <SettingHelp title={t('usageBadgeDisplay')} hint={t('usageBadgeDisplayHint')} t={t} />
        </div>
        <div className="dsh-subscription-select-wrap">
          <select
            id={badgeId}
            className="dsh-subscription-select"
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
          <SelectChevron />
        </div>
      </div>
      <div style={styles.field}>
        <div style={styles.labelRow}>
          <label htmlFor={styleId}>{t('usageBadgeStyle')}</label>
          <SettingHelp title={t('usageBadgeStyle')} hint={t('usageBadgeStyleHint')} t={t} />
        </div>
        {typeof document === 'undefined' ? styleAnchor : <Menu open={styleOpen} onClose={() => setStyleOpen(false)}
          items={[
            { id: 'compact', label: t('usageBadgeStyleCompact') },
            { id: 'text', label: t('usageBadgeStyleText') },
          ]}
          selectedId={styleMode} portal minWidthFromAnchor
          onSelect={value => {
            setStyleOpen(false)
            if (value !== 'compact' && value !== 'text') return
            try {
              setUsageBadgeStyle(value)
              setFailed(false)
            } catch (error) {
              if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
              setFailed(true)
            }
          }}
          anchor={styleAnchor}
        />}
      </div>
      <div style={styles.switchRow}>
        <div style={styles.labelRow}><span style={styles.switchLabel}>{t('budgetTargetTitle')}</span><SettingHelp title={t('budgetTargetTitle')} hint={t('budgetTargetHint')} t={t} /></div>
        <Switch checked={budgetTargetEnabled} label={t('budgetTargetTitle')}
          className="dsh-subscription-native-control" title={t(budgetTargetEnabled ? 'budgetTargetOn' : 'budgetTargetOff')}
          onChange={next => {
            try {
              setBudgetTargetLine(next)
              setFailed(false)
            } catch (error) {
              if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
              setFailed(true)
            }
          }}
        />
      </div>
      <div style={styles.field}>
        <div style={styles.labelRow}>
          <label htmlFor={quotaId}>{t('quotaDisplay')}</label>
          <SettingHelp title={t('quotaDisplay')} hint={t('quotaDisplayHint')} t={t} />
        </div>
        <div className="dsh-subscription-select-wrap">
          <select
            id={quotaId}
            className="dsh-subscription-select"
            style={styles.select}
            aria-label={t('quotaDisplay')}
            value={quotaMode}
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
            }}
          >
            <option value="used">{t('quotaUsed')}</option>
            <option value="remaining">{t('quotaRemaining')}</option>
          </select>
          <SelectChevron />
        </div>
      </div>
      {failed && <p role="alert" style={{ ...styles.hint, color: 'var(--dsw-alias-state-error-primary)' }}>{t('usageBadgeDisplaySaveFailed')}</p>}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: '0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))',
    borderRadius: 'var(--dsw-radius-xl, 20px)', background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))',
    padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 500, lineHeight: '20px' },
  labelRow: { display: 'flex', alignItems: 'center', gap: 4 },
  select: { width: '100%' },
  switchRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 30 },
  switchLabel: { fontSize: 13, fontWeight: 500, lineHeight: '20px' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}
