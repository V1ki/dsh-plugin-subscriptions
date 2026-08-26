/**
 * Settings-nav glyph for the Subscriptions section.
 *
 * The settings shell picks nav icons by section id — `models`,
 * `agent-presets`, and `plugins` get their own, and every other id falls back
 * to the settings gear (see `navIcon` in dsh-client-ui-settings-general).
 * `settings.section` registration carries only `id`, `order`, and `label`, so
 * a registrant has no way to supply a glyph through the API.
 *
 * Until the shell offers one, this decorates our nav cell after render: it
 * finds the button by the label WE registered and rewrites the icon in place.
 * Three properties keep that honest:
 *
 * - it mutates the existing `<svg>` rather than replacing React-managed nodes,
 *   so React's tree is never invalidated underneath it;
 * - it matches on the live value of our own `label` thunk, so it follows the
 *   active locale automatically instead of hardcoding translated strings;
 * - every failure path leaves the shell's own gear in place, and disposal
 *   restores it, so the worst outcome is the icon we started with.
 *
 * If the shell ever accepts an icon in the registration, delete this file and
 * pass the glyph instead.
 */

/** A credit-card glyph, in the 24×24 stroked geometry the shell's icons use. */
const CARD_ICON_INNER = '<rect x="2.5" y="5" width="19" height="14" rx="2"></rect><path d="M2.5 10h19"></path>'

/** Marks an svg this module already rewrote, so re-renders are cheap to skip. */
const PATCHED_FLAG = 'subscriptionsNavIcon'

/** What one patched icon needs to be restored to its shipped state. */
interface Restore {
  readonly svg: SVGElement
  readonly viewBox: string | null
  readonly fill: string | null
  readonly stroke: string | null
  readonly strokeWidth: string | null
  readonly innerHTML: string
}

function queryAll(root: ParentNode | Document, selector: string): Element[] {
  try {
    return typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll(selector)] : []
  } catch {
    return []
  }
}

/**
 * Rewrite the nav icon of every settings dialog whose row carries our label.
 * @param label - the section label as currently rendered (the `label` thunk's value).
 * @param restores - accumulator recording what each patch replaced.
 */
function patchNavIcons(label: string, restores: Restore[]): void {
  if (typeof document === 'undefined' || document.body === null) return
  if (label.length === 0) return
  for (const dialog of queryAll(document, '[role="dialog"]')) {
    for (const button of queryAll(dialog, 'nav button')) {
      const text = typeof button.textContent === 'string' ? button.textContent : ''
      if (!text.includes(label)) continue
      const svg = button.querySelector('svg')
      if (svg === null) continue
      const flags = (svg as SVGElement & { dataset?: DOMStringMap }).dataset
      if (flags === undefined || flags[PATCHED_FLAG] === '1') continue
      try {
        restores.push({
          svg,
          viewBox: svg.getAttribute('viewBox'),
          fill: svg.getAttribute('fill'),
          stroke: svg.getAttribute('stroke'),
          strokeWidth: svg.getAttribute('stroke-width'),
          innerHTML: svg.innerHTML,
        })
        flags[PATCHED_FLAG] = '1'
        svg.setAttribute('viewBox', '0 0 24 24')
        svg.setAttribute('fill', 'none')
        svg.setAttribute('stroke', 'currentColor')
        svg.setAttribute('stroke-width', '1.5')
        svg.setAttribute('stroke-linecap', 'round')
        svg.setAttribute('stroke-linejoin', 'round')
        svg.innerHTML = CARD_ICON_INNER
      } catch {
        // Any failure leaves the shell's own gear rendered; nothing to report.
      }
    }
  }
}

/**
 * Start decorating our settings-nav cell.
 *
 * The panel mounts and unmounts with the dialog and re-renders on locale
 * change, so the patch runs under a body observer rather than once: a fresh
 * React icon arrives without our marker and is rewritten on the next tick.
 *
 * @param label - reads the section label as currently rendered; called per pass
 *   so a locale switch is picked up without re-registering anything.
 * @returns a disposer that stops observing and restores every icon it changed.
 */
export function installNavIcon(label: () => string): () => void {
  const restores: Restore[] = []
  const run = (): void => {
    try {
      patchNavIcons(label(), restores)
    } catch {
      // A failing label thunk must not break the observer.
    }
  }

  run()

  let observer: MutationObserver | undefined
  try {
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body !== null) {
      observer = new MutationObserver(run)
      observer.observe(document.body, { childList: true, subtree: true })
    }
  } catch {
    observer = undefined
  }

  return () => {
    try {
      observer?.disconnect()
    } catch {
      // Best-effort teardown.
    }
    for (const entry of restores) {
      try {
        const flags = (entry.svg as SVGElement & { dataset?: DOMStringMap }).dataset
        if (flags !== undefined) delete flags[PATCHED_FLAG]
        entry.innerHTML === '' ? entry.svg.replaceChildren() : (entry.svg.innerHTML = entry.innerHTML)
        for (const [name, value] of [
          ['viewBox', entry.viewBox],
          ['fill', entry.fill],
          ['stroke', entry.stroke],
          ['stroke-width', entry.strokeWidth],
        ] as const) {
          if (value === null) entry.svg.removeAttribute(name)
          else entry.svg.setAttribute(name, value)
        }
        entry.svg.removeAttribute('stroke-linecap')
        entry.svg.removeAttribute('stroke-linejoin')
      } catch {
        // The node may already be gone with the unmounted dialog.
      }
    }
    restores.length = 0
  }
}
