/**
 * Subscription usage badge: a stats pill in the composer's dock
 * (`conversation.composer.dock`), modelled on the host's own token-usage
 * pill. Collapsed, it shows the rate-limit windows of the provider behind the
 * session's CURRENT model (a GPT model → Codex usage, a Claude model → Claude
 * usage); clicking it opens a trigger-anchored dialog listing every logged-in
 * account of every provider, with long window lists collapsed into previews,
 * the current provider first and the default account (starred) first within
 * a provider. Model-scoped Antigravity usage follows the current model.
 *
 * Usage rides the `subscriptions-auth` `status` + `usage` endpoints on a slow
 * poll (the server shares its cache across UI surfaces); the current model
 * comes from ui-model-selection's `modelDirectories` service on a quicker
 * poll, since the host pushes nothing on a model switch. Renders nothing when
 * no provider has a logged-in account that reports usage.
 *
 * The collapsed pill reads only the default account — the same account
 * direct (non-pool) routes serve — so it stays one short segment even for a
 * provider with several accounts connected; the dialog shows them all.
 * Every color resolves through a `--dsw-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { IconDataOutline16, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { callSubscriptionsAuth, groupUsageWindows, usageBarColor } from './SubscriptionsSection.js'
import type { AccountStatus, ProviderStatus, ProviderUsage, SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'
import type { ModelDirectoriesLike } from './SpeedSelect.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** How often the badge re-reads usage; the server also shares its own cache/negative-cache across UI surfaces. */
const USAGE_POLL_INTERVAL_MS = 15 * 60_000

/** How often the badge re-reads the session's current model (model switches arrive only by asking). */
const MODEL_POLL_INTERVAL_MS = 3000

/** Distance between the trigger's top edge and the dialog's bottom (host stat dialogs use the same). */
const PANEL_GAP = 8

/** Distance kept between the dialog and each viewport edge. */
const PANEL_MARGIN = 12

/** Injected dependencies (slot `inject`, session-bound). */
export interface SubscriptionUsageBadgeInjected {
  /** Connection RPC caller to reach the `subscriptions-auth` endpoints. */
  rpc: ConnectionHandle['rpc']
  /** Resolve the session's effective provider and model together. */
  currentModel: () => Promise<{ provider: string; model: string } | undefined>
}

/** Props delivered by the slot outlet + inject + the locale seat. */
export type SubscriptionUsageBadgeProps = PropsRuntime<'conversation.composer.dock'>
  & Partial<SubscriptionUsageBadgeInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>

/** One logged-in account's usage windows, as listed in the expanded dialog. */
export interface AccountUsageDisplay {
  /** Account key (the `usage` endpoint's `account` argument). */
  key: string
  /** Display handle (email / login), when the provider reports one. */
  account?: string
  plan?: string
  /** The account direct routes serve; the collapsed pill reads this one. */
  isDefault: boolean
  windows: UsageWindow[]
}

/** One provider's usage snapshot: every logged-in account that reports windows. */
export interface ProviderUsageDisplay {
  provider: SubscriptionProvider
  name: string
  /** Default account first, then the rest in the `status` endpoint's order. */
  accounts: AccountUsageDisplay[]
}

/** The account the collapsed pill reads: the default one, else the first listed. */
export function pillAccountOf(d: ProviderUsageDisplay): AccountUsageDisplay {
  return d.accounts.find(a => a.isDefault) ?? d.accounts[0]!
}

/** Brand display names (short form for the compact badge). */
const PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
}

/**
 * The `currentModel` half of the inject face: the session's effective
 * model selection through ui-model-selection's `modelDirectories` service,
 * resolved lazily per call (the service may register after this plugin, and
 * a shell without it simply reports "unknown", which the badge treats as
 * "show every provider").
 */
