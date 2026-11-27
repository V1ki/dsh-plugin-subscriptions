// Offline regression; no server, account or real browser settings are used.
// PLAYWRIGHT_PATH=/path/to/playwright node test/settings-help-browser.mjs
import assert from 'node:assert/strict'
import { choosePreference, preferenceValue } from './preference-menu-browser.mjs'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => {
  const entry = dependencies.find(item => item.startsWith(`${name}@`))
  if (!entry) throw new Error(`Missing dependency: ${name}`)
  return resolve('node_modules/.pnpm', entry, 'node_modules', name)
}
if (!process.env.PLAYWRIGHT_PATH) throw new Error('Set PLAYWRIGHT_PATH to the installed playwright package')
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/settings-help-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{ name: 'test-css', load(id) { return id.endsWith('.css') ? 'export default {}' : null } }],
  output: { format: 'iife' }, write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
const hints = [
  { name: 'Status-bar quota display', hint: 'Saved automatically in this browser. At most one subscription is shown, and only while the session uses a subscription model; a non-subscription model shows nothing instead of the last subscription used here. Hiding does not affect usage details here.' },
  { name: 'Quota percentages', hint: 'Applies to Settings and the status bar, independently of hiding. Warning colors always indicate high usage.' },
]
const errors = []
async function createPage(options = {}) {
  const context = await browser.newContext(options)
  await context.route('**/*', route => route.fulfill({ status: 200,
    contentType: route.request().url().endsWith('/app.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('/app.js') ? code : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>' }))
  const page = await context.newPage()
  page.setDefaultTimeout(4000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://settings-help.test/')
  await page.getByRole('button', { name: hints[0].name, exact: true }).waitFor()
  return { page, context }
}
const trigger = (page, name) => page.getByRole('button', { name: `About ${name}`, exact: true })
const tip = (page, hint) => page.getByRole('tooltip').filter({ hasText: hint })
async function checkDescription(button, expected) {
  const description = await button.evaluate(el => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent ?? '').join(' '))
  assert.ok(description.includes(expected), 'aria-describedby exposes the full help text to assistive technology')
}
try {
  const { page, context } = await createPage({ viewport: { width: 900, height: 900 } })
  for (const { name, hint } of hints) {
    const button = trigger(page, name)
    const tooltip = tip(page, hint)
    assert.equal(await button.count(), 1, `unique accessible help button for ${name}`)
    assert.equal(await tooltip.isVisible(), false, 'help is not permanently displayed')
    await button.hover()
    await tooltip.waitFor({ state: 'visible' })
    await checkDescription(button, hint)
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: 'hidden' })
  }
  // Tab, rather than programmatic focus, establishes that the trigger participates in keyboard navigation.
  await page.getByRole('button', { name: 'Before settings' }).focus()
  for (const { name, hint } of hints) {
    const button = trigger(page, name)
    for (let i = 0; i < 10 && !(await button.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab')
    assert.equal(await button.evaluate(el => el === document.activeElement), true, `Tab reaches ${name} help`)
    await tip(page, hint).waitFor({ state: 'visible' })
    await checkDescription(button, hint)
    await page.keyboard.press('Escape')
    await tip(page, hint).waitFor({ state: 'hidden' })
  }
  // A click opens the popover without changing either preference; outside dismisses it.
  await page.getByRole('button', { name: 'Outside settings' }).focus()
  for (const { name, hint } of hints) {
    const before = await page.locator('button[aria-haspopup=menu]').allTextContents()
    await trigger(page, name).click()
    await tip(page, hint).waitFor({ state: 'visible' })
    assert.deepEqual(await page.locator('button[aria-haspopup=menu]').allTextContents(), before)
    await trigger(page, name).click()
    await tip(page, hint).waitFor({ state: 'hidden' })
    await page.mouse.move(0, 0)
    await trigger(page, name).click()
    await tip(page, hint).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Outside settings' }).click()
    await tip(page, hint).waitFor({ state: 'hidden' })
  }
  const badge = page.getByRole('button', { name: hints[0].name, exact: true })
  const quota = page.getByRole('button', { name: hints[1].name, exact: true })
  await choosePreference(badge, 'hidden')
  await choosePreference(quota, 'remaining')
  assert.equal(await preferenceValue(badge), 'hidden')
  assert.equal(await preferenceValue(quota), 'remaining')
  await page.reload()
  assert.equal(await preferenceValue(badge), 'hidden', 'status-bar selection persists')
  assert.equal(await preferenceValue(quota), 'remaining', 'quota selection persists')
  // Text is the default, and irrelevant options are removed without clearing preferences.
  const style = page.getByRole('button', { name: 'Status-bar style', exact: true })
  const target = page.getByRole('switch', { name: 'Linear spending target', exact: true })
  assert.equal(await style.count(), 0)
  await choosePreference(badge, 'recent')
  assert.equal(await preferenceValue(style), 'text')
  assert.equal(await target.count(), 0)
  await choosePreference(style, 'compact')
  assert.equal(await target.getAttribute('aria-checked'), 'true')
  await target.click()
  assert.equal(await target.getAttribute('aria-checked'), 'false')
  await choosePreference(style, 'text')
  assert.equal(await target.count(), 0)
  await page.reload()
  assert.equal(await preferenceValue(style), 'text')
  await choosePreference(style, 'compact')
  assert.equal(await target.getAttribute('aria-checked'), 'false')
  await target.click()
  assert.equal(await target.getAttribute('aria-checked'), 'true')
  await choosePreference(badge, 'hidden')
  assert.equal(await style.count(), 0)
  assert.equal(await target.count(), 0)
  await choosePreference(badge, 'recent')
  assert.equal(await preferenceValue(style), 'compact')
  await style.click()
  await page.keyboard.press('Escape')
  assert.equal(await style.getAttribute('aria-expanded'), 'false')
  await context.close()

  // Touch input uses a separate mobile context, rather than a mouse click standing in for a tap.
  const mobile = await createPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  for (const { name, hint } of hints) {
    await trigger(mobile.page, name).tap()
    await tip(mobile.page, hint).waitFor({ state: 'visible' })
    await checkDescription(trigger(mobile.page, name), hint)
    await mobile.page.getByRole('button', { name: 'Outside settings' }).tap()
    await tip(mobile.page, hint).waitFor({ state: 'hidden' })
  }
  await mobile.context.close()
  assert.deepEqual(errors, [])
  console.log('PASS: hover, keyboard focus/Escape, click/outside, touch, accessible descriptions and independent persistent selects')
} finally {
  await browser.close()
}
