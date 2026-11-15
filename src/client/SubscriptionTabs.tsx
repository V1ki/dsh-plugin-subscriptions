import { useRef } from 'react'
import type { ReactNode, RefObject } from 'react'

export interface SubscriptionTab<T extends string> {
  key: T
  /** Stable, DOM-safe suffix shared with the corresponding panel. */
  id: string
  label: string
  ariaLabel?: string
  content?: ReactNode
  provider?: string
}

/** Automatic-activation horizontal tabs, shared by provider and account settings. */
export function SubscriptionTabs<T extends string>({ tabs, active, onSelect, prefix, label, tabRefs }: {
  tabs: readonly SubscriptionTab<T>[]
  active: T | undefined
  onSelect: (key: T) => void
  prefix: string
  label: string
  tabRefs?: RefObject<Partial<Record<T, HTMLButtonElement>>>
}) {
  const internalRefs = useRef<Partial<Record<T, HTMLButtonElement>>>({})
  const refs = tabRefs ?? internalRefs
  return <div className="dsh-subscription-tabs" role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.key} type="button" role="tab" data-subscription-provider={tab.provider}
      id={prefix + '-tab-' + tab.id} ref={node => { if (node) refs.current![tab.key] = node; else delete refs.current![tab.key] }}
      aria-controls={prefix + '-panel-' + tab.id} aria-selected={active === tab.key}
      aria-label={tab.ariaLabel} tabIndex={active === tab.key ? 0 : -1}
      onFocus={() => onSelect(tab.key)} onClick={() => onSelect(tab.key)}
      onKeyDown={event => {
        let next = index
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = tabs.length - 1
        else return
        event.preventDefault()
        const nextKey = tabs[next].key
        onSelect(nextKey)
        refs.current?.[nextKey]?.focus()
      }}>
      {tab.content ?? tab.label}
    </button>)}
  </div>
}