export function createCurrentModelReader(
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SubscriptionUsageBadgeInjected['currentModel'] {
  return async () => {
    const directories = models()
    if (directories === undefined) return undefined
    const { current } = await directories.directoryFor(sessionId).load()
    return current ?? undefined
  }
}

/**
 * Compact time-remaining label derived from the window's `resetsAt` timestamp:
 * "6d18h" (days+hours), "1h58m" (hours+minutes), or "42m" (minutes only).
 * Falls back to the scope/kind abbreviation when no reset time is known.
 */
export function windowLabel(w: UsageWindow): string {
  if (w.resetsAt === undefined) {
    if (w.scope !== undefined && w.scope !== '') return w.scope
    switch (w.kind) {
      case 'session': return '5h'
      case 'weekly': return 'Wk'
      default: return 'W'
    }
  }
  const ms = Math.max(0, w.resetsAt - Date.now())
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24}h`
  if (hours > 0) return `${hours}h${minutes % 60}m`
  return `${Math.max(1, minutes)}m`
}

/** Clamp and round a window's used share for display. */
function usedPercent(w: UsageWindow): number {
  return Math.round(Math.min(100, Math.max(0, w.usedPercent)))
}

/** Keep model quotas separate: matching percentages do not imply a shared pool. */
export function prioritizeWindows(windows: readonly UsageWindow[], model?: string): UsageWindow[] {
  return model === undefined ? [...windows] : [
    ...windows.filter(w => w.scope === model),
    ...windows.filter(w => w.scope !== model),
  ]
}

/** Small previews keep a live model catalog from taking over the dialog. */
export const WINDOW_PREVIEW_LIMIT = 4
export function previewWindows(windows: readonly UsageWindow[], model?: string) {
  const ordered = prioritizeWindows(windows, model)
  return { shown: ordered.slice(0, WINDOW_PREVIEW_LIMIT), hidden: ordered.slice(WINDOW_PREVIEW_LIMIT) }
}

/** Bounded readout; Antigravity quotas belong to individual models, not the account. */
export function compactSegment(d: ProviderUsageDisplay, model?: string, t: Translate = fallbackTranslate): string {
  const windows = pillAccountOf(d).windows
  if (d.provider === 'antigravity') {
    const matching = model === undefined ? [] : windows.filter(w => w.scope === model)
    if (matching.length === 0) {
      return `${d.name} ${t(model === undefined ? 'usageBadgeModelCount' : 'usageBadgeModelUnavailable', {
        count: new Set(windows.map(w => w.scope).filter(Boolean)).size,
      })}`
    }
    const parts = matching.slice(0, 2).map(w => `${w.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')} ${usedPercent(w)}%`)
    return `${d.name} ${parts.join(' · ')}`
  }
  const parts = windows.slice(0, 2).map(w => `${windowLabel(w)} ${usedPercent(w)}%`)
  if (windows.length > 2) parts.push(`+${windows.length - 2}`)
  return `${d.name} ${parts.join(' · ')}`
}

/**
 * Pick what the collapsed pill shows: the current model's provider when its
 * usage is known, otherwise every provider (unknown model, a provider this
 * plugin does not serve, or a current provider with no usage to report).
 */
export function collapsedDisplays(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
): readonly ProviderUsageDisplay[] {
  const match = displays.find(d => d.provider === current)
  return match === undefined ? displays : [match]
}

/** Order for the expanded dialog: the current provider first, the rest in poll order. */
export function expandedDisplays(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
): readonly ProviderUsageDisplay[] {
  const match = displays.find(d => d.provider === current)
  return match === undefined ? displays : [match, ...displays.filter(d => d !== match)]
}

/**
 * A provider's logged-in accounts, the effective default first. When no
 * account is flagged default the first listed stands in, matching what
 * direct routes fall back to.
 */
