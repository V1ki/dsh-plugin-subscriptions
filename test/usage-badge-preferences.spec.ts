import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readUsageBadgeMode, setUsageBadgeMode, subscribeUsageBadgeMode } from '../src/client/usage-badge-preferences.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { en, zh } from '../src/client/locales.js'

const key = 'dsh.subscriptions.usageBadgeMode'

class Browser extends EventTarget {
  values = new Map<string, string>()
  localStorage = {
    getItem: (name: string): string | null => this.values.get(name) ?? null,
    setItem: (name: string, value: string): void => { this.values.set(name, value) },
  }
}

function withBrowser(run: (browser: Browser) => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const browser = new Browser()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  try { run(browser) } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', original)
  }
}

test('display preference defaults safely without a browser and renders bilingual settings', () => {
  assert.equal(readUsageBadgeMode(), 'recent')
  for (const dictionary of [en, zh]) {
    const html = renderToStaticMarkup(createElement(UsageBadgeDisplaySetting, { t: key => dictionary[key] }))
    assert.ok(html.includes(dictionary.usageBadgeDisplay))
    assert.ok(html.includes(dictionary.usageBadgeDisplayHidden))
    assert.ok(html.includes(dictionary.usageBadgeDisplayRecent))
    assert.equal((html.match(/<option /g) ?? []).length, 2)
    assert.ok(html.includes('<label'))
  }
})

test('saving persists only the display mode and notifies same-tab subscribers', () => withBrowser(browser => {
  let updates = 0
  const unsubscribe = subscribeUsageBadgeMode(() => { updates++ })
  assert.equal(readUsageBadgeMode(), 'recent')
  setUsageBadgeMode('hidden')
  assert.equal(readUsageBadgeMode(), 'hidden')
  assert.deepEqual([...browser.values], [[key, 'hidden']])
  assert.equal(updates, 1)
  setUsageBadgeMode('recent')
  assert.equal(readUsageBadgeMode(), 'recent')
  assert.equal(updates, 2)
  unsubscribe()
  setUsageBadgeMode('hidden')
  assert.equal(updates, 2)
}))

test('cross-tab changes and clear notify; unrelated storage writes do not', () => withBrowser(browser => {
  let updates = 0
  const unsubscribe = subscribeUsageBadgeMode(() => { updates++ })
  const storageEvent = (name: string | null): void => {
    const event = new Event('storage')
    Object.defineProperty(event, 'key', { value: name })
    browser.dispatchEvent(event)
  }
  storageEvent('unrelated')
  assert.equal(updates, 0)
  browser.values.set(key, 'hidden')
  storageEvent(key)
  assert.equal(updates, 1)
  assert.equal(readUsageBadgeMode(), 'hidden')
  browser.values.clear()
  storageEvent(null)
  assert.equal(updates, 2)
  assert.equal(readUsageBadgeMode(), 'recent')
  unsubscribe()
  storageEvent(key)
  assert.equal(updates, 2)
}))

test('unknown stored modes default to recent; invalid writes are rejected', () => withBrowser(browser => {
  browser.values.set(key, 'all')
  assert.equal(readUsageBadgeMode(), 'recent')
  assert.throws(() => Reflect.apply(setUsageBadgeMode, undefined, ['all']), TypeError)
  assert.equal(browser.values.get(key), 'all')
}))

test('blocked storage reads fall back; failed writes do not announce false success', () => withBrowser(browser => {
  browser.localStorage.getItem = () => { throw new DOMException('denied', 'SecurityError') }
  assert.equal(readUsageBadgeMode(), 'recent')
  let updates = 0
  const unsubscribe = subscribeUsageBadgeMode(() => { updates++ })
  browser.localStorage.setItem = () => { throw new DOMException('full', 'QuotaExceededError') }
  assert.throws(() => setUsageBadgeMode('hidden'), { name: 'QuotaExceededError' })
  assert.equal(updates, 0)
  browser.localStorage.getItem = () => { throw new Error('unexpected') }
  assert.throws(() => readUsageBadgeMode(), /unexpected/)
  unsubscribe()
}))
