// Optional offline UI regression: PLAYWRIGHT_PATH=/path/to/playwright node test/provider-tabs-browser.mjs
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => resolve('node_modules/.pnpm', dependencies.find(entry => entry.startsWith(`${name}@`)), 'node_modules', name)
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/provider-tabs-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } },
  plugins: [{ name: 'test-css', load(id) { return id.endsWith('.css') ? 'export default {}' : null } }],
  output: { format: 'iife' }, write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
try {
  const errors = []
  async function setup(width = 900) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<meta charset="utf-8"><style>body{margin:0;font:14px system-ui}</style><div id="root"></div>')
    await page.addScriptTag({ content: code })
    await page.getByRole('tablist').waitFor()
    return page
  }
  const tab = (page, name) => page.getByRole('tab').filter({ hasText: name })
  const names = page => page.getByRole('tab').allTextContents()
  async function selected(page, name) {
    const active = tab(page, name)
    assert.equal(await active.getAttribute('aria-selected'), 'true', name + ' is selected')
    assert.equal(await page.getByRole('tab', { selected: true }).count(), 1)
    const panelId = await active.getAttribute('aria-controls')
    assert.ok(panelId, 'selected tab references a panel')
    const panel = page.locator('[role="tabpanel"]').filter({ visible: true })
    assert.equal(await panel.count(), 1, 'exactly one panel is visible')
    assert.equal(await panel.getAttribute('id'), panelId)
    assert.equal(await panel.getAttribute('aria-labelledby'), await active.getAttribute('id'))
    return panel
  }
  async function settingsVisible(page) {
    assert.equal(await page.getByLabel('Status-bar quota display', { exact: true }).isVisible(), true)
    assert.equal(await page.getByLabel('Quota percentages', { exact: true }).isVisible(), true)
    assert.equal(await page.getByText('Proxy', { exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('button', { name: 'Configure…' }).isVisible(), true)
  }
  const expected = ['Alpha', 'Zulu', 'GitHub Copilot', 'Google Antigravity', 'Grok (X Premium)']
  const page = await setup()
  await page.evaluate(() => window.releaseStatus())
  await tab(page, 'Alpha').waitFor()
  assert.deepEqual(await names(page), expected, 'connected first; names alphabetic within both groups')
  await selected(page, 'Alpha')
  await settingsVisible(page)
  const order = await page.evaluate(() => {
    const tabs = document.querySelector('[role="tablist"]')
    const quota = document.querySelector('select[aria-label="Status-bar quota display"]')
    const proxy = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Configure…')
    return !!(tabs && quota && proxy && (tabs.compareDocumentPosition(quota) & Node.DOCUMENT_POSITION_FOLLOWING) && (quota.compareDocumentPosition(proxy) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  assert.equal(order, true, 'providers and accounts precede quota preferences; proxy is last')
  await tab(page, 'Grok (X Premium)').click()
  let panel = await selected(page, 'Grok (X Premium)')
  await settingsVisible(page)
  await panel.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[role=tab]')?.textContent?.includes('Alpha') && document.querySelectorAll('[role=tab]')[1]?.textContent?.includes('Grok'))
  assert.deepEqual(await names(page), ['Alpha', 'Grok (X Premium)', 'Zulu', 'GitHub Copilot', 'Google Antigravity'])
  panel = await selected(page, 'Grok (X Premium)')
  await panel.getByText('grok@example.test').waitFor()
  page.once('dialog', dialog => dialog.accept())
  await panel.getByRole('button', { name: 'Log out', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]')[1]?.textContent?.includes('Zulu'))
  assert.deepEqual(await names(page), expected)
  await selected(page, 'Grok (X Premium)')
  await settingsVisible(page)
  await page.close()

  // An explicit pre-status selection must beat the default chosen from the response.
  const early = await setup()
  await tab(early, 'Grok (X Premium)').click()
  await early.evaluate(() => window.releaseStatus())
  await tab(early, 'Alpha').waitFor()
  assert.deepEqual(await names(early), expected)
  await selected(early, 'Grok (X Premium)')
  await early.close()

  // The selected roving tab can be reached with Tab, arrows wrap, and Home/End jump.
  // A narrow viewport must reveal the keyboard-selected tab inside the scroll strip.
  const narrow = await setup(280)
  await narrow.evaluate(() => window.releaseStatus())
  await tab(narrow, 'Alpha').waitFor()
  const list = narrow.getByRole('tablist')
  await narrow.mouse.move(0, 0)
  const scrollbarColor = () => list.evaluate(el => getComputedStyle(el).scrollbarColor)
  assert.equal(await scrollbarColor(), 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)', 'scrollbar is visually hidden at rest')
  await list.hover()
  assert.notEqual(await scrollbarColor(), 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)', 'scrollbar is visible on hover')
  await narrow.mouse.move(0, 0)
  await tab(narrow, 'Alpha').focus()
  assert.notEqual(await scrollbarColor(), 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)', 'scrollbar is visible while navigating with keyboard')
  assert.equal(await tab(narrow, 'Alpha').evaluate(el => el === document.activeElement), true, 'selected tab accepts keyboard focus')
  assert.equal(await narrow.getByRole('tab').evaluateAll(els => els.filter(el => el.tabIndex === 0).length), 1)
  await narrow.keyboard.press('End')
  await selected(narrow, 'Grok (X Premium)')
  assert.equal(await tab(narrow, 'Grok (X Premium)').evaluate(el => el === document.activeElement), true)
  const geometry = await list.evaluate(el => {
    const selected = el.querySelector('[role="tab"][aria-selected="true"]')
    const strip = el.getBoundingClientRect(), item = selected.getBoundingClientRect()
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, left: item.left - strip.left, right: item.right - strip.right }
  })
  assert.ok(geometry.scrollWidth > geometry.clientWidth, 'narrow viewport overflows the tab strip')
  assert.ok(geometry.left >= -1 && geometry.right <= 1, 'keyboard-selected tab is not clipped')
  await narrow.keyboard.press('ArrowRight')
  await selected(narrow, 'Alpha')
  await narrow.keyboard.press('ArrowLeft')
  await selected(narrow, 'Grok (X Premium)')
  await narrow.keyboard.press('Home')
  await selected(narrow, 'Alpha')
  await narrow.keyboard.press('ArrowRight')
  await selected(narrow, 'Zulu')
  await settingsVisible(narrow)
  await narrow.close()
  assert.deepEqual(errors, [])
  console.log('Provider tabs browser checks passed')
} finally {
  await browser.close()
}
