import { useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { hostIcon } from './host-icons.js'
import { SettingHelp } from './SettingHelp.js'
import type { SubscriptionsKey } from './locales.js'
import { setUsageBadgeMode, useUsageBadgeMode, setQuotaDisplayMode, useQuotaDisplayMode, setUsageBadgeStyle, useUsageBadgeStyle, setBudgetTargetLine, useBudgetTargetLine } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string
const Chevron = hostIcon(primitives, 'ChevronDownOutline')

function PreferenceMenu<Value extends string>({ title, hint, value, options, onChange, t }: {
  title: SubscriptionsKey
  hint: SubscriptionsKey
  value: Value
  options: readonly { id: Value; label: SubscriptionsKey }[]
  onChange: (value: Value) => void
  t: Translate
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.id === value)
  const anchor = (
    <Button id={id} variant="outline" style={{ width: '100%', justifyContent: 'space-between' }}
      className="dsh-subscription-native-control" aria-label={t(title)}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(previous => !previous)}>
      {selected && t(selected.label)}<Chevron />
    </Button>
  )
  return (
    <div style={styles.field}>
      <div style={styles.labelRow}>
        <label htmlFor={id}>{t(title)}</label>
        <SettingHelp title={t(title)} hint={t(hint)} t={t} />
      </div>
      {typeof document === 'undefined' ? anchor : <Menu
        open={open} onClose={() => setOpen(false)}
        items={options.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={value} portal minWidthFromAnchor
        onSelect={next => {
          setOpen(false)
          const option = options.find(candidate => candidate.id === next)
          if (option !== undefined) onChange(option.id)
        }}
        anchor={anchor}
      />}
    </div>
  )
}

/** Browser-local display preference; never changes provider or account settings. */
export function UsageBadgeDisplaySetting({ t }: { t: Translate }) {
  const mode = useUsageBadgeMode()
  const quotaMode = useQuotaDisplayMode()
  const styleMode = useUsageBadgeStyle()
  const budgetTargetEnabled = useBudgetTargetLine()
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
  return (
    <div className="dsh-subscription-settings-card" style={styles.card}>
      <PreferenceMenu title="usageBadgeDisplay" hint="usageBadgeDisplayHint" value={mode} t={t}
        options={[{ id: 'recent', label: 'usageBadgeDisplayRecent' }, { id: 'hidden', label: 'usageBadgeDisplayHidden' }]}
        onChange={value => save(() => setUsageBadgeMode(value))} />
      {mode !== 'hidden' && <>
        <PreferenceMenu title="usageBadgeStyle" hint="usageBadgeStyleHint" value={styleMode} t={t}
          options={[{ id: 'text', label: 'usageBadgeStyleText' }, { id: 'compact', label: 'usageBadgeStyleCompact' }]}
          onChange={value => save(() => setUsageBadgeStyle(value))} />
        {styleMode === 'compact' && <div style={styles.switchRow}>
          <div style={styles.labelRow}><span style={styles.switchLabel}>{t('budgetTargetTitle')}</span><SettingHelp title={t('budgetTargetTitle')} hint={t('budgetTargetHint')} t={t} /></div>
          <Switch checked={budgetTargetEnabled} label={t('budgetTargetTitle')}
            className="dsh-subscription-native-control" title={t(budgetTargetEnabled ? 'budgetTargetOn' : 'budgetTargetOff')}
            onChange={next => save(() => setBudgetTargetLine(next))} />
        </div>}
      </>}
      <PreferenceMenu title="quotaDisplay" hint="quotaDisplayHint" value={quotaMode} t={t}
        options={[{ id: 'used', label: 'quotaUsed' }, { id: 'remaining', label: 'quotaRemaining' }]}
        onChange={value => save(() => setQuotaDisplayMode(value))} />
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
  switchRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 30 },
  switchLabel: { fontSize: 13, fontWeight: 500, lineHeight: '20px' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}
