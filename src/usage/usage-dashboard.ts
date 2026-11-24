/**
 * Pure cross-provider & cross-account usage dashboard aggregator.
 *
 * Aggregates deduplicated UTC daily token counts across tracked providers and
 * accounts without double-counting overlapping quota windows (e.g. a request
 * counted in both `5h` and `weekly`, or `weekly` + `weekly (scope: opus)`).
 *
 * Deduplication rule per `(provider, account, day, model)`:
 * - Within one `(kind, scope)` series, entries are sequential windows; summing
 *   all `id`-deduplicated visible entries in that series gives that series'
 *   total for `(day, model)`.
 * - Across overlapping series of the same `(provider, account)`, every
 *   applicable series observed the same underlying request stream. We pick one
 *   canonical series per `(provider, account, day, model)` (highest total
 *   tokens, preferring unscoped `weekly > 5h > monthly > pending` on ties), so
 *   overlapping 5h + weekly windows never double-count, while disjoint
 *   model-family scopes (e.g. Antigravity's Gemini vs Claude pools) each
 *   contribute their own models without loss.
 */
import { USAGE_TRACKED_PROVIDERS, type TrackedProvider } from './constants.js'
import type { PreTrackingStatus } from './pre-tracking.js'
import { summarizeStored, type StoredSummary } from './service.js'
import { combineModels, type DaySums, type ModelSums } from './usage-schema.js'
import type { LoggedInAccount } from './usage-rpc.js'
import type { ObservedWindow, TokenCounts, WindowUsageEntry } from './window-tracker.js'
import { allWindowsOf, VIEW_KINDS, type ViewKind, type ViewMarker, type ViewWindow } from './window-view.js'

export const DASHBOARD_RANGES = ['7d', '30d', '90d', 'all'] as const
export type DashboardRange = typeof DASHBOARD_RANGES[number]

export interface UsageDashboardPayload {
  /** Provider filter; omitted or 'all' aggregates all tracked providers. */
  provider?: TrackedProvider | 'all'
  /** Account filter; omitted or 'all' aggregates all accounts. */
  account?: string | 'all'
  /** Time range for KPI summary, daily trend, models, and providerBreakdown; defaults to '30d'. */
  range?: DashboardRange
}

