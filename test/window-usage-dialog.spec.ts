import './css-hook.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { en, zh, type SubscriptionsKey } from '../src/client/locales.js'
import { ActiveWindowsPanel } from '../src/client/ActiveWindowsPanel.js'
import { ClearUsageHistoryDialog } from '../src/client/ClearUsageHistoryDialog.js'
import { UsageDashboardView } from '../src/client/UsageDashboard.js'
import { UsageNavIcon } from '../src/client/UsageNavIcon.js'
import {
  CLEAR_CONFIRM_OPEN,
  clearConfirmReducer,
  initialUsageDashboardState,
  usageDashboardReducer as reduce,
} from '../src/client/usage-dashboard-state.js'
import {
  buildHeatmapWeeks,
  computeNiceTicks,
  formatCompactTokens,
  formatCycleAxisLabel,
  formatCycleTimeRange,
  formatPercent,
  formatRelativeDuration,
  heatmapLevel,
  quotaProgressTone,
} from '../src/client/usage-format.js'
import type { UsageDashboardResponse } from '../src/usage/usage-dashboard.js'

const { SubscriptionsPage } = await import('../src/client/SubscriptionsPage.js')
const { SubscriptionsSection } = await import('../src/client/SubscriptionsSection.js')

const tEn = (key: SubscriptionsKey, params: Record<string, unknown> = {}) =>
  en[key].replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))

const tZh = (key: SubscriptionsKey, params: Record<string, unknown> = {}) =>
  zh[key].replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))

