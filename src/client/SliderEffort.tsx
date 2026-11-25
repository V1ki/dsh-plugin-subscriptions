import { useEffect, useId, useRef, useState } from 'react'
import type { SubscriptionsKey } from './locales.js'

export interface SliderReasoning {
  efforts: readonly { id: string; name: string }[]
  defaultEffort?: string
}

export function SliderEffort({ reasoning, effort, busy, apply, t }: {
  reasoning: SliderReasoning
  effort: string | undefined
  busy: boolean
  apply: (effort: string | undefined) => Promise<boolean>
  t: (key: SubscriptionsKey) => string
}) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const defaultName = reasoning.efforts.find(item => item.id === reasoning.defaultEffort)?.name ?? reasoning.defaultEffort
  const defaultLabel = t('modelSliderEffortDefault') + (defaultName ? ` (${defaultName})` : '')
  const activeLabel = effort === undefined ? defaultLabel : reasoning.efforts.find(item => item.id === effort)?.name ?? effort
  const label = `${t('modelSliderEffort')}: ${activeLabel}`
  const options = [{ id: undefined, name: defaultLabel }, ...reasoning.efforts]
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  const close = () => { setOpen(false); trigger.current?.focus() }

  useEffect(() => {
    if (!open) return
    const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    ;(selected ?? menu.current?.querySelector('button'))?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  return (
    <div className="dsh-model-slider-effort" ref={root}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
      onKeyDown={event => {
        if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      }}
    >
      <button type="button" ref={trigger} className="dsh-model-slider-brain" data-explicit={effort !== undefined}
        aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-disabled={busy} onClick={() => { if (!busy) { setFailed(false); setOpen(!open) } }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path className="dsh-model-slider-brain-shape" d="M12 5a3 3 0 0 0-5.86-.9A4 4 0 0 0 3.4 9.9a4 4 0 0 0 .78 6.55A3.96 3.96 0 0 0 12 17a3.96 3.96 0 0 0 7.82-.55 4 4 0 0 0 .78-6.55 4 4 0 0 0-2.74-5.8A3 3 0 0 0 12 5Z" />
          <path className="dsh-model-slider-brain-lines" d="M12 5v12m-8.6-7.1c1.7-.7 3.4.3 3.6 2.1m13.6-2.1c-1.7-.7-3.4.3-3.6 2.1M7.1 5.1c.9.3 1.5 1.1 1.5 2m8.3-2c-.9.3-1.5 1.1-1.5 2" />
        </svg>
      </button>
      {open && <div id={id} ref={menu} className="dsh-model-slider-effort-menu" role="menu" aria-label={t('modelSliderEffort')}
        onKeyDown={event => {
          const buttons = items()
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : event.key === 'ArrowDown' ? (index + 1) % buttons.length
            : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : undefined
          if (target !== undefined) { event.preventDefault(); event.stopPropagation(); buttons[target]?.focus() }
        }}
      >
        <div className="dsh-model-slider-effort-heading" aria-hidden="true">{t('modelSliderEffort')}</div>
        {options.map(({ id: value, name }) => <button key={value ?? ''} type="button" role="menuitemradio" tabIndex={-1}
          aria-checked={effort === value} aria-disabled={busy}
          onClick={async () => {
            if (busy) return
            if (value === effort || await apply(value)) {
              if (root.current?.contains(document.activeElement)) close()
              else setOpen(false)
            } else if (root.current?.contains(document.activeElement)) setFailed(true)
          }}
        ><span>{name}</span><span aria-hidden="true">{effort === value ? '✓' : ''}</span></button>)}
        {failed && <div className="dsh-model-slider-effort-error" role="alert">{t('modelSliderEffortFailed')}</div>}
      </div>}
    </div>
  )
}
