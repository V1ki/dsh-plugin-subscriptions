import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hostIcon } from '../src/client/host-icons.js'

test('host icons resolve the DSH 0.1.7 name, the older 16px name, or render nothing', () => {
  const modern = () => createElement('svg', { 'data-version': 'modern' })
  const legacy = () => createElement('svg', { 'data-version': 'legacy' })
  assert.equal(hostIcon({ IconSparkleRegular: modern, IconSparkle16: legacy }, 'Sparkle'), modern)
  assert.equal(hostIcon({ IconSparkleRegular: modern }, 'Sparkle'), modern)
  assert.equal(hostIcon({ IconSparkle16: legacy }, 'Sparkle'), legacy)
  // A host lacking the glyph must not crash the slot rendering it (React #130).
  assert.equal(renderToStaticMarkup(createElement(hostIcon({ IconDataOutlineRegular: modern }, 'Sparkle'))), '')
})