function sampleResponse(overrides: Partial<UsageDashboardResponse> = {}): UsageDashboardResponse {
  const now = Date.UTC(2026, 10, 23, 2, 0)
  const daily = [
    {
      date: '2026-11-21',
      totalTokens: 1_250_000,
      inputTokens: 200_000,
      outputTokens: 50_000,
      cacheReadTokens: 900_000,
      cacheWriteTokens: 100_000,
      reasoningTokens: 18_000,
      byProvider: { codex: 800_000, claude: 450_000 },
      byModel: [
        {
          provider: 'codex' as const,
          model: 'gpt-5.3-codex',
          totalTokens: 800_000,
          inputTokens: 120_000,
          outputTokens: 30_000,
          cacheReadTokens: 600_000,
          cacheWriteTokens: 50_000,
          reasoningTokens: 12_000,
        },
        {
          provider: 'claude' as const,
          model: 'claude-sonnet-4-6',
          totalTokens: 450_000,
          inputTokens: 80_000,
          outputTokens: 20_000,
          cacheReadTokens: 300_000,
          cacheWriteTokens: 50_000,
          reasoningTokens: 6_000,
        },
      ],
    },
    {
      date: '2026-11-22',
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      byProvider: {},
      byModel: [],
    },
    {
      date: '2026-11-23',
      totalTokens: 2_500_000,
      inputTokens: 400_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_800_000,
      cacheWriteTokens: 200_000,
      reasoningTokens: 42_000,
      byProvider: { claude: 2_500_000 },
      byModel: [
        {
          provider: 'claude' as const,
          model: 'claude-opus-4-6',
          totalTokens: 2_500_000,
          inputTokens: 400_000,
          outputTokens: 100_000,
          cacheReadTokens: 1_800_000,
          cacheWriteTokens: 200_000,
          reasoningTokens: 42_000,
        },
      ],
    },
  ]

  return {
    generatedAt: now,
    range: '30d',
    filters: { provider: 'all', account: 'all' },
    providers: [
      {
        provider: 'codex',
        totalTokens: 800_000,
        accounts: [{ key: 'alice@example.com', label: 'alice@example.com', loggedIn: true, isDefault: true, totalTokens: 800_000 }],
      },
      {
        provider: 'claude',
        totalTokens: 2_950_000,
        accounts: [
          { key: 'work', label: 'work@corp.dev', loggedIn: true, isDefault: true, totalTokens: 2_500_000 },
          { key: 'old', label: 'old@corp.dev', loggedIn: false, isDefault: false, totalTokens: 450_000 },
        ],
      },
      { provider: 'grok', totalTokens: 0, accounts: [] },
      { provider: 'antigravity', totalTokens: 0, accounts: [] },
    ],
    summary: {
      totalTokens: 3_750_000,
      inputTokens: 600_000,
      outputTokens: 150_000,
      cacheReadTokens: 2_700_000,
      cacheWriteTokens: 300_000,
      reasoningTokens: 60_000,
      activeModels: 3,
      activeDays: 2,
      activeAccounts: 3,
    },
    daily,
    heatmap: daily,
    models: [
      {
        provider: 'claude',
        model: 'claude-opus-4-6',
        totalTokens: 2_500_000,
        inputTokens: 400_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_800_000,
        cacheWriteTokens: 200_000,
        reasoningTokens: 42_000,
        share: 2_500_000 / 3_750_000,
      },
      {
        provider: 'codex',
        model: 'gpt-5.3-codex',
        totalTokens: 800_000,
        inputTokens: 120_000,
        outputTokens: 30_000,
        cacheReadTokens: 600_000,
        cacheWriteTokens: 50_000,
        reasoningTokens: 12_000,
        share: 800_000 / 3_750_000,
      },
    ],
    providerBreakdown: [
      {
        provider: 'claude',
        totalTokens: 2_950_000,
        inputTokens: 480_000,
        outputTokens: 120_000,
        cacheReadTokens: 2_100_000,
        cacheWriteTokens: 250_000,
        reasoningTokens: 48_000,
        share: 2_950_000 / 3_750_000,
        activeModels: 2,
        activeAccounts: 2,
      },
      {
        provider: 'codex',
        totalTokens: 800_000,
        inputTokens: 120_000,
        outputTokens: 30_000,
        cacheReadTokens: 600_000,
        cacheWriteTokens: 50_000,
        reasoningTokens: 12_000,
        share: 800_000 / 3_750_000,
        activeModels: 1,
        activeAccounts: 1,
      },
    ],
    activeWindows: [
      {
        id: `claude:work:5h::${now - 3_600_000}`,
        provider: 'claude',
        account: 'work',
        accountLabel: 'work@corp.dev',
        loggedIn: true,
        kind: '5h',
        window0: false,
        isCurrent: true,
        startsAt: now - 3_600_000,
        countedFrom: now - 3_600_000,
        endsAt: now + 14_400_000,
        resetAt: now + 14_400_000,
        status: 'open',
        quotaUsedPercent: 68,
        quotaPeakPercent: 72,
        markers: [],
        totalTokens: 2_500_000,
        inputTokens: 400_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_800_000,
        cacheWriteTokens: 200_000,
        reasoningTokens: 42_000,
        models: [
          {
            model: 'claude-opus-4-6',
            totalTokens: 2_500_000,
            inputTokens: 400_000,
            outputTokens: 100_000,
            cacheReadTokens: 1_800_000,
            cacheWriteTokens: 200_000,
            reasoningTokens: 42_000,
            share: 1,
          },
        ],
      },
    ],
    quotaCycles: [
      {
        id: `claude:work:5h::${now - 3_600_000}`,
        provider: 'claude',
        account: 'work',
        accountLabel: 'work@corp.dev',
        loggedIn: true,
        kind: '5h',
        window0: false,
        isCurrent: true,
        startsAt: now - 3_600_000,
        countedFrom: now - 3_600_000,
        endsAt: now + 14_400_000,
        resetAt: now + 14_400_000,
        status: 'open',
        quotaUsedPercent: 68,
        quotaPeakPercent: 72,
        markers: [],
        totalTokens: 2_500_000,
        inputTokens: 400_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_800_000,
        cacheWriteTokens: 200_000,
        reasoningTokens: 42_000,
        models: [
          {
            model: 'claude-opus-4-6',
            totalTokens: 2_500_000,
            inputTokens: 400_000,
            outputTokens: 100_000,
            cacheReadTokens: 1_800_000,
            cacheWriteTokens: 200_000,
            reasoningTokens: 42_000,
            share: 1,
          },
        ],
      },
      {
        id: `codex:alice@example.com:weekly::${now - 86_400_000 * 8}`,
        provider: 'codex',
        account: 'alice@example.com',
        accountLabel: 'alice@example.com',
        loggedIn: true,
        kind: 'weekly',
        window0: false,
        isCurrent: false,
        startsAt: now - 86_400_000 * 8,
        countedFrom: now - 86_400_000 * 8,
        endsAt: now - 86_400_000,
        status: 'closed',
        markers: [],
        totalTokens: 800_000,
        inputTokens: 120_000,
        outputTokens: 30_000,
        cacheReadTokens: 600_000,
        cacheWriteTokens: 50_000,
        reasoningTokens: 12_000,
        models: [
          {
            model: 'gpt-5.3-codex',
            totalTokens: 800_000,
            inputTokens: 120_000,
            outputTokens: 30_000,
            cacheReadTokens: 600_000,
            cacheWriteTokens: 50_000,
            reasoningTokens: 12_000,
            share: 1,
          },
        ],
      },
    ],
    clearInfo: {
      codex: { provider: 'codex', accounts: 1, from: now - 86_400_000, to: now, earlierHistory: false },
      claude: { provider: 'claude', accounts: 2, from: now - 172_800_000, to: now, earlierHistory: true },
      grok: { provider: 'grok', accounts: 0, earlierHistory: false },
      antigravity: { provider: 'antigravity', accounts: 0, earlierHistory: false },
    },
    cleared: false,
    trackingStartedAt: now - 86_400_000 * 30,
    errors: [],
    ...overrides,
  }
}

