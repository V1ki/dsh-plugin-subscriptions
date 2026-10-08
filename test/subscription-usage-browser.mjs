// Optional offline UI check: PLAYWRIGHT_PATH=/path/to/playwright node test/subscription-usage-browser.mjs
// No running DSH server, real accounts, credentials, screenshots or model writes.
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => resolve('node_modules/.pnpm', dependencies.find(entry => entry.startsWith(`${name}@`)), 'node_modules', name)
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/subscription-usage-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{ name: 'test-css', load(id) { return id.endsWith('.css') ? 'export default {}' : null } }],
  output: { format: 'iife' }, write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: route.request().url().endsWith('/app.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
    body: route.request().url().endsWith('/app.js') ? code : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>' }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await page.goto('http://subscription-usage.test/')
  const control = page.getByRole('combobox', { name: 'Status-bar quota display', exact: true })
  const badge = page.locator('[data-composer-stats] button')
  const title = 'Subscription usage'
  const panel = page.getByRole('dialog', { name: title, exact: true })
  await control.waitFor()
  await page.waitForFunction(() => Number(document.documentElement.dataset.modelReads) >= 2)
  assert.equal(await badge.count(), 0, 'no unrelated provider without view history')
  const choose = async (name, provider) => {
    const reads = await page.evaluate(() => Number(document.documentElement.dataset.modelReads))
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForFunction(({ reads, provider }) => Number(document.documentElement.dataset.modelReads) > reads && document.documentElement.dataset.lastRead === provider, { reads, provider })
  }
  for (const [name, provider, expected] of [
    ['codex', 'codex', 'Codex'], ['api', 'deepseek', 'Codex'],
    ['grok', 'grok', 'Grok'], ['api', 'deepseek', 'Grok'],
    ['antigravity', 'antigravity', 'Antigravity'], ['api', 'deepseek', 'Antigravity'],
  ]) {
    await choose(name, provider)
    await badge.waitFor()
    assert.equal(await badge.count(), 1)
    assert.match(await badge.innerText(), new RegExp(`^${expected} .*%`))
    assert.equal((await badge.innerText()).includes('|'), false)
  }
  await choose('grok', 'grok')
  await page.getByRole('button', { name: 'Rename Grok', exact: true }).click()
  assert.match(await badge.innerText(), /^我的 Grok /)
  await badge.click()
  await panel.waitFor()
  assert.match(await panel.locator('section').first().innerText(), /^我的 Grok/)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Reset Grok', exact: true }).click()
  assert.match(await badge.innerText(), /^Grok /)
  await choose('antigravity', 'antigravity')
  await choose('api', 'deepseek')
  console.log('40%: current/recent single-provider selection verified')
  await badge.click()
  await panel.waitFor()
  const anti = panel.locator('section').filter({ hasText: 'Antigravity' })
  // The dialog follows the retained subscription the badge shows: first, with
  // its model previewed, but not tagged current while an API model is selected.
  assert.match(await panel.locator('section').first().innerText(), /^Antigravity/)
  assert.equal(await anti.getByText('current', { exact: true }).count(), 0)
  assert.equal(await anti.locator('dt:visible').count(), 1)
  assert.match(await anti.locator('dt:visible').innerText(), /gemini-model-29/)
  await anti.locator('summary').click()
  assert.equal(await anti.locator('dt:visible').count(), 30)
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  await choose('antigravity', 'antigravity')
  await badge.click()
  await panel.waitFor()
  assert.equal(await anti.locator('dt:visible').count(), 1)
  assert.match(await anti.locator('dt:visible').innerText(), /gemini-model-29/)
  // Change the preference from a second tab while the quota dialog is open.
  const other = await context.newPage()
  await other.goto('http://subscription-usage.test/')
  const otherControl = other.getByRole('combobox', { name: 'Status-bar quota display', exact: true })
  await otherControl.selectOption('hidden')
  await badge.waitFor({ state: 'detached' })
  await panel.waitFor({ state: 'detached' })
  assert.equal(await control.inputValue(), 'hidden')
  await page.reload()
  await control.waitFor()
  assert.equal(await control.inputValue(), 'hidden')
  await choose('codex', 'codex')
  assert.equal(await badge.count(), 0)
  // A page that loads hidden never asks for usage; showing it refreshes at once.
  assert.equal(await page.evaluate(() => document.documentElement.dataset.statusCalls), undefined)
  await control.selectOption('recent')
  await badge.waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0, 'unhiding does not reopen the previous dialog')
  await page.waitForFunction(() => localStorage.getItem('dsh.subscriptions.usageBadgeMode') === 'recent')
  console.log('70%: compact Antigravity, cross-tab hiding and persisted preference verified')
  await page.evaluate(() => {
    window.savedSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'dsh.subscriptions.usageBadgeMode') throw new DOMException('full', 'QuotaExceededError')
      return window.savedSetItem.call(this, key, value)
    }
  })
  await control.selectOption('hidden')
  await page.getByRole('alert').waitFor()
  assert.equal(await control.inputValue(), 'recent')
  assert.equal(await badge.count(), 1)
  await page.evaluate(() => { Storage.prototype.setItem = window.savedSetItem })
  await control.selectOption('hidden')
  await page.getByRole('alert').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Locale', exact: true }).click()
  await page.getByRole('combobox', { name: '状态栏额度显示', exact: true }).waitFor()
  await page.setViewportSize({ width: 360, height: 720 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.deepEqual(errors, [])
  console.log('100%: offline badge browser checks passed, including storage errors and bilingual setting')
} finally { await browser.close() }
