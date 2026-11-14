/**
 * Placement and outside-pointer dismissal for a trigger-anchored panel that
 * is portaled to `document.body`, owned by this plugin.
 *
 * The usage badge used to take both hooks from
 * `@deepseek-ai/dsh-client-ui-primitives`. DSH 0.2.2 removed
 * `useAnchoredPosition` there (host panels moved to CSS anchor positioning).
 * The client reads host modules at runtime, so a named import of a hook the
 * host no longer exports is `undefined`, and calling it during render crashes
 * the slot entry — which the host then retires for the page lifetime. Hooks
 * the badge cannot render without therefore live here, independent of the
 * host's export list.
 *
 * The placement rules follow the hook DSH shipped through 0.2.1
 * (`@deepseek-ai/dsh-client-ui-primitives`, MIT, Copyright (c) 2026 DeepSeek),
 * so supported older hosts keep the same dialog position.
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/** Fixed coordinates of the panel's top-left corner, in viewport pixels. */
export interface AnchoredPosition {
  left: number
  top: number
}

/** Geometry for one placement; every length is in viewport pixels. */
export interface AnchoredPlacementInput {
  /** The trigger's viewport rectangle. */
  anchor: { left: number; right: number; top: number; bottom: number }
  /** The panel's laid-out size; a zero dimension is not clamped on that axis. */
  panel: { width: number; height: number }
  viewport: { width: number; height: number }
  /** Which anchor edge the panel hangs from: below it (`bottom`, the default) or above it (`top`). */
  side?: 'top' | 'bottom'
  /** Which anchor edge the panel lines up with: its left edge (`start`, the default) or its right edge (`end`). */
  align?: 'start' | 'end'
  /** Distance kept between the anchor edge named by `side` and the panel. */
  gap: number
  /** Distance kept between the panel and the left, right and bottom viewport edges. */
  margin: number
  /** Distance kept from the top viewport edge; defaults to `margin`. */
  topMargin?: number
}

/**
 * Offset a panel from its anchor and clamp it inside the viewport.
 * @param input - anchor rectangle, panel size, viewport size and distances.
 * @returns the panel's fixed `left`/`top`.
 */
export function anchoredPlacement(input: AnchoredPlacementInput): AnchoredPosition {
  const { anchor, panel, viewport, side = 'bottom', align = 'start', gap, margin } = input
  const topMargin = input.topMargin ?? margin
  let left = align === 'end' ? anchor.right - panel.width : anchor.left
  let top = side === 'top' ? anchor.top - gap - panel.height : anchor.bottom + gap
  // An unmeasured panel (zero size) keeps the raw offset until it is laid out.
  if (panel.width > 0) left = Math.min(Math.max(left, margin), viewport.width - panel.width - margin)
  if (panel.height > 0) top = Math.min(Math.max(top, topMargin), viewport.height - panel.height - margin)
  return { left, top }
}

/**
 * Top inset an overlay keeps so it clears the desktop frame's reserved strip
 * (window controls). The host publishes the strip height on the root element
 * as `--dsh-frame-top-clearance`; plain web pages do not set it.
 * @param min - the overlay's own viewport margin in px, used as the floor.
 * @param root - element carrying the frame variables.
 * @returns the larger of `min` and the frame clearance plus 20px; fullscreen keeps only the 20px gap.
 */
export function overlayTopMargin(min: number, root: Element = document.documentElement): number {
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return min
  return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20)
}

/** Inputs for {@link useAnchoredPosition}. */
export interface AnchoredPositionOptions {
  /** Whether the panel is mounted and should track its anchor. */
  open: boolean
  /** The element the panel is placed from. */
  anchorRef: RefObject<HTMLElement | null>
  /** The panel, measured so the clamp uses real dimensions. */
  panelRef: RefObject<HTMLElement | null>
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  gap: number
  margin: number
}

/** Layout effects do not run during a server render, and React warns when one is declared there. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Keep a fixed-position panel anchored to its trigger: place it on open and
 * again on scroll (capture phase, so nested scrollers count), on window
 * resize, and when the panel's own size changes.
 * @param options - the open state, the two refs, the placement side and alignment, and the gap/margin distances.
 * @returns `left`/`top` for the panel, or `null` while closed and before the first measurement.
 */
export function useAnchoredPosition(options: AnchoredPositionOptions): AnchoredPosition | null {
  const { open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin } = options
  const [position, setPosition] = useState<AnchoredPosition | null>(null)
  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const place = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      if (anchor === undefined) return
      const panel = panelRef.current
      const next = anchoredPlacement({
        anchor,
        panel: { width: panel?.offsetWidth ?? 0, height: panel?.offsetHeight ?? 0 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        side, align, gap, margin,
        topMargin: overlayTopMargin(margin),
      })
      // Scroll and resize fire in bursts; an unchanged placement must not re-render the badge.
      setPosition(previous => previous !== null && previous.left === next.left && previous.top === next.top ? previous : next)
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const panel = panelRef.current
    const observer = typeof ResizeObserver === 'undefined' || panel === null ? null : new ResizeObserver(place)
    if (panel !== null) observer?.observe(panel)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin])
  return position
}

/**
 * Close an open panel when a pointerdown lands outside its root element.
 * @param root - element containing the trigger.
 * @param open - whether the panel is showing; false detaches the listener.
 * @param setOpen - state setter invoked with false on an outside pointerdown.
 * @param portal - panel portaled outside the root, which also counts as inside.
 */
export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  portal?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node
        && root.current?.contains(event.target) !== true
        && portal?.current?.contains(event.target) !== true) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [root, open, setOpen, portal])
}
