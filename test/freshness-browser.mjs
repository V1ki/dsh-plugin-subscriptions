// Real controller + tracker + registered JSON RPC routes; synthetic usage fetchers only.
// pnpm exec tsc -p tsconfig.test.json
// PLAYWRIGHT_PATH=/path/to/playwright node test/freshness-browser.mjs
import assert from 'node:assert/strict'
import { readdir, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'subscriptions-freshness-home-'))
delete process.env.DSH_PROFILE_DIR
const { Context } = await import('@deepseek-ai/cordis')
const { SubscriptionsAuthController } = await import('../lib-test/src/index.js')
const { PoolUsageTracker } = await import('../lib-test/src/providers/pool-usage.js')
const { OAuthEndpointError } = await import('../lib-test/src/providers/common.js')
const { OAuthFlowManager } = await import('../lib-test/src/auth/oauth-flow.js')
const { DeviceFlowManager } = await import('../lib-test/src/auth/device-flow.js')
const { registerAuthRpc } = await import('../lib-test/src/auth/rpc.js')
const { createFakeConnection } = await import('../lib-test/test/fake-connection.js')
const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => resolve('node_modules/.pnpm', dependencies.find(entry => entry.startsWith(`${name}@`)), 'node_modules', name)
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/freshness-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } },
  plugins: [{ name: 'test-css', load(id) { return id.endsWith('.css') ? 'export default {}' : null } }],
  output: { format: 'iife' }, write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
