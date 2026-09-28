import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClientVersionTag } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

const translator = (dictionary: typeof en) => (key: keyof typeof en, params?: Record<string, unknown>) =>
  dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

test('Settings shows the presented CLI version and its source beside the provider', () => {
  const render = (dictionary: typeof en, clientVersion?: { version: string; source: 'npm' | 'local' | 'fallback' | 'config' }) =>
    renderToStaticMarkup(createElement(ClientVersionTag, { clientVersion, t: translator(dictionary) }))
  assert.match(render(en, { version: '0.157.1', source: 'npm' }), />CLI 0\.157\.1 · latest on npm</)
  assert.match(render(zh, { version: '2.1.283', source: 'fallback' }), />CLI 2\.1\.283 · 内置版本</)
  assert.match(render(zh, { version: '2.1.290', source: 'local' }), /本机 CLI/)
  assert.match(render(en, { version: '0.153.4', source: 'config' }), /configured/)
  assert.match(render(en, { version: '0.157.1', source: 'npm' }), /title="Requests present this CLI version/)
  assert.equal(render(en), '', 'routes without a CLI version show nothing')
})