test('formatCompactTokens, formatPercent, computeNiceTicks, and heatmap helpers', () => {
  assert.equal(formatCompactTokens(0), '0')
  assert.equal(formatCompactTokens(842), '842')
  assert.equal(formatCompactTokens(12_400), '12.4K')
  assert.equal(formatCompactTokens(3_750_000), '3.75M')
  assert.equal(formatCompactTokens(14_600_000), '14.6M')
  assert.equal(formatCompactTokens(1_250_000_000), '1.25B')

  assert.equal(formatPercent(0), '0%')
  assert.equal(formatPercent(0.0004), '<0.1%')
  assert.equal(formatPercent(0.423), '42.3%')
  assert.equal(formatPercent(1), '100%')

  const ticks = computeNiceTicks(2_500_000, 4)
  assert.equal(ticks[0], 0)
  assert.ok(ticks[ticks.length - 1] >= 2_500_000)
  assert.ok(ticks.length >= 4 && ticks.length <= 6)

  assert.equal(heatmapLevel(0, 1_000), 0)
  assert.equal(heatmapLevel(50, 1_000), 1)
  assert.equal(heatmapLevel(1_000, 1_000), 4)

  const grid = buildHeatmapWeeks(sampleResponse().heatmap)
  assert.ok(grid.weeks.length >= 1)
  assert.equal(grid.maxTokens, 2_500_000)
  assert.equal(grid.weeks[0].length, 7)
})

test('usageDashboardReducer transitions filters, date selection, and clear state cleanly', () => {
  const s0 = initialUsageDashboardState()
  assert.equal(s0.phase, 'loading')
  assert.deepEqual(s0.request, { provider: 'all', account: 'all', range: '30d' })

  const s1 = reduce(s0, { type: 'loaded', response: sampleResponse() })
  assert.equal(s1.phase, 'shown')

  // Selecting a heatmap day and toggling it off
  const s2 = reduce(s1, { type: 'selectDate', date: '2026-11-23' })
  assert.equal(s2.selectedDate, '2026-11-23')
  const s3 = reduce(s2, { type: 'selectDate', date: '2026-11-23' })
  assert.equal(s3.selectedDate, undefined)

  // Switching provider resets account and auto-switches distribution mode from provider -> model
  const sProvMode = reduce(s1, { type: 'distribution', mode: 'provider' })
  const sClaude = reduce(sProvMode, { type: 'provider', provider: 'claude' })
  assert.equal(sClaude.request.provider, 'claude')
  assert.equal(sClaude.request.account, 'all')
  assert.equal(sClaude.distributionMode, 'model')
  assert.equal(sClaude.load, sProvMode.load + 1)

  // Selecting a provider+account pair from grouped dropdown
  const sAcct = reduce(s1, { type: 'providerAccount', provider: 'claude', account: 'work' })
  assert.deepEqual(sAcct.request, { provider: 'claude', account: 'work', range: '30d' })

  // Clear confirmation reducer guards double-confirm
  const c1 = clearConfirmReducer(CLEAR_CONFIRM_OPEN, { type: 'confirm' })
  assert.equal(c1.phase, 'clearing')
  assert.strictEqual(clearConfirmReducer(c1, { type: 'confirm' }), c1)
  const c2 = clearConfirmReducer(c1, { type: 'failed', message: 'disk busy' })
  assert.deepEqual(c2, { phase: 'failed', error: 'disk busy' })
})

test('UsageNavIcon renders a bare <svg> element matching sidebar.panellist slot contract', () => {
  const html = renderToStaticMarkup(createElement(UsageNavIcon, { size: 18, active: true }))
  assert.match(html, /^<svg[^>]*width="18"[^>]*height="18"/)
  assert.doesNotMatch(html, /^<span/)
})

