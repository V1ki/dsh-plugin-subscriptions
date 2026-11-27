// Optional offline UI check: PLAYWRIGHT_PATH=/path/to/playwright node test/compact-quota-browser.mjs
// No running DSH server, real accounts, credentials, screenshots or model writes.
import assert from 'node:assert/strict'
import { choosePreference } from './preference-menu-browser.mjs'
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
  await page.goto('http://subscription-usage.test/?budget=1')
  page.setDefaultTimeout(12000)
  const badge = page.locator('[data-composer-stats] button')
  const choose = async (name, provider) => {
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForFunction(provider => document.documentElement.dataset.lastRead === provider, provider)
  }
  await choose('codex', 'codex')
  const style = page.getByRole('button', { name: 'Status-bar style', exact: true })
  const quota = page.getByRole('button', { name: 'Quota percentages', exact: true })
  await choosePreference(style, 'compact')
  await badge.locator('[data-subscription-quota-row="session"]').waitFor()
  assert.match(await badge.innerText(), /^Codex/)
  const fill = badge.locator('[data-subscription-quota-fill="session"]')
  const marker = badge.locator('[data-subscription-budget-target="session"]')
  assert.equal(await fill.getAttribute('data-subscription-quota-displayed'), '13')
  await marker.waitFor()
  const tone = await marker.getAttribute('data-subscription-budget-tone')
  const usedTarget = Number(await marker.getAttribute('data-subscription-budget-displayed'))
  await choosePreference(quota, 'remaining')
  assert.equal(await fill.getAttribute('data-subscription-quota-displayed'), '87')
  assert.equal(await marker.getAttribute('data-subscription-budget-tone'), tone)
  assert.ok(Math.abs(Number(await marker.getAttribute('data-subscription-budget-displayed')) + usedTarget - 100) <= 1)
  assert.match(await badge.getAttribute('title'), /87% remaining/)
  await choosePreference(quota, 'used')
  await choosePreference(style, 'text')
  await choosePreference(style, 'compact')
  await page.getByRole('button', { name: 'Locale', exact: true }).click()
  assert.match(await badge.getAttribute('title'), /预算目标/)
  assert.doesNotMatch(await badge.getAttribute('title'), /linear target|% remaining/)
  await choose('api', 'deepseek')
  await badge.waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log('PASS: compact provider identity, quota direction, invariant risk tone, localized tooltip and non-subscription hiding')
} finally { await browser.close() }
