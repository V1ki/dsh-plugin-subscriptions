import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubscriptionNavIcon } from '../src/client/SubscriptionNavIcon.js'

test('settings navigation icon follows host sizing and uses current color', () => {
  for (const active of [false, true]) {
    const html = renderToStaticMarkup(createElement(SubscriptionNavIcon, { size: 16, active }))
    assert.match(html, /width="16"/)
    assert.match(html, /height="16"/)
    assert.match(html, /stroke="currentColor"/)
    assert.match(html, /aria-hidden="true"/)
  }
})
