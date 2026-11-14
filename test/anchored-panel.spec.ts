import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, useRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { anchoredPlacement, overlayTopMargin, useAnchoredPosition, useDismissOnOutsidePointer } from '../src/client/anchored-panel.js'

const viewport = { width: 1000, height: 800 }
/** The usage badge's distances: 8px above its pill, 12px from each viewport edge. */
const badge = { side: 'top', gap: 8, margin: 12 } as const

test('a top-side panel sits above its anchor, left edges aligned', () => {
  assert.deepEqual(anchoredPlacement({
    anchor: { left: 400, right: 520, top: 700, bottom: 722 }, panel: { width: 300, height: 200 }, viewport, ...badge,
  }), { left: 400, top: 492 })
})

test('a bottom-side panel hangs below its anchor, and end alignment follows the right edge', () => {
  const anchor = { left: 400, right: 520, top: 100, bottom: 122 }
  const panel = { width: 300, height: 200 }
  assert.deepEqual(anchoredPlacement({ anchor, panel, viewport, gap: 8, margin: 12 }), { left: 400, top: 130 })
  assert.deepEqual(anchoredPlacement({ anchor, panel, viewport, align: 'end', gap: 8, margin: 12 }), { left: 220, top: 130 })
})

test('the panel is clamped inside every viewport edge', () => {
  const panel = { width: 300, height: 200 }
  // Anchor near the right edge: the panel would overflow by 250px.
  assert.equal(anchoredPlacement({ anchor: { left: 950, right: 990, top: 700, bottom: 722 }, panel, viewport, ...badge }).left, 688)
  // Anchor left of the viewport margin.
  assert.equal(anchoredPlacement({ anchor: { left: 2, right: 40, top: 700, bottom: 722 }, panel, viewport, ...badge }).left, 12)
  // No room above the anchor: stay at the top margin instead of leaving the viewport.
  assert.equal(anchoredPlacement({ anchor: { left: 400, right: 520, top: 60, bottom: 82 }, panel, viewport, ...badge }).top, 12)
  // A bottom-side panel that would run past the bottom edge.
  assert.equal(anchoredPlacement({ anchor: { left: 400, right: 520, top: 700, bottom: 722 }, panel, viewport, gap: 8, margin: 12 }).top, 588)
})

test('a frame top inset widens only the top margin', () => {
  const input = { anchor: { left: 400, right: 520, top: 60, bottom: 82 }, panel: { width: 300, height: 200 }, viewport, ...badge }
  assert.equal(anchoredPlacement({ ...input, topMargin: 68 }).top, 68)
  assert.equal(anchoredPlacement({ ...input, topMargin: 68 }).left, 400)
})

test('an unmeasured panel keeps the raw offset instead of clamping against a zero size', () => {
  assert.deepEqual(anchoredPlacement({
    anchor: { left: 990, right: 998, top: 4, bottom: 20 }, panel: { width: 0, height: 0 }, viewport, ...badge,
  }), { left: 990, top: -4 })
})

test('overlay top margin follows the desktop frame clearance, and only that', (t) => {
  const root = (attributes: string[]) => ({ hasAttribute: (name: string) => attributes.includes(name) }) as unknown as Element
  let clearance = ''
  // Node has no `getComputedStyle`; supply the one property the function reads.
  const scope = globalThis as { getComputedStyle?: unknown }
  const original = Object.getOwnPropertyDescriptor(scope, 'getComputedStyle')
  scope.getComputedStyle = () => ({ getPropertyValue: () => clearance })
  t.after(() => {
    if (original === undefined) delete scope.getComputedStyle
    else Object.defineProperty(scope, 'getComputedStyle', original)
  })
  // A plain web page publishes no frame clearance.
  assert.equal(overlayTopMargin(12, root([])), 12)
  clearance = '48px'
  assert.equal(overlayTopMargin(12, root([])), 68)
  assert.equal(overlayTopMargin(12, root(['data-fullscreen'])), 20)
  assert.equal(overlayTopMargin(80, root([])), 80, 'the caller margin is a floor')
  clearance = 'calc(1px + 1px)'
  assert.equal(overlayTopMargin(12, root([])), 12, 'an unparseable value is ignored')
})

test('both hooks render on the server and report no position while closed', () => {
  const positions: unknown[] = []
  function Probe({ open }: { open: boolean }) {
    const anchorRef = useRef<HTMLElement | null>(null)
    const panelRef = useRef<HTMLElement | null>(null)
    positions.push(useAnchoredPosition({ open, anchorRef, panelRef, ...badge }))
    useDismissOnOutsidePointer(anchorRef, open, () => {}, panelRef)
    return createElement('span')
  }
  assert.equal(renderToStaticMarkup(createElement(Probe, { open: false })), '<span></span>')
  // Effects do not run on the server, so an open panel is still unmeasured there.
  assert.equal(renderToStaticMarkup(createElement(Probe, { open: true })), '<span></span>')
  assert.deepEqual(positions, [null, null])
})
