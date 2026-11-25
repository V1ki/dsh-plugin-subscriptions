import { useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { SettingHelp } from './SettingHelp.js'
import type { SubscriptionsKey } from './locales.js'
import { setUsageBadgeMode, useUsageBadgeMode, setQuotaDisplayMode, useQuotaDisplayMode } from './usage-badge-preferences.js'
import { setComposerDisplay, useComposerDisplay } from './composer-display-preferences.js'

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

type Option = readonly [value: string, label: SubscriptionsKey]

function DisplayField({ t, label, hint, value, options, onChange }: {
  t: Translate; label: SubscriptionsKey; hint: SubscriptionsKey; value: string
  options: readonly Option[]; onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div style={styles.field}>
      <div style={styles.labelRow}>
        <label htmlFor={id}>{t(label)}</label>
        <SettingHelp title={t(label)} hint={t(hint)} t={t} />
      </div>
      <div className="dsh-subscription-select-wrap">
        <select id={id} className="dsh-subscription-select" style={styles.select} value={value}
          onChange={event => onChange(event.currentTarget.value)}>
          {options.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
        </select>
        <SelectChevron />
      </div>
    </div>
  )
}

/** Browser-local display preferences, grouped by where they take effect. */
export function UsageBadgeDisplaySetting({ t }: { t: Translate }) {
  const mode = useUsageBadgeMode()
  const quota = useQuotaDisplayMode()
  const slider = useComposerDisplay('slider')
  const picker = useComposerDisplay('picker')
  const [failed, setFailed] = useState(false)
  const save = (write: () => void) => {
    try {
      write()
      setFailed(false)
    } catch (error) {
      if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
      setFailed(true)
    }
  }
  const visibility = [['shown', 'composerDisplayShown'], ['hidden', 'composerDisplayHidden']] as const
  return (
    <div className="dsh-subscription-settings-card" style={styles.card}>
      <div style={styles.row}>
        <DisplayField t={t} label="usageBadgeDisplay" hint="usageBadgeDisplayHint" value={mode}
          options={[[ 'recent', 'usageBadgeDisplayRecent' ], [ 'hidden', 'usageBadgeDisplayHidden' ]]}
          onChange={value => { if (value === 'recent' || value === 'hidden') save(() => setUsageBadgeMode(value)) }} />
        <DisplayField t={t} label="quotaDisplay" hint="quotaDisplayHint" value={quota}
          options={[[ 'used', 'quotaUsed' ], [ 'remaining', 'quotaRemaining' ]]}
          onChange={value => { if (value === 'used' || value === 'remaining') save(() => setQuotaDisplayMode(value)) }} />
      </div>
      <div style={styles.row}>
        <DisplayField t={t} label="composerSliderDisplay" hint="composerSliderDisplayHint" value={slider} options={visibility}
          onChange={value => { if (value === 'shown' || value === 'hidden') save(() => setComposerDisplay('slider', value)) }} />
        <DisplayField t={t} label="composerPickerDisplay" hint="composerPickerDisplayHint" value={picker} options={visibility}
          onChange={value => { if (value === 'shown' || value === 'hidden') save(() => setComposerDisplay('picker', value)) }} />
      </div>
      {failed && <p role="alert" style={{ ...styles.hint, color: 'var(--dsw-alias-state-error-primary)' }}>{t('usageBadgeDisplaySaveFailed')}</p>}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: '0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))',
    borderRadius: 'var(--dsw-radius-xl, 20px)', background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))',
    padding: '14px 16px', display: 'grid', gap: 12,
  },
  row: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 130px), 1fr))', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 6, fontSize: 13, fontWeight: 500, lineHeight: '20px' },
  labelRow: { display: 'flex', alignItems: 'center', gap: 4, minHeight: 40 },
  select: { width: '100%' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}
