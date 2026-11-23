import { useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { en, type SubscriptionsKey } from './locales.js'
import { SubscriptionNavIcon } from './SubscriptionNavIcon.js'
import { SubscriptionsSection } from './SubscriptionsSection.js'
import { UsageDashboard } from './UsageDashboard.js'
import { UsageNavIcon } from './UsageNavIcon.js'
import { usageDashboardCss } from './usage-dashboard-styles.js'
import type { Translate } from './usage-format.js'

export type SubscriptionsPageTab = 'usage' | 'settings'

/** Injected dependencies of {@link SubscriptionsPage} (slot `main` inject). */
export interface SubscriptionsPageInjected {
  rpc: ConnectionHandle['rpc']
  t: Translate
}

export type SubscriptionsPageProps = Partial<SubscriptionsPageInjected> & {
  /** Initial active top tab (defaults to `'usage'`). */
  initialTab?: SubscriptionsPageTab
}

const TABS: readonly SubscriptionsPageTab[] = ['usage', 'settings']

function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function SettingsTabIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <circle cx="9" cy="7" r="2.2" fill="var(--dsw-alias-bg-base, currentColor)" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="15" cy="17" r="2.2" fill="var(--dsw-alias-bg-base, currentColor)" />
    </svg>
  )
}

/**
 * Unified Subscriptions sidebar page with accessible top tabs:
 * - **Usage** (default home): full cross-provider analytics dashboard
 * - **Settings**: OAuth account login, quota limits, account pool & proxy configuration
 */
export function SubscriptionsPage(props: SubscriptionsPageProps) {
  const { rpc, initialTab = 'usage' } = props
  const t = props.t ?? fallbackTranslate
  const [activeTab, setActiveTab] = useState<SubscriptionsPageTab>(initialTab)
  const [visitedSettings, setVisitedSettings] = useState(initialTab === 'settings')
  const [usageRefreshKey, setUsageRefreshKey] = useState(0)
  const tabIdPrefix = useId()
  const tabRefs = useRef<Partial<Record<SubscriptionsPageTab, HTMLButtonElement | null>>>({})

  const selectTab = (next: SubscriptionsPageTab) => {
    if (next === activeTab) return
    if (next === 'settings') {
      setVisitedSettings(true)
    } else if (activeTab === 'settings') {
      // Silently refresh usage when returning from Settings in case accounts changed.
      setUsageRefreshKey(k => k + 1)
    }
    setActiveTab(next)
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: SubscriptionsPageTab) => {
    const idx = TABS.indexOf(current)
    let nextIdx: number | undefined
    if (event.key === 'ArrowRight') nextIdx = (idx + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIdx = 0
    else if (event.key === 'End') nextIdx = TABS.length - 1
    if (nextIdx === undefined) return
    event.preventDefault()
    const nextTab = TABS[nextIdx]
    selectTab(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  return (
    <div className="dsh-subscriptions-page">
      <style>{usageDashboardCss}</style>
      <div className="dsh-subscriptions-page-inner">
        <header className="dsh-subscriptions-page-topbar">
          <div className="dsh-subscriptions-page-brand">
            <SubscriptionNavIcon size={18} active={true} />
            <span>{t('nav')}</span>
          </div>
          <div className="dsh-subscriptions-page-tabs" role="tablist" aria-label={t('nav')}>
            <button
              ref={el => { tabRefs.current.usage = el }}
              type="button"
              role="tab"
              id={`${tabIdPrefix}-tab-usage`}
              aria-selected={activeTab === 'usage'}
              aria-controls={`${tabIdPrefix}-panel-usage`}
              tabIndex={activeTab === 'usage' ? 0 : -1}
              className="dsh-subscriptions-page-tab"
              onClick={() => selectTab('usage')}
              onKeyDown={event => handleTabKeyDown(event, 'usage')}
            >
              <UsageNavIcon size={15} active={activeTab === 'usage'} />
              <span>{t('usageNav')}</span>
            </button>
            <button
              ref={el => { tabRefs.current.settings = el }}
              type="button"
              role="tab"
              id={`${tabIdPrefix}-tab-settings`}
              aria-selected={activeTab === 'settings'}
              aria-controls={`${tabIdPrefix}-panel-settings`}
              tabIndex={activeTab === 'settings' ? 0 : -1}
              className="dsh-subscriptions-page-tab"
              onClick={() => selectTab('settings')}
              onKeyDown={event => handleTabKeyDown(event, 'settings')}
            >
              <SettingsTabIcon size={15} />
              <span>{t('usageTabSettings')}</span>
            </button>
          </div>
        </header>

        <div
          role="tabpanel"
          id={`${tabIdPrefix}-panel-usage`}
          aria-labelledby={`${tabIdPrefix}-tab-usage`}
          hidden={activeTab !== 'usage'}
          className="dsh-subscriptions-page-panel"
        >
          <UsageDashboard
            {...rpc === undefined ? {} : { rpc }}
            t={t}
            embedded={true}
            refreshKey={usageRefreshKey}
          />
        </div>

        {visitedSettings && (
          <div
            role="tabpanel"
            id={`${tabIdPrefix}-panel-settings`}
            aria-labelledby={`${tabIdPrefix}-tab-settings`}
            hidden={activeTab !== 'settings'}
            className="dsh-subscriptions-page-panel"
          >
            <SubscriptionsSection
              {...rpc === undefined ? {} : { rpc }}
              t={t}
              hideUsageHint={true}
              embedded={true}
            />
          </div>
        )}
      </div>
    </div>
  )
}
