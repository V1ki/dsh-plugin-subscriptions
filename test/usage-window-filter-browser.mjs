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
  await page.getByText('Window · gemini-3-flash', { exact: true }).waitFor()
  assert.deepEqual(await rows.allTextContents(), ['Window · gemini-3-flash', 'Weekly · gemini-3-flash'])
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
  await page.getByText('Window · claude-sonnet-4-6', { exact: true }).waitFor()
  assert.deepEqual(await rows.allTextContents(), ['Window · claude-sonnet-4-6'])
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
} finally {
  await browser.close()
}
