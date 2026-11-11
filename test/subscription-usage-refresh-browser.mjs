// Optional offline UI check of the status-bar click refresh:
//   PLAYWRIGHT_PATH=/path/to/playwright node test/subscription-usage-refresh-browser.mjs
// No running DSH server, real accounts, credentials, screenshots or model writes.
// The 60 s forced-interval rule is pinned exhaustively by
// test/usage-refresh.spec.ts. Here, on the real-time page, every click after the
// first falls inside that interval and must re-read plainly; one extra page with
// Playwright's clock checks the poll timer and the 59 s / 60 s boundary end to end.
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => resolve('node_modules/.pnpm', dependencies.find(entry => entry.startsWith(`${name}@`)), 'node_modules', name)
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/subscription-usage-refresh-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{ name: 'test-css', load(id) { return id.endsWith('.css') ? 'export default {}' : null } }],
  output: { format: 'iife' }, write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
/** Every logged-in account the fixture's `status` RPC lists. */
const ACCOUNTS = [['claude', 'claude-a'], ['codex', 'codex-a'], ['codex', 'codex-b']]
const forcedPayloads = ACCOUNTS.map(([provider, account]) => ({ provider, account, force: true, resetPoolHealth: false }))
const plainPayloads = ACCOUNTS.map(([provider, account]) => ({ provider, account }))
const byAccount = (a, b) => `${a.provider}/${a.account}`.localeCompare(`${b.provider}/${b.account}`)
const failedText = message => `Refresh failed: ${message}. Showing the last known values.`
const failedTextZh = message => `刷新失败：${message}。显示上次获取的数值。`
const SETTLE_MS = 300

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: route.request().url().endsWith('/app.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
    body: route.request().url().endsWith('/app.js') ? code : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>' }))
  const errors = []
  const open = async (url) => {
    const page = await context.newPage()
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.goto(url)
    return page
  }

  const page = await open('http://subscription-usage.test/')
  const badge = page.locator('[data-composer-stats] button')
  const panel = page.getByRole('dialog', { name: 'Subscription usage', exact: true })
  const fixture = (script, arg) => page.evaluate(script, arg)
  const callCount = () => fixture(() => usageFixture.calls.length)
  /** RPC calls recorded since `mark`, split by endpoint. */
  const callsSince = async mark => {
    const calls = await fixture(mark => usageFixture.calls.slice(mark), mark)
    return { status: calls.filter(c => c.endpoint === 'status').length, usage: calls.filter(c => c.endpoint === 'usage').map(c => c.payload).sort(byAccount) }
  }
  const state = () => badge.getAttribute('data-refresh-state')
  const waitState = expected => page.waitForFunction(expected => document.querySelector('[data-composer-stats] button')?.getAttribute('data-refresh-state') === expected, expected)
  /** Click the pill and wait until the refresh it started (one round, all accounts) has finished. */
  const clickAndSettle = async (expected) => {
    const mark = await callCount()
    await badge.click()
    await page.waitForFunction(({ mark, n }) => usageFixture.calls.slice(mark).filter(c => c.endpoint === 'usage').length >= n || usageFixture.calls.slice(mark).some(c => c.endpoint === 'status' && usageFixture.failStatus !== undefined), { mark, n: ACCOUNTS.length })
    await waitState(expected)
    return mark
  }

  // Mount: one background poll, never forced (R1).
  await badge.waitFor()
  await waitState('idle')
  // Single-account provider: the pill carries the default account's windows.
  assert.equal(await badge.innerText(), 'Claude · Default account 5h 19% used · Wk 5% used')
  let since = await callsSince(0)
  assert.equal(since.status, 1, 'mount polls once')
  assert.deepEqual(since.usage, plainPayloads, 'background poll: every account, no force key')
  assert.equal(await badge.getAttribute('aria-busy'), null)
  assert.equal(await panel.count(), 0)
  console.log('10%: mount poll is plain and covers every logged-in account')

  // First click while the provider is slow: forced for every account (R1),
  // busy feedback with the last known label (R4), and a second rapid click
  // joins the same round (R2) while still toggling the dialog (R7).
  await fixture(() => { usageFixture.hold = true; usageFixture.percent = 33 })
  let mark = await callCount()
  await badge.click()
  await panel.waitFor()
  await waitState('refreshing')
  assert.equal(await badge.getAttribute('aria-busy'), 'true')
  assert.match(await badge.innerText(), /19%/, 'the label keeps the last known value while refreshing')
  await badge.click()
  await panel.waitFor({ state: 'detached' })
  await page.waitForTimeout(SETTLE_MS)
  since = await callsSince(mark)
  assert.equal(since.status, 1, 'one refresh round for two rapid clicks')
  assert.deepEqual(since.usage, forcedPayloads, 'the click forces every account exactly once')
  assert.equal(await state(), 'refreshing')
  await fixture(() => { usageFixture.hold = false; usageFixture.release() })
  await waitState('idle')
  assert.equal(await badge.getAttribute('aria-busy'), null)
  await page.waitForFunction(() => /33%/.test(document.querySelector('[data-composer-stats] button')?.textContent ?? ''))
  await page.waitForTimeout(SETTLE_MS)
  assert.deepEqual(await callsSince(mark), { status: 1, usage: forcedPayloads }, 'nothing queued behind the forced round')
  console.log('35%: click forces, rapid second click joins, busy state and toggle verified')

  // A click inside the 60 s interval re-reads plainly but still updates (R3).
  await fixture(() => { usageFixture.percent = 41 })
  mark = await clickAndSettle('idle')
  await panel.waitFor()
  since = await callsSince(mark)
  assert.equal(since.status, 1)
  assert.deepEqual(since.usage, plainPayloads, 'within the interval: a plain re-read, no force key')
  await page.waitForFunction(() => /41%/.test(document.querySelector('[data-composer-stats] button')?.textContent ?? ''))
  assert.match(await panel.innerText(), /41%/, 'the open dialog shows the refreshed values')
  console.log('50%: second click inside the interval re-reads without force')

  // Fulfilled stale snapshots are failures too; their values must remain visible.
  await fixture(() => { usageFixture.refreshFailed = true })
  await clickAndSettle('error')
  await panel.waitFor({ state: 'detached' })
  assert.match(await badge.innerText(), /41%/)
  assert.ok((await badge.getAttribute('title') ?? '').includes(failedText('Latest quota unavailable')))
  assert.ok((await badge.getAttribute('aria-label') ?? '').includes(failedText('Latest quota unavailable')))
  await clickAndSettle('error')
  await panel.waitFor()
  assert.match(await panel.innerText(), /41%/)
  assert.ok((await panel.innerText()).includes(failedText('Latest quota unavailable')))
  await fixture(() => { usageFixture.refreshFailed = false })
  await clickAndSettle('idle')
  assert.equal((await badge.getAttribute('title') ?? '').includes('Refresh failed'), false)
  await clickAndSettle('idle') // restore the open dialog for the next scenario

  // A failing usage RPC keeps the last values and reports the failure (R5).
  await fixture(() => { usageFixture.failUsage = 'Rate limited (HTTP 429)' })
  await clickAndSettle('error')
  await panel.waitFor({ state: 'detached' })
  assert.equal(await badge.getAttribute('aria-busy'), null)
  assert.match(await badge.innerText(), /41%/, 'last known values stay on the pill')
  assert.ok((await badge.getAttribute('title') ?? '').includes(failedText('Rate limited (HTTP 429)')), 'title carries the failure')
  assert.ok((await badge.getAttribute('aria-label') ?? '').includes(failedText('Rate limited (HTTP 429)')), 'aria-label carries the failure')
  await clickAndSettle('error')
  await panel.waitFor()
  assert.ok((await panel.innerText()).includes(failedText('Rate limited (HTTP 429)')), 'the open dialog shows the failure')
  assert.match(await panel.innerText(), /41%/, 'the dialog keeps the last known values')
  // Escape still closes the dialog (R7) and does not refresh.
  mark = await callCount()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  await page.waitForTimeout(SETTLE_MS)
  assert.equal(await callCount(), mark, 'Escape closes without a refresh')
  console.log('65%: usage failure keeps the old label and shows the failure in title, aria-label and dialog')

  // A failing status RPC is a failure too (R5).
  await fixture(() => { usageFixture.failUsage = undefined; usageFixture.failStatus = 'Status unavailable' })
  await clickAndSettle('error')
  await panel.waitFor()
  assert.match(await badge.innerText(), /41%/)
  assert.ok((await badge.getAttribute('title') ?? '').includes(failedText('Status unavailable')))
  assert.ok((await panel.innerText()).includes(failedText('Status unavailable')))
  assert.equal((await badge.getAttribute('title') ?? '').includes('Rate limited'), false, 'only the latest failure is shown')

  // The next successful refresh recovers (R5).
  await fixture(() => { usageFixture.failStatus = undefined; usageFixture.percent = 52 })
  await clickAndSettle('idle')
  await panel.waitFor({ state: 'detached' })
  await page.waitForFunction(() => /52%/.test(document.querySelector('[data-composer-stats] button')?.textContent ?? ''))
  assert.equal(await badge.getAttribute('aria-busy'), null)
  assert.equal((await badge.getAttribute('title') ?? '').includes('Refresh failed'), false)
  assert.equal((await badge.getAttribute('aria-label') ?? '').includes('Refresh failed'), false)
  await clickAndSettle('idle')
  await panel.waitFor()
  assert.equal((await panel.innerText()).includes('Refresh failed'), false, 'the dialog drops the failure text')
  // An outside click still closes the dialog (R7) without starting a refresh.
  mark = await callCount()
  await page.getByText('Outside area', { exact: true }).click()
  await panel.waitFor({ state: 'detached' })
  await page.waitForTimeout(SETTLE_MS)
  assert.equal(await callCount(), mark, 'Escape/outside close is not a pill click')
  console.log('80%: status failure and recovery verified; Escape and outside click still close')

  // Localized failure text (zh).
  await page.getByRole('button', { name: 'Locale', exact: true }).click()
  await fixture(() => { usageFixture.failUsage = '限流' })
  await clickAndSettle('error')
  assert.ok((await badge.getAttribute('title') ?? '').includes(failedTextZh('限流')), 'zh title carries the localized failure')
  assert.ok((await badge.getAttribute('aria-label') ?? '').includes(failedTextZh('限流')))
  await fixture(() => { usageFixture.failUsage = undefined })
  await page.getByRole('button', { name: 'Locale', exact: true }).click()

  // A click during a slow background poll queues exactly one forced round
  // that starts after the plain one; more clicks join it (R2). Playwright's
  // clock drives the badge's own timers: the 15-minute poll and Date.now,
  // which also lets the 60 s forced interval be checked end to end (R3).
  const timed = await context.newPage()
  timed.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await timed.clock.install()
  await timed.goto('http://subscription-usage.test/')
  const timedBadge = timed.locator('[data-composer-stats] button')
  const usageCalls = () => timed.evaluate(() => usageFixture.calls.filter(c => c.endpoint === 'usage').map(c => c.payload))
  const usageCallsAtLeast = n => timed.waitForFunction(n => usageFixture.calls.filter(c => c.endpoint === 'usage').length >= n, n)
  const timedState = expected => timed.waitForFunction(expected => document.querySelector('[data-composer-stats] button')?.getAttribute('data-refresh-state') === expected, expected)
  await timedBadge.waitFor()
  await timedState('idle')
  assert.equal((await usageCalls()).length, ACCOUNTS.length, 'mount poll only')
  await timed.evaluate(() => { usageFixture.hold = true })
  await timed.clock.fastForward('15:00')
  await usageCallsAtLeast(2 * ACCOUNTS.length)
  assert.deepEqual((await usageCalls()).slice(ACCOUNTS.length).sort(byAccount), plainPayloads, 'the 15-minute poll is plain')
  await timedState('refreshing')
  assert.match(await timedBadge.innerText(), /19%/, 'the slow poll keeps the last known label')
  await timedBadge.click()
  await timedBadge.click()
  await timedBadge.click()
  await timed.waitForTimeout(SETTLE_MS)
  assert.equal((await usageCalls()).length, 2 * ACCOUNTS.length, 'the forced round waits for the plain one')
  await timed.evaluate(() => usageFixture.release())
  await usageCallsAtLeast(3 * ACCOUNTS.length)
  await timed.waitForTimeout(SETTLE_MS)
  assert.deepEqual((await usageCalls()).slice(2 * ACCOUNTS.length).sort(byAccount), forcedPayloads, 'exactly one queued forced round')
  await timedState('refreshing')
  await timed.evaluate(() => { usageFixture.hold = false; usageFixture.release() })
  await timedState('idle')
  await timed.waitForTimeout(SETTLE_MS)
  assert.equal((await usageCalls()).length, 3 * ACCOUNTS.length, 'no further rounds')
  assert.equal(await timed.getByRole('dialog').count(), 1, 'three clicks toggle the dialog open, closed, open')
  console.log('85%: click during a slow background poll queues one forced round')

  // 60 s boundary measured from that forced start (R3): 59 s → plain, 60 s → forced.
  const clickTimed = async () => {
    const before = (await usageCalls()).length
    await timedBadge.click()
    await usageCallsAtLeast(before + ACCOUNTS.length)
    await timedState('idle')
    return (await usageCalls()).slice(before).sort(byAccount)
  }
  await timed.clock.fastForward('00:59')
  assert.deepEqual(await clickTimed(), plainPayloads, '59 s after the forced start: plain')
  await timed.clock.fastForward('00:01')
  assert.deepEqual(await clickTimed(), forcedPayloads, '60 s after the forced start: forced again')
  await timed.close()
  console.log('90%: forced interval boundary verified with the page clock')

  // A multi-account provider's pill shows only the account count (no
  // percentages); a click still forces every account's usage (R1).
  const multi = await open('http://subscription-usage.test/?provider=codex')
  const multiBadge = multi.locator('[data-composer-stats] button')
  await multiBadge.waitFor()
  await multi.waitForFunction(() => document.querySelector('[data-composer-stats] button')?.getAttribute('data-refresh-state') === 'idle')
  assert.equal(await multiBadge.innerText(), 'Codex · 2 signed-in accounts')
  const multiMark = await multi.evaluate(() => usageFixture.calls.length)
  await multiBadge.click()
  await multi.getByRole('dialog', { name: 'Subscription usage', exact: true }).waitFor()
  await multi.waitForFunction(({ mark, n }) => usageFixture.calls.slice(mark).filter(c => c.endpoint === 'usage').length >= n, { mark: multiMark, n: ACCOUNTS.length })
  await multi.waitForFunction(() => document.querySelector('[data-composer-stats] button')?.getAttribute('data-refresh-state') === 'idle')
  assert.deepEqual((await multi.evaluate(mark => usageFixture.calls.slice(mark).filter(c => c.endpoint === 'usage').map(c => c.payload), multiMark)).sort(byAccount), forcedPayloads)
  await multi.close()
  console.log('95%: multi-account pill shows the account count; click still forces every account')

  // Hidden display mode: no pill and no polling (R7).
  await page.getByRole('combobox', { name: 'Status-bar quota display', exact: true }).selectOption('hidden')
  await badge.waitFor({ state: 'detached' })
  const hidden = await open('http://subscription-usage.test/')
  await hidden.getByRole('combobox', { name: 'Status-bar quota display', exact: true }).waitFor()
  await hidden.waitForTimeout(SETTLE_MS)
  assert.equal(await hidden.locator('[data-composer-stats] button').count(), 0)
  assert.deepEqual(await hidden.evaluate(() => usageFixture.calls), [], 'hidden mode polls nothing')
  assert.deepEqual(errors, [])
  console.log('100%: offline click-refresh browser checks passed')
} finally { await browser.close() }
