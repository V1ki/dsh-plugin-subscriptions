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
  async function setup(width = 900, reducedMotion = 'reduce') {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<meta charset="utf-8"><style>body{margin:0;font:14px system-ui;--dsw-alias-label-primary:#111;--dsw-alias-bg-layer-3:#ddd;--dsw-alias-state-business-primary:#2455aa;--dsw-focus-ring-color:#2455aa}</style><div id="root"></div>')
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
  await tab(page, 'Zulu').click()
  const codex = await selected(page, 'Zulu')
  const balance = codex.getByText('Credits: 0', { exact: true })
  const disclosure = codex.locator('summary').filter({ hasText: '3 available resets' })
  await disclosure.waitFor()
  assert.match(await disclosure.innerText(), /Expand/)
  assert.ok((await balance.boundingBox()).x < (await disclosure.getByText('3 available resets', { exact: true }).boundingBox()).x)
  assert.equal(await codex.getByText(/^Expires /).first().isVisible(), false)
  await disclosure.press('Enter')
  assert.match(await disclosure.innerText(), /Collapse/)
  const rows = codex.locator('.subscriptions-reset-row')
  assert.equal(await rows.count(), 3)
  const use = codex.getByRole('button', { name: 'Use full reset…', exact: true })
  assert.equal(await rows.first().getByRole('button').count(), 1)
  assert.equal(await use.isDisabled(), true)
  const expiry = await rows.first().getByText(/^Expires /).boundingBox()
  assert.equal(expiry.x, (await balance.boundingBox()).x, 'expanded dates align with Credits')
  assert.ok(expiry.x + expiry.width < (await use.boundingBox()).x, 'action follows the expiry date')
  await codex.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.subscriptions-reset-row button')?.getAttribute('aria-disabled') === 'false')
  await use.click()
  const confirm = page.getByRole('dialog').filter({ hasText: 'Confirm full reset' })
  await confirm.waitFor()
  assert.deepEqual(await page.evaluate(() => window.preparedReset), { account: 'codex' })
  const consume = confirm.getByRole('button', { name: 'Consume 1 reset' })
  assert.equal(await consume.isDisabled(), true)
  assert.equal(await page.evaluate(() => window.consumedReset), undefined)
  await confirm.getByRole('checkbox').check()
  await consume.click()
  await page.waitForFunction(() => window.consumedReset?.ticket === 'test-ticket')
  await confirm.waitFor({ state: 'hidden' })
  await disclosure.click()
  assert.match(await disclosure.innerText(), /Expand/)
  await tab(page, 'Grok (X Premium)').click()
  let panel = await selected(page, 'Grok (X Premium)')
  await settingsVisible(page)
  await panel.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[role=tab]')?.textContent?.includes('Alpha') && document.querySelectorAll('[role=tab]')[1]?.textContent?.includes('Grok'))
  assert.deepEqual(await names(page), ['Alpha', 'Grok (X Premium)', 'Zulu', 'GitHub Copilot', 'Google Antigravity'])
  panel = await selected(page, 'Grok (X Premium)')
  const account = panel.getByText('grok@example.test')
  await account.waitFor()
  const header = panel.locator('.dsh-subscription-provider-header')
  const add = header.getByRole('button', { name: 'Add account', exact: true })
  const manage = header.getByRole('button', { name: 'Manage', exact: true })
  assert.equal(await add.locator('svg').count(), 1)
  assert.equal(await manage.locator('svg').count(), 1)
  assert.ok((await manage.boundingBox()).y < (await account.boundingBox()).y)
  const help = header.getByRole('button', { name: 'About Add account', exact: true })
  await help.click()
  const tip = page.getByRole('tooltip')
  await tip.waitFor({ state: 'visible' })
  assert.match(await tip.textContent(), /Browser authorization signs in/)
  await page.keyboard.press('Escape')
  const refresh = panel.getByRole('button', { name: 'Refresh', exact: true })
  assert.equal(await refresh.textContent(), 'Refresh')
  assert.equal(await refresh.locator('svg').count(), 1)
  assert.equal(await refresh.evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)')
  await refresh.click()
  await page.waitForFunction(() => window.forcedRefresh?.provider === 'grok' && window.forcedRefresh?.account === 'grok')
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

  // Overflow controls must describe real actions rather than decorative chevrons.
  // An unavailable direction may be hidden or disabled, but must not be actionable.
  const narrow = await setup(280)
  await narrow.evaluate(() => window.releaseStatus())
  await tab(narrow, 'Alpha').waitFor()
  const list = narrow.getByRole('tablist')
  const left = narrow.getByRole('button', { name: 'Scroll providers left', exact: true })
  const right = narrow.getByRole('button', { name: 'Scroll providers right', exact: true })
  async function available(control) {
    return await control.isVisible() && await control.isEnabled()
  }
  async function waitState(wantLeft, wantRight) {
    await narrow.waitForFunction(([l, r]) => {
      const buttons = [...document.querySelectorAll('button')]
      const usable = name => {
        const el = buttons.find(button => button.getAttribute('aria-label') === name)
        if (!el) return false
        const style = getComputedStyle(el), rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
      }
      return usable('Scroll providers left') === l && usable('Scroll providers right') === r
    }, [wantLeft, wantRight])
    assert.equal(await available(left), wantLeft)
    assert.equal(await available(right), wantRight)
  }
  async function scrollToFraction(fraction) {
    await list.evaluate((el, value) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) * value }, fraction)
  }
  async function fullyVisible(name, focused = false) {
    const target = tab(narrow, name)
    await narrow.waitForFunction(label => {
      const strip = document.querySelector('[role="tablist"]')
      const item = [...strip.querySelectorAll('[role="tab"]')].find(el => el.textContent.trim() === label)
      const a = strip.getBoundingClientRect(), b = item.getBoundingClientRect()
      return b.left >= a.left - 1 && b.right <= a.right + 1
    }, name)
    const details = await target.evaluate(el => {
      const style = getComputedStyle(el), range = document.createRange()
      range.selectNodeContents(el)
      const box = el.getBoundingClientRect(), text = range.getBoundingClientRect()
      const strip = el.closest('[role="tablist"]').getBoundingClientRect()
      const outset = Math.max(0, parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth))
      return { focused: el === document.activeElement, focusVisible: el.matches(':focus-visible'),
        ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)',
        ringFits: box.left - outset >= strip.left - 1 && box.right + outset <= strip.right + 1 &&
          box.top - outset >= strip.top - 1 && box.bottom + outset <= strip.bottom + 1,
        textFits: text.left >= box.left - 1 && text.right <= box.right + 1,
        noEllipsis: style.textOverflow !== 'ellipsis', noWrap: style.whiteSpace === 'nowrap' }
    })
    assert.ok(details.textFits && details.noEllipsis && details.noWrap, name + ' label is not truncated or wrapped')
    if (focused) assert.ok(details.focused && details.focusVisible && details.ring && details.ringFits,
      name + ' has an unclipped visible keyboard focus ring')
    await selected(narrow, name)
    const styles = await narrow.getByRole('tab').evaluateAll(els => els.map(el => {
      const css = getComputedStyle(el)
      return { selected: el.getAttribute('aria-selected') === 'true', background: css.backgroundColor,
        border: css.borderColor, weight: css.fontWeight }
    }))
    const active = styles.find(style => style.selected), other = styles.find(style => !style.selected)
    assert.ok(active.background !== other.background || active.border !== other.border || active.weight !== other.weight,
      name + ' has a visible selected style')
  }
  const sizes = await list.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  assert.ok(sizes.scroll > sizes.client, 'narrow provider strip overflows')
  await scrollToFraction(0)
  await waitState(false, true)
  assert.equal(await right.evaluate(el => el.tagName), 'BUTTON', 'right chevron is a native button')
  await right.click()
  await narrow.waitForFunction(() => document.querySelector('[role="tablist"]').scrollLeft > 0)
  await selected(narrow, 'Alpha') // Scrolling must not change selection.
  await scrollToFraction(0.5)
  await waitState(true, true)
  assert.equal(await left.evaluate(el => el.tagName), 'BUTTON', 'left chevron is a native button')
  await scrollToFraction(1)
  await waitState(true, false)
  await left.focus()
  await narrow.keyboard.press('Enter')
  await narrow.waitForFunction(() => {
    const el = document.querySelector('[role="tablist"]')
    return el.scrollLeft < el.scrollWidth - el.clientWidth - 1
  })
  await selected(narrow, 'Alpha')

  // Native horizontal scroll events also update the controls, not only clicks.
  await scrollToFraction(0)
  await waitState(false, true)
  await list.hover()
  await narrow.mouse.wheel(100, 0)
  await narrow.waitForFunction(() => document.querySelector('[role="tablist"]').scrollLeft > 0)
  await waitState(true, true)
  await selected(narrow, 'Alpha')

  // Automatic activation, roving focus, wraparound and Home/End reveal each tab.
  await left.focus()
  await narrow.keyboard.press('Tab')
  assert.equal(await tab(narrow, 'Alpha').evaluate(el => el === document.activeElement), true,
    'Tab reaches the selected roving tab from the preceding chevron')
  assert.equal(await narrow.getByRole('tab').evaluateAll(els => els.filter(el => el.tabIndex === 0).length), 1)
  await narrow.keyboard.press('End')
  await fullyVisible('Grok (X Premium)', true)
  await waitState(true, false)
  await narrow.keyboard.press('ArrowRight')
  await fullyVisible('Alpha', true)
  await narrow.keyboard.press('ArrowLeft')
  await fullyVisible('Grok (X Premium)', true)
  await narrow.keyboard.press('Home')
  await fullyVisible('Alpha', true)
  await narrow.keyboard.press('ArrowRight')
  await fullyVisible('Zulu', true)
  for (const name of ['GitHub Copilot', 'Google Antigravity', 'Grok (X Premium)']) {
    await narrow.keyboard.press('ArrowRight')
    await fullyVisible(name, true)
  }
  await narrow.keyboard.press('Home')
  await narrow.keyboard.press('ArrowRight')
  await fullyVisible('Zulu', true)
  await settingsVisible(narrow)

  // Resize without remounting: controls and selected tab must remain correct.
  await narrow.setViewportSize({ width: 900, height: 900 })
  await waitState(false, false)
  assert.equal(await list.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'wide provider strip fits')
  await fullyVisible('Zulu', true)
  // Select the last tab while wide, then shrink so it must scroll back into view.
  await tab(narrow, 'Grok (X Premium)').click()
  await narrow.setViewportSize({ width: 280, height: 900 })
  await narrow.waitForFunction(() => {
    const el = document.querySelector('[role="tablist"]')
    return el.scrollWidth > el.clientWidth
  })
  await fullyVisible('Grok (X Premium)')
  // Clicking the right chevron repeatedly from the start must reach the end even when
  // a single tab (e.g. Google Antigravity) is wider than viewport - 2 * EDGE.
  await scrollToFraction(0)
  await waitState(false, true)
  for (let steps = 0; steps < 10 && await available(right); steps++) {
    const before = await list.evaluate(el => el.scrollLeft)
    await right.click()
    await narrow.waitForFunction(prev => document.querySelector('[role="tablist"]').scrollLeft > prev, before)
  }
  await waitState(true, false)
  for (let steps = 0; steps < 10 && await available(left); steps++) {
    const before = await list.evaluate(el => el.scrollLeft)
    await left.click()
    await narrow.waitForFunction(prev => document.querySelector('[role="tablist"]').scrollLeft < prev, before)
  }
  await waitState(false, true)
  // Logging in on a disconnected tab at the far right reorders it into the connected group;
  // the tab strip must keep the active tab visible without manual scrolling.
  await tab(narrow, 'Grok (X Premium)').click()
  await fullyVisible('Grok (X Premium)')
  await narrow.locator('[role="tabpanel"]').filter({ visible: true }).getByRole('button', { name: 'Log in', exact: true }).click()
  await narrow.waitForFunction(() => document.querySelectorAll('[role=tab]')[1]?.textContent?.includes('Grok'))
  await fullyVisible('Grok (X Premium)')
  await narrow.close()
  assert.deepEqual(errors, [])
  console.log('Provider tabs browser checks passed')
} finally {
  await browser.close()
}