function accountsOf(status: ProviderStatus | undefined): AccountStatus[] {
  if (status === undefined || status.accounts.length === 0) return []
  const fallback = status.accounts.find(a => a.isDefault) ?? status.accounts[0]!
  return status.accounts
    .map(a => (a === fallback ? { ...a, isDefault: true } : a))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Localized label of one usage window (kind, plus the model scope when named). */
function usageWindowLabel(t: Translate, window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base
}

/**
 * The composer subscription-usage badge: a pill reading e.g.
 * `Codex 6d1h 25%` for the current model's provider, opening a dialog with
 * every provider's accounts and their windows. Returns null when no data is
 * available.
 */
export function SubscriptionUsageBadge({ rpc, currentModel, t }: SubscriptionUsageBadgeProps) {
  const translate: Translate = t ?? fallbackTranslate
  const [displays, setDisplays] = useState<ProviderUsageDisplay[]>([])
  const [selection, setSelection] = useState<{ provider: string; model: string } | undefined>(undefined)
  const current = selection?.provider
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const inflightRef = useRef(false)
  const mountedRef = useRef(true)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Always-rendered, invisible marker in the dock: locates the composer bar
  // (and the host stats row inside it) even while the pill itself is portaled.
  const seatRef = useRef<HTMLSpanElement | null>(null)
  // The inject face may be re-evaluated (new callback identities) on
  // re-render; the model poll mounts once and reads through this ref.
  const currentRef = useRef(currentModel)
  currentRef.current = currentModel
  // Last-known-good windows per account (keyed `provider:accountKey`), kept
  // across a failed poll (e.g. a 429 during the server's own negative-cache
  // cooldown) so a row doesn't flicker away — it only disappears once the
  // account actually logs out or a fetch succeeds but reports the window as
  // unsupported.
  const lastKnownRef = useRef(new Map<string, UsageWindow[]>())

  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined || inflightRef.current) return
    inflightRef.current = true
    try {
      const statusResp = await callSubscriptionsAuth<{
        providers: Record<SubscriptionProvider, ProviderStatus>
      }>(rpc, 'status', {})
      if (!mountedRef.current) return

      // Every logged-in account of every provider, in a stable order (the
      // `status` provider order, default account first) so rows don't jump
      // around as polls settle at different times.
      const roster: { provider: SubscriptionProvider; account: AccountStatus }[] = []
      for (const provider of Object.keys(statusResp.providers) as SubscriptionProvider[]) {
        for (const account of accountsOf(statusResp.providers[provider])) roster.push({ provider, account })
      }
      const keyOf = (provider: SubscriptionProvider, account: AccountStatus): string => `${provider}:${account.key}`

      const lastKnown = lastKnownRef.current
      // Drop last-known state for anything no longer logged in — that is a
      // real signal, unlike a fetch failure.
      const live = new Set(roster.map(({ provider, account }) => keyOf(provider, account)))
      for (const key of lastKnown.keys()) {
        if (!live.has(key)) lastKnown.delete(key)
      }

      if (roster.length === 0) {
        setDisplays([])
        return
      }

      const results = await Promise.allSettled(
        roster.map(async ({ provider, account }) => {
          const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider, account: account.key })
          return { provider, account, usage }
        }),
      )
      if (!mountedRef.current) return

      const plans = new Map<string, string>()
      for (const r of results) {
        if (r.status !== 'fulfilled') continue // keep whatever is cached for this account
        const { provider, account, usage } = r.value
        const key = keyOf(provider, account)
        if (usage.plan !== undefined) plans.set(key, usage.plan)
        if (!usage.supported || !usage.windows || usage.windows.length === 0) {
          lastKnown.delete(key)
          continue
        }
        lastKnown.set(key, usage.windows)
      }

      const byProvider = new Map<SubscriptionProvider, ProviderUsageDisplay>()
      for (const { provider, account } of roster) {
        const key = keyOf(provider, account)
        const windows = lastKnown.get(key)
        if (windows === undefined) continue
        const plan = plans.get(key) ?? account.plan
        const row: AccountUsageDisplay = {
          key: account.key,
          isDefault: account.isDefault,
          ...account.account === undefined ? {} : { account: account.account },
          ...plan === undefined ? {} : { plan },
          windows,
        }
        const display = byProvider.get(provider)
        if (display === undefined) byProvider.set(provider, { provider, name: PROVIDER_NAMES[provider], accounts: [row] })
        else display.accounts.push(row)
      }
      setDisplays([...byProvider.values()])
    } catch {
      // A failed poll must not crash the badge; keep last known state.
    } finally {
      inflightRef.current = false
    }
  }, [rpc])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, USAGE_POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (currentRef.current === undefined) return
    let cancelled = false
    let inflight = false
    const reload = (): void => {
      const read = currentRef.current
      if (read === undefined || inflight) return
      inflight = true
      void read().then(
        (model) => { if (!cancelled) setSelection(model) },
        () => { /* keep the last known provider; the next tick retries */ },
      ).finally(() => { inflight = false })
    }
    reload()
    const timer = setInterval(reload, MODEL_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  // Sit on the host's stats row when there is one. Every dock entry is its
  // own row in the composer bar, so a badge rendered in place lands under the
  // shipped time/token pills; the host marks its pill row with
  // `data-composer-stats`, and rendering into it makes the badge a third pill
  // on that line. The marker is watched (the row mounts only once the session
  // has steps or tokens, and unmounts with them) and older hosts without it
  // keep the in-place row.
  const [statsRow, setStatsRow] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const seat = seatRef.current
    if (seat === null) return
    const scope = statsScopeOf(seat)
    if (scope === null) return
    const find = (): HTMLElement | null => scope.querySelector<HTMLElement>('[data-composer-stats]')
    setStatsRow(find())
    const observer = new MutationObserver(() => { setStatsRow(find()) })
    observer.observe(scope, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  const seat = <span ref={seatRef} style={styles.seat} aria-hidden />

  if (displays.length === 0) return seat

  const collapsed = collapsedDisplays(displays, current)
  const label = collapsed.map(d => compactSegment(d, d.provider === current ? selection?.model : undefined, translate)).join(' | ')
  const expanded = expandedDisplays(displays, current)
  const title = translate('usageBadgeTitle')

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) void refresh()
  }

  const pill = (
    <span ref={rootRef} style={styles.anchor}>
      <button
        type="button"
        style={{ ...styles.pill, ...(hover || open ? styles.pillActive : {}) }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title} · ${label}`}
        title={title}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={toggle}
      >
        <IconDataOutline16 />
        <span style={styles.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={title}
          style={{ ...styles.panel, ...(pos ?? MEASURE_STYLE) }}
        >
          <div style={styles.title}>
            <span style={styles.titleLabel}>
              <IconDataOutline16 />
              {title}
            </span>
          </div>
          <div style={styles.titleRule} aria-hidden />
          {expanded.map((d, index) => (
            <section key={d.provider} style={index === 0 ? undefined : styles.section}>
              <div style={styles.providerRow}>
                <span style={styles.providerName}>
                  {d.name}
                  {d.provider === current && <span style={styles.currentTag}>{translate('usageBadgeCurrent')}</span>}
                </span>
                {d.accounts.length === 1 && <AccountMeta account={d.accounts[0]!} translate={translate} />}
              </div>
              {d.accounts.map((account, accountIndex) => (
                <div key={account.key} style={accountIndex === 0 ? undefined : styles.accountBlock}>
                  {d.accounts.length > 1 && (
                    <div style={styles.accountRow}>
                      <AccountMeta account={account} translate={translate} />
                    </div>
                  )}
                  <AccountWindows
                    key={`${d.provider}:${selection?.model ?? ''}`}
                    windows={account.windows}
                    model={d.provider === current ? selection?.model : undefined}
                    translate={translate}
                  />
                </div>
              ))}
            </section>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )

  return (
    <>
      {seat}
      {statsRow !== null && statsRow.isConnected ? createPortal(pill, statsRow) : pill}
    </>
  )
}

/**
 * Nearest ancestor of the dock seat that can contain the host's stats row:
 * the composer bar. Bounded so a badge in an unfamiliar layout never adopts
 * some other composer's pills.
 */
function statsScopeOf(seat: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = seat.parentElement
  for (let depth = 0; node !== null && depth < 4; depth++) {
    if (node.querySelector('[data-composer-stats]') !== null) return node
    node = node.parentElement
  }
  return seat.parentElement
}

/**
 * One account's handle and plan: `★ ys@example.com · 计划：pro`. The star
 * marks the default account (the one direct routes serve and the collapsed
 * pill reads), the same glyph Settings → 订阅 uses.
 */
function AccountMeta({ account, translate }: { account: AccountUsageDisplay; translate: Translate }) {
  const parts = [account.account, account.plan === undefined ? undefined : translate('usagePlan', { plan: account.plan })]
    .filter((part): part is string => part !== undefined && part !== '')
  return (
    <span style={styles.providerMeta} title={account.account}>
      {account.isDefault && <span style={styles.defaultStar} aria-label="default">★ </span>}
      {parts.join(' · ')}
    </span>
  )
}

/** Group equal percentages by default; expanding reveals every model quota separately. */
export function AccountWindows({ windows, model, translate }: {
  windows: readonly UsageWindow[]; model: string | undefined; translate: Translate
}) {
  const ordered = prioritizeWindows(windows, model)
  const groups = groupUsageWindows(ordered)
  const labelOf = (w: UsageWindow): string =>
    `${usageWindowLabel(translate, w)}${model !== undefined && w.scope === model ? ` · ${translate('usageBadgeCurrent')}` : ''}`
  const rows = (items: readonly UsageWindow[]) => (
    <dl style={styles.details}>
      {items.map((w, i) => <WindowRow key={i} label={labelOf(w)} window={w} />)}
    </dl>
  )
  // Short, already-distinct lists need no disclosure. Long lists still collapse
  // to a bounded summary, even when every percentage happens to differ.
  if (groups.length === windows.length && windows.length <= WINDOW_PREVIEW_LIMIT) return rows(ordered)
  return <details style={styles.moreWindows}>
    <summary className="dsh-subscriptions-usage-summary" style={styles.moreSummary}>
      <dl style={styles.details}>
        {groups.slice(0, WINDOW_PREVIEW_LIMIT).map(group => (
          <WindowRow
            key={group.percent}
            label={`${labelOf(group.first)}${group.windows.length > 1 ? ` +${group.windows.length - 1}` : ''}`}
            title={group.windows.map(labelOf).join('\n')}
            window={group.resetsAt === undefined
              ? { kind: group.first.kind, ...group.first.scope === undefined ? {} : { scope: group.first.scope }, usedPercent: group.percent }
              : { ...group.first, usedPercent: group.percent, resetsAt: group.resetsAt }}
          />
        ))}
      </dl>
      <span style={styles.expandHint}><span className="dsh-subscriptions-usage-chevron" aria-hidden>›</span>{translate('usageBadgeMoreWindows', { count: windows.length })}</span>
    </summary>
    {rows(ordered)}
  </details>
}

/** One `dt`/`dd` pair: window name → `25% · 6d1h`, with the bar underneath. */
function WindowRow({ label, window: w, title }: { label: string; window: UsageWindow; title?: string }) {
  const percent = usedPercent(w)
  return (
    <>
      <dt style={styles.dt} title={title}>{label}</dt>
      <dd style={styles.dd}>
        {percent}%
        {w.resetsAt !== undefined && <span style={styles.reset}> · {windowLabel(w)}</span>}
      </dd>
      <div style={styles.bar} aria-hidden>
        <div style={{ ...styles.barFill, width: `${percent}%`, background: usageBarColor(percent) }} />
      </div>
    </>
  )
}

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

const styles: Record<string, CSSProperties> = {
  seat: { display: 'none' },
  anchor: { minWidth: 0, maxWidth: '100%', display: 'inline-flex' },
  // Mirrors the host StatsPills pill so the badge reads as a sibling of the
  // shipped time/token pills.
  pill: {
    boxSizing: 'border-box', maxWidth: '100%',
    color: 'var(--dsw-alias-label-tertiary)',
    font: 'inherit', fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    fontVariantNumeric: 'tabular-nums', lineHeight: '20px', whiteSpace: 'nowrap',
    background: 'transparent', border: 'none', borderRadius: 24,
    alignItems: 'center', gap: 6, padding: '1px 8px', display: 'inline-flex', cursor: 'pointer',
  },
  pillActive: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  label: { textOverflow: 'ellipsis', minWidth: 0, overflow: 'hidden' },
  // Mirrors the host stat-dialog panel.
  panel: {
    position: 'fixed', zIndex: 1100, boxSizing: 'border-box',
    background: 'var(--dsw-specific-menu)',
    width: 'max-content', minWidth: 'min(300px, 100vw - 24px)', maxWidth: 'min(440px, 100vw - 24px)',
    maxHeight: 'min(560px, 100dvh - 24px)', overflowY: 'auto', overscrollBehavior: 'contain',
    boxShadow: 'var(--dsw-elevation-prominent)',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
    border: 0, borderRadius: 12, padding: 16, fontSize: 12, lineHeight: '18px',
  },
  title: {
    color: 'var(--dsw-alias-label-primary)', display: 'flex',
    justifyContent: 'space-between', gap: 16, marginBottom: 8, fontWeight: 500,
  },
  titleLabel: { alignItems: 'center', gap: 6, minWidth: 0, display: 'inline-flex' },
  titleRule: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 },
  section: { marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
  providerRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 6,
  },
  providerName: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 },
  currentTag: {
    fontSize: 10, lineHeight: '14px', fontWeight: 400, padding: '0 5px', borderRadius: 7,
    color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  providerMeta: {
    color: 'var(--dsw-alias-label-tertiary)', minWidth: 0, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  // Same star and color as the default-account marker in Settings → 订阅.
  defaultStar: { color: 'var(--dsw-alias-state-warn-label)' },
  accountBlock: { marginTop: 8 },
  accountRow: { display: 'flex', marginBottom: 4 },
  details: {
    color: 'var(--dsw-alias-label-tertiary)', display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) max-content', gap: '4px 16px', margin: 0,
  },
  moreWindows: { marginTop: 8 },
  moreSummary: { display: 'block', listStyle: 'none', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 },
  expandHint: { display: 'flex', alignItems: 'center', gap: 5 },
  dt: { minWidth: 0, margin: 0, overflowWrap: 'anywhere' },
  dd: {
    minWidth: 0, margin: 0, color: 'var(--dsw-alias-label-secondary)',
    fontVariantNumeric: 'tabular-nums', textAlign: 'right',
  },
  reset: { color: 'var(--dsw-alias-label-tertiary)' },
  bar: {
    gridColumn: '1 / -1', height: 4, borderRadius: 2, overflow: 'hidden',
    background: 'var(--dsw-alias-border-l2)', marginBottom: 2,
  },
  barFill: { height: '100%', borderRadius: 2 },
}