const browser = await chromium.launch({ headless: true })
const evidence = []
try {
  for (const scenario of ['modern', 'no-pool', 'legacy', 'unsupported', 'empty-legacy', 'failure', 'legacy-cache', 'stale-recovery', 'multiple']) {
    let fetches = 0
    let failNow = false
    const requests = []
    const fetchUsage = async account => {
      assert.ok(['account-a', 'account-b'].includes(account))
      fetches++
      if (scenario === 'failure' || failNow) throw new OAuthEndpointError('Synthetic offline failure', 429, undefined, scenario === 'stale-recovery' ? 2000 : 60_000)
      return { supported: true, windows: scenario === 'empty-legacy' ? [] : [{ kind: 'weekly', usedPercent: account === 'account-a' ? 28 : 73 }] }
    }
    const tracker = new PoolUsageTracker((provider, account) => provider === 'codex' && scenario !== 'unsupported' ? () => fetchUsage(account) : undefined)
    class Controller extends SubscriptionsAuthController {
      async status(provider) {
        return { busy: false, accounts: provider === 'codex' ? [{ key: 'account-a', account: 'A (synthetic)', isDefault: true }, ...(scenario === 'multiple' ? [{ key: 'account-b', account: 'B (synthetic)', isDefault: false }] : [])] : [] }
      }
      async usage(...args) {
        const usage = await super.usage(...args)
        if (scenario.endsWith('legacy') || scenario.startsWith('legacy')) {
          // Reproduce the pre-#203 wire contract, not a frontend mock.
          const { fetchedAt, staleAt, stale, refreshFailed, retryAt, ...legacy } = usage
          return legacy
        }
        return usage
      }
    }
    const controller = new Controller(new OAuthFlowManager(), new DeviceFlowManager(), () => {}, () => undefined,
      { codex: fetchUsage }, () => undefined, scenario === 'no-pool' ? undefined : tracker)
    const fake = createFakeConnection()
    const ctx = new Context()
    ctx.provide('connection', fake.connection)
    registerAuthRpc(ctx, controller, {}, { get: () => ({ enabled: false, url: '', bypass: [], passwordSet: false }) })
    const context = await browser.newContext()
    const errors = []
    await context.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/')) {
        const { method, payload } = route.request().postDataJSON()
        const result = await fake.handler(method.replace('subscriptions-auth.', ''), payload, new AbortController().signal)
        if (method.endsWith('.usage')) requests.push({ ...payload, result })
        await route.fulfill({ json: { type: 'server-response', rpcId: 'browser-test', result } })
      } else await route.fulfill({ contentType: path === '/app.js' ? 'text/javascript' : 'text/html',
        body: path === '/app.js' ? code : '<meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>' })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://freshness.test/')
    const card = page.getByText('Codex (ChatGPT)', { exact: true }).locator('xpath=../..')
    await page.getByText('A (synthetic)', { exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('button[disabled]'))
    const accountA = card.getByText('A (synthetic)', { exact: true }).locator('xpath=../..')
    const refresh = accountA.getByRole('button', { name: 'Refresh', exact: true })
    if (scenario === 'legacy-cache' || scenario === 'stale-recovery') failNow = true
    if (scenario !== 'unsupported') {
      await refresh.waitFor()
      const count = requests.length
      await refresh.click()
      await page.waitForFunction(() => !document.querySelector('button[disabled]'))
      assert.ok(requests.slice(count).some(request => request.force === true && request.account === 'account-a' && request.provider === 'codex'))
    }
    const badge = page.locator('[data-composer-stats] button')
    await badge.click()
    const panel = page.getByRole('dialog', { name: 'Subscription usage', exact: true })
    await panel.waitFor()
    const cardText = await card.innerText()
    const panelText = await panel.innerText()
    const last = requests.at(-1).result
    evidence.push({ scenario, fetches, forced: requests.filter(x => x.force).length,
      response: last, settingsUnknown: cardText.includes('Freshness unknown'), badgeUnknown: panelText.includes('Freshness unknown'),
      settingsText: cardText, badgeText: panelText })
    if (scenario === 'modern' || scenario === 'no-pool') {
      assert.ok(last.value.fetchedAt > 0)
      assert.match(cardText, /Fetched:/)
      assert.match(panelText, /Fetched:/)
      assert.doesNotMatch(cardText + panelText, /Freshness unknown/)
      assert.ok(fetches >= 2, 'manual refresh reaches synthetic upstream')
    } else if (scenario === 'failure') {
      assert.equal(fetches, 1, 'force never bypasses endpoint cooldown')
      assert.match(cardText, /Usage lookup failed/)
      assert.match(panelText, /Quota refresh failed; no previous quota data/)
    } else if (scenario.startsWith('legacy')) {
      assert.match(cardText, /Response received:/)
      assert.match(panelText, /Response received:/)
      assert.match(cardText + panelText, /quota update time was not provided/)
      assert.doesNotMatch(cardText + panelText, /Fetched:|Freshness unknown/)
      assert.equal(last.value.fetchedAt, undefined, 'do not invent server timestamps')
      if (scenario === 'legacy-cache') assert.equal(fetches, 2, 'old backend silently returns last snapshot during cooldown')
    } else if (scenario === 'unsupported') {
      assert.equal(fetches, 0)
      assert.match(cardText, /Quota queries are not supported/)
      assert.match(panelText, /Quota queries are not supported/)
      assert.doesNotMatch(cardText + panelText, /Freshness unknown|Response received:/)
    } else if (scenario === 'empty-legacy') {
      assert.match(cardText, /No usage windows reported/)
      assert.match(panelText, /No usage windows reported/)
      assert.doesNotMatch(cardText + panelText, /Freshness unknown|Response received:/)
    } else if (scenario === 'stale-recovery') {
      assert.equal(fetches, 2)
      const first = requests.find(request => request.result.ok).result.value
      assert.equal(last.value.fetchedAt, first.fetchedAt)
      assert.equal(last.value.refreshFailed, true)
      assert.match(cardText + panelText, /Last known usage; refresh unavailable/)
      await page.keyboard.press('Escape')
      const before = fetches
      await refresh.click()
      await page.waitForFunction(() => !document.querySelector('button[disabled]'))
      assert.equal(fetches, before, 'second force cannot bypass failure cooldown')
      failNow = false
      await page.waitForTimeout(Math.max(0, last.value.retryAt - Date.now()) + 20)
      await refresh.click()
      await page.waitForFunction(() => !document.querySelector('button[disabled]'))
      await badge.click()
      await panel.waitFor()
      assert.doesNotMatch(await panel.innerText(), /refresh unavailable|Freshness unknown/)
      assert.ok(requests.at(-1).result.value.fetchedAt > first.fetchedAt)
    } else if (scenario === 'multiple') {
      assert.match(await badge.innerText(), /2 signed-in accounts/)
      assert.match(panelText, /A \(synthetic\)/)
      assert.match(panelText, /B \(synthetic\)/)
      assert.match(panelText, /28% used/)
      assert.match(panelText, /73% used/)
      assert.equal(requests.filter(request => request.force).length, 1)
      assert.equal(requests.find(request => request.force).account, 'account-a')
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log(JSON.stringify(evidence, null, 2))
} finally { await browser.close() }