test('UsageDashboardView renders KPIs, heatmap, charts, selected day breakdown, active windows, and zh locale', () => {
  const loaded = reduce(
    reduce(initialUsageDashboardState(), { type: 'loaded', response: sampleResponse() }),
    { type: 'selectDate', date: '2026-11-23' },
  )

  const htmlEn = renderToStaticMarkup(createElement(UsageDashboardView, {
    state: loaded,
    t: tEn,
    onAction() {},
    onOpenClear() {},
  }))
  assert.match(htmlEn, /Subscription Usage/)
  assert.match(htmlEn, /3\.75M/)
  assert.match(htmlEn, /Activity heatmap/)
  assert.match(htmlEn, /2026-11-23 \(UTC\)/)
  assert.match(htmlEn, /Daily token trend/)
  assert.match(htmlEn, /claude-opus-4-6/)
  assert.match(htmlEn, /Quota cycles/)
  assert.match(htmlEn, /dsh-usage-combo-svg/)
  assert.match(htmlEn, /68%/)
  assert.match(htmlEn, /old@corp\.dev · Logged out/)
  assert.doesNotMatch(htmlEn, /estimated cost|\bUSD\b/i)

  const htmlZh = renderToStaticMarkup(createElement(UsageDashboardView, {
    state: loaded,
    t: tZh,
    onAction() {},
    onOpenClear() {},
  }))
  assert.match(htmlZh, /订阅用量/)
  assert.match(htmlZh, /活跃热力图/)
  assert.match(htmlZh, /每日 Token 趋势/)
  assert.match(htmlZh, /额度周期统计/)
  assert.match(htmlZh, /68%/)
  assert.match(htmlZh, /已退出登录/)
})

test('UsageDashboardView renders empty, cleared, and RPC error states cleanly', () => {
  const emptyRes = sampleResponse({
    providers: [
      { provider: 'codex', totalTokens: 0, accounts: [] },
      { provider: 'claude', totalTokens: 0, accounts: [] },
      { provider: 'grok', totalTokens: 0, accounts: [] },
      { provider: 'antigravity', totalTokens: 0, accounts: [] },
    ],
    summary: {
      totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, activeModels: 0, activeDays: 0, activeAccounts: 0,
    },
    daily: [],
    heatmap: [],
    models: [],
    providerBreakdown: [],
    activeWindows: [],
    quotaCycles: [],
    cleared: true,
    errors: ['corrupt.json'],
  })
  const clearedState = reduce(initialUsageDashboardState(), { type: 'loaded', response: emptyRes })
  const clearedHtml = renderToStaticMarkup(createElement(UsageDashboardView, {
    state: clearedState,
    t: tEn,
    onAction() {},
    onOpenClear() {},
  }))
  assert.match(clearedHtml, /Usage history was cleared/)
  assert.match(clearedHtml, /corrupt\.json/)

  const errState = reduce(initialUsageDashboardState(), { type: 'failed', message: 'timeout' })
  const errHtml = renderToStaticMarkup(createElement(UsageDashboardView, {
    state: errState,
    t: tEn,
    onAction() {},
    onOpenClear() {},
  }))
  assert.match(errHtml, /Could not load usage: timeout/)
  assert.match(errHtml, /Retry/)
})

