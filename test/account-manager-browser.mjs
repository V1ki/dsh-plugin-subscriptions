// Optional standalone UI check. No live server or real account settings used.
// PLAYWRIGHT_PATH=/path/to/playwright node test/account-manager-browser.mjs
import assert from 'node:assert/strict'
import { readdir, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => resolve('node_modules/.pnpm', dependencies.find(entry => entry.startsWith(`${name}@`)), 'node_modules', name)
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/account-manager-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  output: { format: 'iife' },
  write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(`<style>:root{--dsw-alias-border-l2:#dedee6;--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#20212b;--dsw-alias-label-tertiary:#626575;--dsw-alias-state-error-primary:#b42318}body{background:#f4f5f9;font:14px system-ui}dialog::backdrop{background:#10132966}input[type=checkbox]{accent-color:#5369dc}</style><div id="root"></div>`)
  await page.addScriptTag({ content: code })
  const open = async () => { await page.getByRole('button', { name: 'Manage', exact: true }).click(); await page.getByRole('dialog').waitFor() }
  await open()
  const personal = page.getByRole('group', { name: 'personal@example.com', exact: true })
  assert.equal(await personal.getByLabel('Include in the LLM account pool').isChecked(), true)
  assert.equal(await personal.getByLabel('Show an independent entry').isChecked(), false)
  await personal.getByLabel('Alias (optional)').fill('Personal')
  await personal.getByLabel('Include in the LLM account pool').uncheck()
  await personal.getByLabel('Show an independent entry').check()
  await personal.locator('summary').click()
  await personal.getByRole('button', { name: 'Clear selection' }).click()
  await page.evaluate(() => { window.settings.visibleModels = ['new-model']; window.failSave = true })
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('alert').filter({ hasText: 'Simulated save failure' }).waitFor()
  assert.equal(await personal.getByLabel('Alias (optional)').inputValue(), 'Personal')
  await page.evaluate(() => { window.failSave = false })
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.saved[0]), {
    visibleModels: ['new-model'], accounts: { personal: { alias: 'Personal', poolEnabled: false, independentEntry: true, poolModels: [] } },
  })
  assert.equal(await page.getByRole('button', { name: 'Manage', exact: true }).evaluate(el => el === document.activeElement), true)
  await open()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: 'Manage', exact: true }).evaluate(el => el === document.activeElement), true)
  await open()
  await personal.locator('summary').click()
  await personal.getByLabel('Allow all models').check()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => 'poolModels' in window.saved[1].accounts.personal), false)
  await open()
  await personal.locator('summary').click()
  await personal.getByLabel('Beta', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.saved[2].accounts.personal.poolModels), ['alpha'])
  await open()
  await personal.locator('summary').click()
  await mkdir('output', { recursive: true })
  await page.setViewportSize({ width: 900, height: 1100 })
  // Capture the final healthy bilingual preview after the interaction checks.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement === document.body || document.querySelector('dialog').contains(document.activeElement)), true)
  }
  await page.setViewportSize({ width: 360, height: 720 })
  assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.evaluate(() => { window.locale = 'zh' })
  await open()
  await page.getByRole('heading', { name: '管理 Codex (ChatGPT) 账号' }).waitFor()
  assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.evaluate(() => {
    window.preview = true
    window.settings = { accounts: {
      personal: { alias: '个人账号', poolEnabled: true, independentEntry: false },
      work: { alias: '工作专用', poolEnabled: false, independentEntry: true, poolModels: ['gpt-5.4'] },
    } }
  })
  await page.setViewportSize({ width: 900, height: 1100 })
  await open()
  await personal.locator('summary').click()
  await page.screenshot({ path: 'output/account-manager-preview.png' })
  assert.deepEqual(errors, [])
  console.log('Account-manager browser checks passed: defaults, strict selection, failed-save retry, fresh-settings merge, Escape/focus containment and restoration, responsive width.')
} finally { await browser.close() }
