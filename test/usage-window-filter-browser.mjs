// Offline UI regression: PLAYWRIGHT_PATH=/path/to/playwright node test/usage-window-filter-browser.mjs
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => resolve('node_modules/.pnpm', dependencies.find(entry => entry.startsWith(`${name}@`)), 'node_modules', name)
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/usage-window-filter-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  output: { format: 'iife' }, write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.fulfill({ status: 200,
    contentType: route.request().url().endsWith('/app.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('/app.js') ? code : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>',
  }))
  await page.goto('http://usage-window-filter.test/')
  const rows = page.getByText(/^(Window|Weekly) · /)
  await page.getByText('Window · gemini-3-flash-high', { exact: true }).waitFor()
  assert.deepEqual(await rows.allTextContents(), ['Window · gemini-3-flash-high', 'Weekly · gemini-3-flash-high'])
  const dialog = page.getByRole('dialog', { name: 'Manage Google Antigravity', exact: true })
  const open = async () => {
    await page.getByRole('button', { name: 'Manage', exact: true }).last().click()
    await dialog.getByRole('checkbox', { name: 'Gemini Flash', exact: true }).waitFor()
  }
  const save = async () => {
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  await open()
  await dialog.getByRole('checkbox', { name: 'Gemini Flash', exact: true }).uncheck()
  await dialog.getByRole('checkbox', { name: 'Claude Sonnet', exact: true }).check()
  await save()
  await page.getByText('Window · claude-sonnet-4-6-low', { exact: true }).waitFor()
  assert.deepEqual(await rows.allTextContents(), ['Window · claude-sonnet-4-6-low'])
  await open()
  await dialog.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await save()
  await page.getByText('No quota windows match the selected models.', { exact: true }).waitFor()
  assert.equal(await rows.count(), 0)
  await open()
  await dialog.getByRole('checkbox', { name: 'Automatically show all models, including new models', exact: true }).check()
  await save()
  await page.getByText('Window · tab_jump_flash_lite_preview', { exact: true }).waitFor()
  assert.equal(await rows.count(), 4)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.usageCalls), '1', 'saving must re-filter cached raw usage without quota refetch')
  assert.deepEqual(errors, [])
  console.log('PASS: initial filtering, save synchronization, empty selection, automatic visibility, unchanged raw quotas')
  await page.goto('http://usage-window-filter.test/?summary=1')
  await page.getByRole('region', { name: 'Gemini Models', exact: true }).waitFor()
  assert.equal(await page.getByRole('progressbar').count(), 5)
  assert.equal(await page.getByRole('region', { name: 'Claude and GPT models', exact: true }).count(), 1)
  assert.equal(await page.getByRole('region', { name: 'Gemini 4 Argon', exact: true }).count(), 1)
  assert.equal(await page.getByText('1% used', { exact: true }).count(), 2)
  assert.equal(await page.getByText('0% used', { exact: true }).count(), 2)
  assert.equal(await page.getByText('33% used', { exact: true }).count(), 1)
  await page.getByRole('combobox', { name: 'Quota percentages', exact: true }).selectOption('remaining')
  assert.equal(await page.getByText('99% remaining', { exact: true }).count(), 2)
  assert.equal(await page.getByText('100% remaining', { exact: true }).count(), 2)
  assert.equal(await page.getByText('67% remaining', { exact: true }).count(), 1)
  assert.equal(await page.getByText('Weekly limit', { exact: true }).count(), 3)
  assert.equal(await page.getByText('5h limit', { exact: true }).count(), 2)
  assert.equal(await page.getByText(/tab_jump|chat_23310/).count(), 0)
  await page.setViewportSize({ width: 380, height: 950 })
  const grouped = page.getByRole('region', { name: 'Gemini Models', exact: true }).locator('..')
  assert.ok(await grouped.evaluate(el => el.scrollWidth <= el.clientWidth), 'quota block fits a narrow settings view')
  await page.addStyleTag({ content: ':root { --dsw-alias-label-secondary:#a3a3a3; --dsw-alias-label-tertiary:#939393; --dsw-alias-border-l2:#555; --dsw-alias-state-success-primary:#6fa65a; } body { background:#292929; color:#eee; font:13px Arial,sans-serif; }' })
  if (process.env.QUOTA_SCREENSHOT) await grouped.screenshot({ path: process.env.QUOTA_SCREENSHOT })
  await open()
  await dialog.getByRole('checkbox', { name: 'Gemini Flash', exact: true }).uncheck()
  await save()
  await page.getByRole('region', { name: 'Gemini Models', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('region', { name: 'Gemini 4 Argon', exact: true }).count(), 0)
  assert.equal(await page.getByRole('progressbar').count(), 2)
  assert.equal(await page.getByRole('region', { name: 'Claude and GPT models', exact: true }).count(), 1)
  assert.deepEqual(errors, [])
  console.log('PASS: provider-defined quota groups, five remaining indicators, narrow layout and immediate visibility updates')
} finally {
  await browser.close()
}
