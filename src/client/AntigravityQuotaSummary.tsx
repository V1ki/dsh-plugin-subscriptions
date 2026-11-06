import { ANTIGRAVITY_QUOTA_SCOPES, antigravityQuotaScope } from '../antigravity-model-id.js'
import type { SubscriptionsKey } from './locales.js'
import type { UsageWindow } from './SubscriptionsSection.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Same 4px track as the other subscription rows; this fill represents remaining quota. */
function RemainingBar({ label, remaining }: { label: string; remaining: number }) {
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}
    style={{ height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--dsw-alias-border-l2)', marginBottom: 2 }}>
    <div style={{ width: `${remaining}%`, height: '100%', borderRadius: 2, background: 'var(--dsw-alias-state-success-primary)' }} />
  </div>
}

function resetDuration(at: number): string {
  const minutes = Math.max(1, Math.ceil((at - Date.now()) / 60000))
  const hours = Math.floor(minutes / 60)
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** Provider-defined shared limits, displayed as remaining allowance like Antigravity. */
export function AntigravityQuotaSummary({ windows, t }: { windows: readonly UsageWindow[]; t: Translate }) {
  const titles = ['usageGeminiModels', 'usageClaudeGptModels', 'usageArgon'] as const
  return <div style={{ display: 'grid', gap: 22, paddingTop: 10 }}>
    {ANTIGRAVITY_QUOTA_SCOPES.map((scope, index) => {
      const rows = windows.filter(window => window.scope === scope)
        .sort((a, b) => (a.kind === 'weekly' ? 0 : 1) - (b.kind === 'weekly' ? 0 : 1))
      if (!rows.length) return null
      const title = t(titles[index])
      return <section key={scope} aria-label={title}>
        <h4 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600 }}>{title}</h4>
        <div style={{ display: 'grid', gap: 14 }}>
          {rows.map((window, index) => {
            const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))
            const label = t(window.kind === 'weekly' ? 'usageWeeklyLimit' : 'usageFiveHourLimit')
            return <div key={`${window.kind}-${index}`} style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, fontSize: 12 }}>
                <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{label}</span>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {t('usageRemaining', { percent: remaining })}
                  {window.resetsAt !== undefined && <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
                    {` · ${resetDuration(window.resetsAt)}`}
                  </span>}
                </span>
              </div>
              <RemainingBar label={`${title} · ${label}`} remaining={remaining} />
            </div>
          })}
        </div>
      </section>
    })}
    {windows.filter(window => !antigravityQuotaScope(window.scope)).map((window, index) => {
      const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))
      const label = t(window.kind === 'weekly' ? 'usageWeeklyLimit'
        : window.kind === 'session' ? 'usageFiveHourLimit' : 'usageWindow')
      return <section key={`model-${index}`} aria-label={`${window.scope ?? ''} · ${label}`}>
        <h4 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600 }}>{window.scope}</h4>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
          <span>{label}</span>
          <span>{t('usageRemaining', { percent: remaining })}</span>
        </div>
        <div style={{ marginTop: 4 }}><RemainingBar label={`${window.scope ?? ''} · ${label}`} remaining={remaining} /></div>
        {window.resetsAt !== undefined && <div style={{ marginTop: 4, textAlign: 'right', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          {t('usageResetsIn', { time: resetDuration(window.resetsAt) })}
        </div>}
      </section>
    })}
  </div>
}