test('SubscriptionsPage renders unified top tabs (default usage, switchable to settings without redundant hint)', () => {
  const fakeRpc = { call: async () => ({ ok: false as const, error: { message: 'stub' } }) } as never

  // Default tab is Usage
  const usageHtml = renderToStaticMarkup(createElement(SubscriptionsPage, { rpc: fakeRpc, t: tEn }))
  assert.match(usageHtml, /role="tablist"/)
  assert.match(usageHtml, /role="tab"[^>]*aria-selected="true"[^>]*>.*Usage/)
  assert.match(usageHtml, /role="tab"[^>]*aria-selected="false"[^>]*>.*Settings/)
  assert.match(usageHtml, /dsh-usage-dashboard-embedded/)
  assert.doesNotMatch(usageHtml, /class="dsh-subscriptions-settings/)

  // Settings tab renders embedded full-width 2-column layout with hideUsageHint=true and custom-chevron selects
  const settingsHtml = renderToStaticMarkup(createElement(SubscriptionsPage, {
    rpc: fakeRpc,
    t: tZh,
    initialTab: 'settings',
  }))
  assert.match(settingsHtml, /role="tab"[^>]*aria-selected="false"[^>]*>.*用量/)
  assert.match(settingsHtml, /role="tab"[^>]*aria-selected="true"[^>]*>.*设置/)
  assert.match(settingsHtml, /dsh-subscriptions-settings-embedded/)
  assert.match(settingsHtml, /dsh-subscriptions-embedded-grid/)
  assert.match(settingsHtml, /dsh-subscriptions-embedded-aside/)
  assert.match(settingsHtml, /dsh-subscription-select-chevron/)
  assert.doesNotMatch(settingsHtml, /dsh-subscriptions-page-settings-wrap/)
  assert.doesNotMatch(settingsHtml, /已移至侧边栏「用量」页面/)

  // Standalone Settings page (for backwards compatibility) keeps classic 1-column layout and sidebar Usage hint
  const standaloneHtml = renderToStaticMarkup(createElement(SubscriptionsSection, { rpc: fakeRpc, t: tZh }))
  assert.match(standaloneHtml, /已移至侧边栏「用量」页面/)
  assert.doesNotMatch(standaloneHtml, /dsh-subscriptions-embedded-grid/)
})

test('ClearUsageHistoryDialog renders scope selector and Cancel button cleanly', () => {
  const res = sampleResponse()
  const html = renderToStaticMarkup(createElement(ClearUsageHistoryDialog, {
    target: 'all',
    clearInfo: res.clearInfo,
    state: CLEAR_CONFIRM_OPEN,
    t: tEn,
    onTargetChange() {},
    onCancel() {},
    onConfirm() {},
  }))
  assert.match(html, /Clear All providers usage history\?/)
  assert.match(html, /<select[^>]*>/)
  assert.match(html, />Cancel<\/button>/)
  assert.match(html, />Clear history<\/button>/)
})

test('Quota cycle combo chart renders dual axes, handles missing quota % without plotting 0%, and pins cycle inspector', () => {
  const startSameDay = Date.UTC(2026, 10, 22, 14, 0)
  const endSameDay = Date.UTC(2026, 10, 22, 19, 0)
  assert.equal(
    formatCycleTimeRange(tEn, { startsAt: startSameDay, countedFrom: startSameDay, endsAt: endSameDay }),
    '11-22 14:00 – 19:00 UTC',
  )
  const endCrossDay = Date.UTC(2026, 10, 29, 0, 0)
  assert.equal(
    formatCycleTimeRange(tEn, { startsAt: startSameDay, countedFrom: startSameDay, endsAt: endCrossDay }),
    '11-22 14:00 – 11-29 00:00 UTC',
  )
  assert.equal(formatCycleAxisLabel({ kind: '5h', startsAt: startSameDay, countedFrom: startSameDay }), '11-22 14h')
  assert.equal(formatCycleAxisLabel({ kind: 'weekly', startsAt: startSameDay, countedFrom: startSameDay }), '11-22')
  assert.equal(formatRelativeDuration(2 * 3_600_000 + 15 * 60_000), '2h 15m')
  assert.equal(formatRelativeDuration(3 * 86_400_000 + 4 * 3_600_000), '3d 4h')
  assert.equal(formatRelativeDuration(20_000), '<1m')
  assert.equal(quotaProgressTone(42), 'ok')
  assert.equal(quotaProgressTone(75), 'warn')
  assert.equal(quotaProgressTone(92), 'danger')

  const res = sampleResponse()
  // Render with pinned current cycle (68% used, peak 72%, resets in 4h) + historical n/a cycle
  const currentId = res.quotaCycles[0].id
  const pinnedHtml = renderToStaticMarkup(createElement(ActiveWindowsPanel, {
    windows: res.quotaCycles,
    now: res.generatedAt,
    initialSelectedId: currentId,
    t: tEn,
  }))
  assert.match(pinnedHtml, /dsh-usage-combo-svg/)
  assert.match(pinnedHtml, /data-quota-point="true"/)
  assert.match(pinnedHtml, /data-quota-na="true"/)
  assert.match(pinnedHtml, /68% used/)
  assert.match(pinnedHtml, /Peak 72%/)
  assert.match(pinnedHtml, /Resets in 4h/)
  assert.match(pinnedHtml, /5h \(1\)/)
  assert.match(pinnedHtml, /Weekly \(1\)/)

  // Filter to weekly and pin the cycle without quotaUsedPercent -> shows Quota % n/a, never 0% used
  const weeklyId = res.quotaCycles[1].id
  const weeklyHtml = renderToStaticMarkup(createElement(ActiveWindowsPanel, {
    windows: res.quotaCycles,
    now: res.generatedAt,
    initialKind: 'weekly',
    initialSelectedId: weeklyId,
    t: tEn,
  }))
  assert.match(weeklyHtml, /alice@example\.com/)
  assert.match(weeklyHtml, /Quota % n\/a/)
  assert.doesNotMatch(weeklyHtml, /0% used/)
  assert.match(weeklyHtml, /gpt-5\.3-codex/)
  assert.match(weeklyHtml, /\(100%\)/)
  assert.doesNotMatch(weeklyHtml, /<polyline/)
})