export interface TokenTotals {
  /** inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens (reasoningTokens is a subset of outputTokens). */
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface DashboardProviderAccount {
  key: string
  /** Display identity (email / login) when logged in; omitted for logged-out historical accounts. */
  label?: string
  loggedIn: boolean
  isDefault: boolean
  /** Deduplicated total tokens for this account across all stored dated history. */
  totalTokens: number
}

export interface DashboardProviderInfo {
  provider: TrackedProvider
  /** Deduplicated total tokens for this provider in the selected range. */
  totalTokens: number
  accounts: DashboardProviderAccount[]
  clearedAt?: number
}

export interface DashboardSummary extends TokenTotals {
  activeModels: number
  activeDays: number
  activeAccounts: number
}

export interface DashboardDailyModelEntry extends TokenTotals {
  provider: TrackedProvider
  model: string
}

export interface DashboardDailyBucket extends TokenTotals {
  /** UTC date 'YYYY-MM-DD'. */
  date: string
  byProvider: Partial<Record<TrackedProvider, number>>
  byModel: DashboardDailyModelEntry[]
}

export interface DashboardModelSummary extends TokenTotals {
  provider: TrackedProvider
  model: string
  share: number
}

export interface DashboardProviderBreakdown extends TokenTotals {
  provider: TrackedProvider
  share: number
  activeModels: number
  activeAccounts: number
}

export interface DashboardActiveWindowModel extends TokenTotals {
  model: string
  /** Share of this cycle's totalTokens in [0, 1]. */
  share: number
}

export type DashboardCycleModel = DashboardActiveWindowModel

export interface DashboardActiveWindow extends TokenTotals {
  /** Stable unique key for React lists (`${provider}:${account}:${kind}:${scope ?? ''}:${countedFrom}`). */
  id: string
  provider: TrackedProvider
  account: string
  accountLabel?: string
  loggedIn: boolean
  kind: ViewKind
  scope?: string
  window0: boolean
  /** True for currently open/active cycles (`status === 'open'`); false for recent closed/ended-early historical cycles. */
  isCurrent: boolean
  startsAt?: number
  countedFrom: number
  endsAt?: number
  resetAt?: number
  status: 'open' | 'closed' | 'ended-early'
  /** Latest observed provider quota utilization for this cycle (0–100), omitted when never observed. */
  quotaUsedPercent?: number
  /** Peak observed provider quota utilization during this cycle (0–100), omitted when never observed. */
  quotaPeakPercent?: number
  markers: ViewMarker[]
  models: DashboardActiveWindowModel[]
}

export type DashboardQuotaCycle = DashboardActiveWindow

export interface DashboardClearInfo extends StoredSummary {
  provider: TrackedProvider
  clearedAt?: number
}

export interface UsageDashboardResponse {
  generatedAt: number
  range: DashboardRange
  filters: {
    provider: TrackedProvider | 'all'
    account: string | 'all'
  }
  providers: DashboardProviderInfo[]
  summary: DashboardSummary
  daily: DashboardDailyBucket[]
  heatmap: DashboardDailyBucket[]
  models: DashboardModelSummary[]
  providerBreakdown: DashboardProviderBreakdown[]
  activeWindows: DashboardActiveWindow[]
  /** Current open cycles first, followed by recent closed/ended-early cycles newest-first (capped at 40). */
  quotaCycles: DashboardActiveWindow[]
  clearInfo: Record<TrackedProvider, DashboardClearInfo>
  cleared: boolean
  trackingStartedAt: number
  errors: string[]
}

export interface ProviderDashboardInput {
  provider: TrackedProvider
  entries: readonly WindowUsageEntry[]
  loggedIn: readonly LoggedInAccount[]
  observed: (account: string) => readonly ObservedWindow[]
  clearedAt?: number
  preTracking: PreTrackingStatus
  errors: readonly string[]
}

export interface DashboardBuildInput {
  now: number
  trackingStartedAt: number
  providers: readonly ProviderDashboardInput[]
}

/** Calendar heatmap span: 26 full weeks (182 UTC days ending today). */
const HEATMAP_DAYS = 182
/** Cap on total current + recent historical quota cycles returned per dashboard query. */
const MAX_QUOTA_CYCLES = 40
const DAY_MS = 24 * 60 * 60_000
const RANGE_DAYS: Readonly<Record<Exclude<DashboardRange, 'all'>, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

/** Canonical tie-break preference when two overlapping series have equal day/model totals. */
const CANONICAL_KIND_RANK: Readonly<Record<ViewKind, number>> = {
  weekly: 0,
  '5h': 1,
  monthly: 2,
  pending: 3,
}

function emptyTotals(): TokenTotals {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

function countsToTotals(counts: TokenCounts): TokenTotals {
  const totalTokens = counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens
  return {
    totalTokens,
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    cacheReadTokens: counts.cacheReadTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
    reasoningTokens: counts.reasoningTokens,
  }
}

function addTotals(target: TokenTotals, add: TokenTotals): void {
  target.totalTokens += add.totalTokens
  target.inputTokens += add.inputTokens
  target.outputTokens += add.outputTokens
  target.cacheReadTokens += add.cacheReadTokens
  target.cacheWriteTokens += add.cacheWriteTokens
  target.reasoningTokens += add.reasoningTokens
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function addUtcDays(dateStr: string, deltaDays: number): string {
  const base = Date.parse(`${dateStr}T00:00:00.000Z`)
  return utcDateString(base + deltaDays * DAY_MS)
}

function enumerateUtcDates(startDate: string, endDate: string): string[] {
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return []
  const days: string[] = []
  for (let t = start; t <= end; t += DAY_MS) days.push(utcDateString(t))
  return days
}

/** Deduplicate by entry id (closed wins over open), drop pre-clear and unclassified entries. */
function visibleProviderEntries(
  provider: TrackedProvider,
  entries: readonly WindowUsageEntry[],
  clearedAt?: number,
): (WindowUsageEntry & { kind: ViewKind })[] {
  const byId = new Map<string, WindowUsageEntry>()
  for (const entry of entries) {
    if (entry.provider !== provider) continue
    if (clearedAt !== undefined && entry.countedFrom < clearedAt) continue
    const kept = byId.get(entry.id)
    if (kept === undefined || (kept.status === 'open' && entry.status !== 'open')) {
      byId.set(entry.id, entry)
    }
  }
  return [...byId.values()].filter((entry): entry is WindowUsageEntry & { kind: ViewKind } => entry.kind !== 'unclassified')
}

interface SeriesCandidate {
  kind: ViewKind
  scope?: string
  counts: TokenCounts
  total: number
}

function betterCandidate(a: SeriesCandidate, b: SeriesCandidate): boolean {
  if (a.total !== b.total) return a.total > b.total
  const aScoped = a.scope === undefined ? 0 : 1
  const bScoped = b.scope === undefined ? 0 : 1
  if (aScoped !== bScoped) return aScoped < bScoped
  const aKind = CANONICAL_KIND_RANK[a.kind]
  const bKind = CANONICAL_KIND_RANK[b.kind]
  if (aKind !== bKind) return aKind < bKind
  if (a.counts.reasoningTokens !== b.counts.reasoningTokens) return a.counts.reasoningTokens > b.counts.reasoningTokens
  if (a.counts.cacheReadTokens !== b.counts.cacheReadTokens) return a.counts.cacheReadTokens > b.counts.cacheReadTokens
  return (a.scope ?? '').localeCompare(b.scope ?? '') < 0
}

/**
 * Deduplicate daily per-model counts for one account across overlapping
 * `(kind, scope)` series.
 */
function deduplicateAccountDays(entries: readonly (WindowUsageEntry & { kind: ViewKind })[]): DaySums {
  interface SeriesBucket {
    kind: ViewKind
    scope?: string
    days: Map<string, ModelSums>
  }
  const bySeries = new Map<string, SeriesBucket>()
  for (const entry of entries) {
    if (entry.days === undefined) continue
    const key = `${entry.kind}\u0000${entry.scope ?? ''}`
    let bucket = bySeries.get(key)
    if (bucket === undefined) {
      bucket = { kind: entry.kind, ...entry.scope === undefined ? {} : { scope: entry.scope }, days: new Map() }
      bySeries.set(key, bucket)
    }
    for (const [day, models] of Object.entries(entry.days)) {
      const existing = bucket.days.get(day)
      bucket.days.set(day, existing === undefined ? combineModels({}, models) : combineModels(existing, models))
    }
  }

  // Collect best canonical candidate per (day, model) across overlapping series.
  const best = new Map<string, Map<string, SeriesCandidate>>()
  for (const series of bySeries.values()) {
    for (const [day, models] of series.days) {
      let dayMap = best.get(day)
      if (dayMap === undefined) {
        dayMap = new Map()
        best.set(day, dayMap)
      }
      for (const [model, counts] of Object.entries(models)) {
        const total = counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens
        if (total <= 0 && counts.reasoningTokens <= 0) continue
        const candidate: SeriesCandidate = {
          kind: series.kind,
          ...series.scope === undefined ? {} : { scope: series.scope },
          counts,
          total,
        }
        const prev = dayMap.get(model)
        if (prev === undefined || betterCandidate(candidate, prev)) dayMap.set(model, candidate)
      }
    }
  }

  const deduped: DaySums = {}
  for (const [day, modelMap] of best) {
    const models: ModelSums = {}
    for (const [model, candidate] of modelMap) models[model] = candidate.counts
    deduped[day] = models
  }
  return deduped
}

interface DayAccumulator {
  totals: TokenTotals
  byProvider: Partial<Record<TrackedProvider, number>>
  byModel: Map<string, DashboardDailyModelEntry>
}

function accumulateDay(
  map: Map<string, DayAccumulator>,
  date: string,
  provider: TrackedProvider,
  model: string,
  totals: TokenTotals,
): void {
  let acc = map.get(date)
  if (acc === undefined) {
    acc = { totals: emptyTotals(), byProvider: {}, byModel: new Map() }
    map.set(date, acc)
  }
  addTotals(acc.totals, totals)
  acc.byProvider[provider] = (acc.byProvider[provider] ?? 0) + totals.totalTokens
  const modelKey = `${provider}\u0000${model}`
  let modelEntry = acc.byModel.get(modelKey)
  if (modelEntry === undefined) {
    modelEntry = { provider, model, ...emptyTotals() }
    acc.byModel.set(modelKey, modelEntry)
  }
  addTotals(modelEntry, totals)
}

function materializeDailySeries(dates: readonly string[], accumulators: ReadonlyMap<string, DayAccumulator>): DashboardDailyBucket[] {
  return dates.map(date => {
    const acc = accumulators.get(date)
    if (acc === undefined) {
      return { date, ...emptyTotals(), byProvider: {}, byModel: [] }
    }
    const byModel = [...acc.byModel.values()].sort(
      (a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    )
    return {
      date,
      ...acc.totals,
      byProvider: acc.byProvider,
      byModel,
    }
  })
}

/** Build the complete Usage Dashboard response from loaded provider snapshots. */
export function buildUsageDashboard(
  input: DashboardBuildInput,
  query: UsageDashboardPayload = {},
): UsageDashboardResponse {
  const now = input.now
  const todayUtc = utcDateString(now)
  const range: DashboardRange = query.range ?? '30d'
  const filterProvider: TrackedProvider | 'all' = query.provider ?? 'all'

  // Index inputs by canonical provider order.
  const inputByProvider = new Map<TrackedProvider, ProviderDashboardInput>(
    input.providers.map(item => [item.provider, item]),
  )

  const errors: string[] = []
  const seenErrors = new Set<string>()
  const clearInfo = {} as Record<TrackedProvider, DashboardClearInfo>

  interface ProcessedAccount {
    key: string
    label?: string
    loggedIn: boolean
    isDefault: boolean
    days: DaySums
    lifetimeTokens: number
  }

  interface ProcessedProvider {
    provider: TrackedProvider
    visibleEntries: (WindowUsageEntry & { kind: ViewKind })[]
    accounts: ProcessedAccount[]
    clearedAt?: number
    preTracking: PreTrackingStatus
    observed: (account: string) => readonly ObservedWindow[]
  }

  const processedProviders: ProcessedProvider[] = []

  for (const provider of USAGE_TRACKED_PROVIDERS) {
    const item = inputByProvider.get(provider)
    const rawEntries = item?.entries ?? []
    const clearedAt = item?.clearedAt
    const preTracking: PreTrackingStatus = item?.preTracking ?? { state: 'unavailable' }
    const loggedIn = item?.loggedIn ?? []
    const observed = item?.observed ?? (() => [])

    for (const err of item?.errors ?? []) {
      if (!seenErrors.has(err)) {
        seenErrors.add(err)
        errors.push(err)
      }
    }

    const storedSummary = summarizeStored(rawEntries, preTracking, clearedAt)
    clearInfo[provider] = {
      provider,
      ...storedSummary,
      ...clearedAt === undefined ? {} : { clearedAt },
    }

    const visibleEntries = visibleProviderEntries(provider, rawEntries, clearedAt)
    const entriesByAccount = new Map<string, (WindowUsageEntry & { kind: ViewKind })[]>()
    for (const entry of visibleEntries) {
      const list = entriesByAccount.get(entry.account)
      if (list === undefined) entriesByAccount.set(entry.account, [entry])
      else list.push(entry)
    }

    const loggedInKeys = new Set(loggedIn.map(account => account.key))
    const storedOnlyKeys = [...entriesByAccount.keys()].filter(key => !loggedInKeys.has(key)).sort()
    const orderedAccounts: { key: string; label?: string; loggedIn: boolean; isDefault: boolean }[] = [
      ...loggedIn.map((account, index) => ({
        key: account.key,
        ...account.label === undefined ? {} : { label: account.label },
        loggedIn: true,
        isDefault: index === 0,
      })),
      ...storedOnlyKeys.map(key => ({ key, loggedIn: false, isDefault: false })),
    ]

    const accounts: ProcessedAccount[] = orderedAccounts.map(acct => {
      const days = deduplicateAccountDays(entriesByAccount.get(acct.key) ?? [])
      let lifetimeTokens = 0
      for (const models of Object.values(days)) {
        for (const counts of Object.values(models)) {
          lifetimeTokens += counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens
        }
      }
      return { ...acct, days, lifetimeTokens }
    })

    processedProviders.push({
      provider,
      visibleEntries,
      accounts,
      ...clearedAt === undefined ? {} : { clearedAt },
      preTracking,
      observed,
    })
  }

  // Validate requested account filter against matched providers so stale/cleared accounts fall back to 'all'.
  const requestedAccount = query.account ?? 'all'
  const matchedProviders = filterProvider === 'all'
    ? processedProviders
    : processedProviders.filter(item => item.provider === filterProvider)
  const filterAccount = requestedAccount !== 'all'
    && matchedProviders.some(item => item.accounts.some(account => account.key === requestedAccount))
    ? requestedAccount
    : 'all'

  // Determine UTC date bounds for the selected range and for the 182-day heatmap.
  const fixedDays = range === 'all' ? undefined : RANGE_DAYS[range]
  const fixedStartDate = fixedDays === undefined ? undefined : addUtcDays(todayUtc, -(fixedDays - 1))
  const heatmapStartDate = addUtcDays(todayUtc, -(HEATMAP_DAYS - 1))

  // Compute per-provider totals for the selected range (for provider tabs/pills).
  const providerRangeTotals = new Map<TrackedProvider, number>()
  for (const p of processedProviders) {
    let total = 0
    for (const acct of p.accounts) {
      for (const [date, models] of Object.entries(acct.days)) {
        if (fixedStartDate !== undefined && (date < fixedStartDate || date > todayUtc)) continue
        for (const counts of Object.values(models)) {
          total += counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens
        }
      }
    }
    providerRangeTotals.set(p.provider, total)
  }

  // Aggregate filtered scope across daily range, heatmap, models, providers, and KPIs.
  const rangeAccumulators = new Map<string, DayAccumulator>()
  const heatmapAccumulators = new Map<string, DayAccumulator>()
  const summaryTotals = emptyTotals()
  const activeModelsSet = new Set<string>()
  const activeDaysSet = new Set<string>()
  const activeAccountsSet = new Set<string>()

  const modelTotalsMap = new Map<string, { provider: TrackedProvider; model: string; totals: TokenTotals }>()
  const providerBreakdownMap = new Map<TrackedProvider, {
    totals: TokenTotals
    models: Set<string>
    accounts: Set<string>
  }>()

  let earliestFilteredDate: string | undefined
  let latestFilteredDate: string | undefined

  for (const p of matchedProviders) {
    for (const acct of p.accounts) {
      if (filterAccount !== 'all' && acct.key !== filterAccount) continue
      for (const [date, models] of Object.entries(acct.days)) {
        const inHeatmap = date >= heatmapStartDate && date <= todayUtc
        const inRange = fixedStartDate === undefined ? true : (date >= fixedStartDate && date <= todayUtc)

        for (const [model, counts] of Object.entries(models)) {
          const totals = countsToTotals(counts)
          if (totals.totalTokens <= 0 && totals.reasoningTokens <= 0) continue

          if (inHeatmap) {
            accumulateDay(heatmapAccumulators, date, p.provider, model, totals)
          }

          if (inRange) {
            if (earliestFilteredDate === undefined || date < earliestFilteredDate) earliestFilteredDate = date
            if (latestFilteredDate === undefined || date > latestFilteredDate) latestFilteredDate = date
            accumulateDay(rangeAccumulators, date, p.provider, model, totals)
            addTotals(summaryTotals, totals)

            if (totals.totalTokens > 0) {
              activeModelsSet.add(`${p.provider}\u0000${model}`)
              activeDaysSet.add(date)
              activeAccountsSet.add(`${p.provider}\u0000${acct.key}`)
            }

            const modelKey = `${p.provider}\u0000${model}`
            let modelBucket = modelTotalsMap.get(modelKey)
            if (modelBucket === undefined) {
              modelBucket = { provider: p.provider, model, totals: emptyTotals() }
              modelTotalsMap.set(modelKey, modelBucket)
            }
            addTotals(modelBucket.totals, totals)

            let providerBucket = providerBreakdownMap.get(p.provider)
            if (providerBucket === undefined) {
              providerBucket = { totals: emptyTotals(), models: new Set(), accounts: new Set() }
              providerBreakdownMap.set(p.provider, providerBucket)
            }
            addTotals(providerBucket.totals, totals)
            if (totals.totalTokens > 0) {
              providerBucket.models.add(model)
              providerBucket.accounts.add(acct.key)
            }
          }
        }
      }
    }
  }

  const dailyDates = fixedStartDate !== undefined
    ? enumerateUtcDates(fixedStartDate, todayUtc)
    : earliestFilteredDate === undefined
      ? []
      : enumerateUtcDates(
          earliestFilteredDate,
          latestFilteredDate !== undefined && latestFilteredDate > todayUtc ? latestFilteredDate : todayUtc,
        )

  const daily = materializeDailySeries(dailyDates, rangeAccumulators)
  const heatmap = materializeDailySeries(enumerateUtcDates(heatmapStartDate, todayUtc), heatmapAccumulators)

  const summary: DashboardSummary = {
    ...summaryTotals,
    activeModels: activeModelsSet.size,
    activeDays: activeDaysSet.size,
    activeAccounts: activeAccountsSet.size,
  }

  const denom = summary.totalTokens
  const models: DashboardModelSummary[] = [...modelTotalsMap.values()]
    .map(item => ({
      provider: item.provider,
      model: item.model,
      ...item.totals,
      share: denom > 0 ? item.totals.totalTokens / denom : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))

  const providerBreakdown: DashboardProviderBreakdown[] = [...providerBreakdownMap.entries()]
    .map(([provider, item]) => ({
      provider,
      ...item.totals,
      share: denom > 0 ? item.totals.totalTokens / denom : 0,
      activeModels: item.models.size,
      activeAccounts: item.accounts.size,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || USAGE_TRACKED_PROVIDERS.indexOf(a.provider) - USAGE_TRACKED_PROVIDERS.indexOf(b.provider))

  // Build current + recent historical quota cycle cards for matched accounts.
  const activeWindows: DashboardActiveWindow[] = []
  const allCycles: DashboardActiveWindow[] = []

  const toCycle = (
    provider: TrackedProvider,
    acct: { key: string; label?: string; loggedIn: boolean },
    win: ViewWindow,
  ): DashboardActiveWindow => {
    const winTotals = emptyTotals()
    const rawModels: Array<{ model: string; totals: TokenTotals }> = []
    for (const [model, counts] of Object.entries(win.models)) {
      const t = countsToTotals(counts)
      addTotals(winTotals, t)
      rawModels.push({ model, totals: t })
    }
    rawModels.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || a.model.localeCompare(b.model))
    const winModels: DashboardActiveWindowModel[] = rawModels.map(({ model, totals }) => ({
      model,
      ...totals,
      share: winTotals.totalTokens > 0 ? totals.totalTokens / winTotals.totalTokens : 0,
    }))
    const cycleId = `${provider}:${acct.key}:${win.kind}:${win.scope ?? ''}:${win.countedFrom}`
    return {
      id: cycleId,
      provider,
      account: acct.key,
      ...acct.label === undefined ? {} : { accountLabel: acct.label },
      loggedIn: acct.loggedIn,
      kind: win.kind,
      ...win.scope === undefined ? {} : { scope: win.scope },
      window0: win.window0,
      isCurrent: win.status === 'open',
      ...win.startsAt === undefined ? {} : { startsAt: win.startsAt },
      countedFrom: win.countedFrom,
      ...win.end === undefined ? {} : { endsAt: win.end },
      ...win.resetsAt === undefined ? {} : { resetAt: win.resetsAt },
      status: win.status,
      ...win.quotaUsedPercent === undefined ? {} : { quotaUsedPercent: win.quotaUsedPercent },
      ...win.quotaPeakPercent === undefined ? {} : { quotaPeakPercent: win.quotaPeakPercent },
      markers: win.markers,
      ...winTotals,
      models: winModels,
    }
  }

  for (const p of matchedProviders) {
    for (const acct of p.accounts) {
      if (filterAccount !== 'all' && acct.key !== filterAccount) continue
      const windows = allWindowsOf({
        provider: p.provider,
        account: acct.key,
        entries: p.visibleEntries,
        observed: p.observed(acct.key),
        trackingStartedAt: input.trackingStartedAt,
        ...p.clearedAt === undefined ? {} : { clearedAt: p.clearedAt },
        preTracking: p.preTracking,
      })
      for (const win of windows) {
        const cycle = toCycle(p.provider, acct, win)
        const hasSignal = cycle.status === 'open' || cycle.totalTokens > 0 || cycle.quotaUsedPercent !== undefined
        if (!hasSignal) continue
        allCycles.push(cycle)
        if (win.current && (cycle.status === 'open' || cycle.totalTokens > 0)) {
          activeWindows.push(cycle)
        }
      }
    }
  }

  const compareOpenOrder = (a: DashboardActiveWindow, b: DashboardActiveWindow): number => {
    const pDiff = USAGE_TRACKED_PROVIDERS.indexOf(a.provider) - USAGE_TRACKED_PROVIDERS.indexOf(b.provider)
    if (pDiff !== 0) return pDiff
    const logDiff = Number(b.loggedIn) - Number(a.loggedIn)
    if (logDiff !== 0) return logDiff
    const acctDiff = a.account.localeCompare(b.account)
    if (acctDiff !== 0) return acctDiff
    const kindDiff = VIEW_KINDS.indexOf(a.kind) - VIEW_KINDS.indexOf(b.kind)
    if (kindDiff !== 0) return kindDiff
    const scopePresence = Number(a.scope !== undefined) - Number(b.scope !== undefined)
    if (scopePresence !== 0) return scopePresence
    return (a.scope ?? '').localeCompare(b.scope ?? '')
  }

  activeWindows.sort((a, b) => {
    const openDiff = Number(b.isCurrent) - Number(a.isCurrent)
    if (openDiff !== 0) return openDiff
    return compareOpenOrder(a, b)
  })

  // Current open cycles first (canonical provider/account/kind order), then recent historical cycles newest-first.
  allCycles.sort((a, b) => {
    const openDiff = Number(b.isCurrent) - Number(a.isCurrent)
    if (openDiff !== 0) return openDiff
    if (a.isCurrent && b.isCurrent) return compareOpenOrder(a, b)
    const aTime = a.endsAt ?? a.resetAt ?? a.countedFrom
    const bTime = b.endsAt ?? b.resetAt ?? b.countedFrom
    if (aTime !== bTime) return bTime - aTime
    return compareOpenOrder(a, b)
  })
  const quotaCycles = allCycles.slice(0, MAX_QUOTA_CYCLES)

  const providers: DashboardProviderInfo[] = processedProviders.map(p => ({
    provider: p.provider,
    totalTokens: providerRangeTotals.get(p.provider) ?? 0,
    accounts: p.accounts.map(acct => ({
      key: acct.key,
      ...acct.label === undefined ? {} : { label: acct.label },
      loggedIn: acct.loggedIn,
      isDefault: acct.isDefault,
      totalTokens: acct.lifetimeTokens,
    })),
    ...p.clearedAt === undefined ? {} : { clearedAt: p.clearedAt },
  }))

  const cleared = summary.totalTokens === 0
    && activeWindows.length === 0
    && quotaCycles.length === 0
    && matchedProviders.length > 0
    && matchedProviders.every(p => p.clearedAt !== undefined)

  return {
    generatedAt: now,
    range,
    filters: {
      provider: filterProvider,
      account: filterAccount,
    },
    providers,
    summary,
    daily,
    heatmap,
    models,
    providerBreakdown,
    activeWindows,
    quotaCycles,
    clearInfo,
    cleared,
    trackingStartedAt: input.trackingStartedAt,
    errors,
  }
}
