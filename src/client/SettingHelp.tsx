import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubscriptionsKey } from './locales.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** A separate button avoids nesting interactive help inside a control label. */
export function SettingHelp({ title, hint, t, portal = true }: { title: string; hint: string; t: Translate; portal?: boolean }) {
  return <Tooltip label={hint} side="bottom" portal={portal} openOnClick maxWidth={340}>
    <button type="button" className="dsh-subscription-setting-help" aria-label={t('settingsHelpLabel', { setting: title })}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 7v4M8 4.75v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  </Tooltip>
}
