import { ANTIGRAVITY_QUOTA_SCOPES, antigravityQuotaScope } from '../antigravity-model-id.js'
import type { SubscriptionsKey } from './locales.js'
import type { UsageWindow } from './SubscriptionsSection.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

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
            return <div key={`${window.kind}-${index}`} style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'start', gap: 16 }}>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{label}</span>
              <div style={{ textAlign: 'right', fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 7 }}>
                  <span>{t('usageRemaining', { percent: remaining })}</span>
                  <span role="progressbar" aria-label={`${title} · ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}>
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" style={{ display: 'block', transform: 'rotate(-90deg)' }}>
                      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--dsw-alias-border-l2)" strokeWidth="2" />
                      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--dsw-alias-state-success-primary)" strokeWidth="2" pathLength="100" strokeDasharray={`${remaining} 100`} />
                    </svg>
                  </span>
                </div>
                {window.resetsAt !== undefined && <div style={{ marginTop: 4, color: 'var(--dsw-alias-label-tertiary)' }}>
                  {t('usageResetsIn', { time: resetDuration(window.resetsAt) })}
                </div>}
              </div>
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
          <span role="progressbar" aria-label={`${window.scope ?? ''} · ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}>
            {t('usageRemaining', { percent: remaining })}
          </span>
        </div>
        {window.resetsAt !== undefined && <div style={{ marginTop: 4, textAlign: 'right', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          {t('usageResetsIn', { time: resetDuration(window.resetsAt) })}
        </div>}
      </section>
    })}
  </div>
}
