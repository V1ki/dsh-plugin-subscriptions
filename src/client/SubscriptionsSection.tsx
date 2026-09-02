/**
 * Subscriptions settings section: one card per subscription provider with an
 * OAuth login/logout flow driven by the node half's `/subscriptions-auth` RPC
 * channel. Login state lives server-side; the page polls `status` only while
 * a login attempt is busy, so an idle page never polls. All state is local
 * React state — the page has no store.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and
 * every user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace. Buttons and inputs take the
 * ModelsSection vocabulary minus hover rules, which inline styles cannot
 * express.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'
import { displayedAutoReview, type AutoReviewMode, type AutoReviewState } from './AutoReviewSelect.js'

/** Logical RPC channel served by the node half of this plugin. */
const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000

/**
 * Model count above which the expanded default-effort list also offers a name
 * filter; below it the list is short enough to scan.
 */
const MODEL_FILTER_THRESHOLD = 8

/**
 * Height cap of the expanded default-effort list, in px. Past it the list
 * scrolls internally so a provider with dozens of models cannot stretch the
 * card (roughly 7 rows, which keeps the next card's header on screen).
 */
const MODEL_LIST_MAX_HEIGHT = 260

/** Subscription provider ids, fixed by the node half's OAuth adapters. */
export type SubscriptionProvider = 'codex' | 'claude' | 'grok' | 'copilot'

/** One logged-in account as answered by the `status` endpoint. */
export interface AccountStatus {
  key: string
  account?: string
  expiresAt?: number
  plan?: string
  isDefault: boolean
}

/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
  busy: boolean
  accounts: AccountStatus[]
  detail?: string
}

/** `status` endpoint value: the node half owns this shape. */
interface StatusResponse {
  providers: Record<SubscriptionProvider, ProviderStatus>
}

/** One rate-limit window as answered by the `usage` endpoint. */
export interface UsageWindow {
  kind: 'session' | 'weekly' | 'other'
  scope?: string
  usedPercent: number
  resetsAt?: number
}

/** `usage` endpoint value: the node half owns this shape. */
export interface ProviderUsage {
  supported: boolean
  windows?: UsageWindow[]
  plan?: string
}

/** One model's default-effort picker state as answered by `modelDefaults`. */
export interface ModelDefaultView {
  id: string
  name: string
  /** Advertised effort levels, in catalog order (empty when the model has no reasoning). */
  efforts: { id: string; name: string }[]
  /** The user-configured default effort, when set. */
  configured?: string
}

/** `modelDefaults` endpoint value: one provider's picker state. */
export interface ModelDefaultsCatalog {
  provider: SubscriptionProvider
  models: ModelDefaultView[]
}

/** `proxyGet` endpoint value: the node half owns this shape (no secrets). */
export interface ProxyConfigView {
  enabled: boolean
  url: string
  username?: string
  passwordSet: boolean
  bypass: string[]
  error?: string
}

/** `proxyTest` endpoint value. */
export interface ProxyTestResult {
  ok: boolean
  viaProxy: boolean
  status?: number
  latencyMs?: number
  error?: string
}

/** `login` endpoint value: the URL the user completes OAuth at. */
interface LoginResponse {
  authorizeUrl: string
  /** Device-flow providers (copilot): the code the user types at authorizeUrl. */
  userCode?: string
}

/** Injected dependencies of {@link SubscriptionsSection} (slot `inject`). */
export interface SubscriptionsSectionInjected {
  /** Generic logical-RPC caller over the Connection transport. */
  rpc: ConnectionHandle['rpc']
  /** Section copy: translate a 'settings.subscriptions' key with `{name}` template params. */
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type SubscriptionsSectionProps = Partial<SubscriptionsSectionInjected>

/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS: readonly { id: SubscriptionProvider; name: string }[] = [
  { id: 'codex', name: 'Codex (ChatGPT)' },
  { id: 'claude', name: 'Claude' },
  { id: 'grok', name: 'Grok (X Premium)' },
  { id: 'copilot', name: 'GitHub Copilot' },
]

/** Business error returned by the `/subscriptions-auth` channel (error branch message). */
class SubscriptionsAuthError extends Error {}

/**
 * Call one `/subscriptions-auth` endpoint and unwrap the business result.
 * Shared by the settings section and the composer Speed toggle.
 * @param rpc - Connection RPC caller.
 * @param endpoint - channel-relative endpoint.
 * @param payload - channel-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
export async function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T> {
  let result: RpcResult<unknown>
  try {
    result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, endpoint, payload)
  } catch (error) {
    // The transport rejected rather than answering; surface the same way.
    throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) throw new SubscriptionsAuthError(result.error.message)
  return result.value as T
}

/** Bind the Settings page to the effective global Auto-Review default. */
export function createAutoReviewDefaultLoader(
  rpc: ConnectionHandle['rpc'],
): () => Promise<AutoReviewState> {
  return () => callSubscriptionsAuth<AutoReviewState>(rpc, 'autoReviewDefault', {})
}

/** Persist one global Auto-Review default from Settings. */
export function createAutoReviewDefaultSetter(
  rpc: ConnectionHandle['rpc'],
): (reviewer: AutoReviewMode) => Promise<AutoReviewState> {
  return reviewer => callSubscriptionsAuth<AutoReviewState>(rpc, 'setAutoReviewDefault', { reviewer })
}

/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Copy a keyed map without the entries whose key is not in `live`. */
function dropStale<T>(map: Record<string, T>, live: ReadonlySet<string>): Record<string, T> {
  const stale = Object.keys(map).filter(key => !live.has(key))
  if (stale.length === 0) return map
  const next = { ...map }
  for (const key of stale) delete next[key]
  return next
}

/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

const styles: Record<string, CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560,
    color: 'var(--dsw-alias-label-primary)',
  },
  intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  proxyCard: {
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  separator: { borderTop: '1px solid var(--dsw-alias-border-l2)' },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  name: { fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
  statusLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  errorLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  actions: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
  button: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 28, padding: '0 10px', borderRadius: 14,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  usage: {
    display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
    borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8,
  },
  usageHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  usageTitle: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
  usagePlan: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  usageRefresh: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 22, padding: '0 8px', borderRadius: 11, marginLeft: 'auto',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  usageRow: { display: 'flex', flexDirection: 'column', gap: 3 },
  usageMeta: {
    display: 'flex', justifyContent: 'space-between', gap: 8,
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  accountRow: {
    display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '8px 10px', marginTop: 4,
  },
  accountHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  accountName: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', userSelect: 'all' },
  starButton: {
    border: 'none', background: 'transparent', padding: 0,
    font: 'inherit', fontSize: 14, lineHeight: '20px', cursor: 'pointer',
    color: 'var(--dsw-alias-state-warn-label)',
  },
  usageTrack: {
    height: 6, borderRadius: 3, overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  },
  usageFill: { height: '100%', borderRadius: 3 },
  defaultEffort: {
    display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
    borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8,
  },
  /** The always-visible disclosure header: title, summary, chevron. */
  defaultEffortToggle: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: 0, border: 'none', background: 'transparent',
    font: 'inherit', textAlign: 'left', cursor: 'pointer',
  },
  defaultEffortChevron: {
    marginLeft: 'auto', flexShrink: 0, fontSize: 10, lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  /** Body of the expanded disclosure: bounded height so a long catalog scrolls. */
  defaultEffortList: {
    display: 'flex', flexDirection: 'column', gap: 6,
    maxHeight: MODEL_LIST_MAX_HEIGHT, overflowY: 'auto', paddingRight: 2,
  },
  defaultEffortRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  defaultEffortName: {
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  defaultEffortSaving: {
    marginLeft: 'auto', flexShrink: 0,
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  defaultEffortSelect: {
    maxWidth: 220, flexShrink: 0, height: 28, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 8px', font: 'inherit', fontSize: 12, lineHeight: '18px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  defaultEffortFilter: {
    height: 28, width: '100%', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 8px', font: 'inherit', fontSize: 12, lineHeight: '18px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  manual: { marginTop: 4, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  manualRow: { display: 'flex', gap: 8, marginTop: 6 },
  manualInput: {
    flex: 1, height: 32, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  deviceCode: {
    marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)',
  },
  deviceCodeText: {
    fontFamily: 'monospace', fontSize: 18, lineHeight: '24px', letterSpacing: 2,
    color: 'var(--dsw-alias-label-primary)', userSelect: 'all',
  },
  proxyField: { display: 'flex', flexDirection: 'column', gap: 4 },
  proxyLabel: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  proxyInput: {
    height: 32, width: '100%', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  proxyHint: {
    margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  proxyCheck: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
  },
  proxyMessage: { margin: 0, fontSize: 12, lineHeight: '18px' },
  proxyActions: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 },
  modalOverlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    background: 'rgba(0, 0, 0, 0.45)',
  },
  modal: {
    width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
    boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12,
    padding: '16px 18px', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
  },
  modalHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  modalTitle: { fontWeight: 600, fontSize: 15, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
}

/** Status dot color for one provider state. */
function dotColor(status: ProviderStatus | undefined): string {
  if (status?.busy === true) return 'var(--dsw-alias-state-warn-label)'
  if ((status?.accounts.length ?? 0) > 0) return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-dimmed)'
}

/**
 * Whether a provider has at least one connected account. Multi-account made
 * "logged in" a property of the account list rather than a flag, so every
 * logged-in test goes through this one predicate.
 * @param status - the provider's last reported state, possibly absent.
 * @returns true when the provider serves at least one account.
 */
function hasAccount(status: ProviderStatus | undefined): boolean {
  return (status?.accounts.length ?? 0) > 0
}

/**
 * One-line status text for one provider state.
 * @param t - section translate.
 * @param status - the provider's last reported state.
 * @returns the localized status line.
 */
function statusText(t: SubscriptionsSectionInjected['t'], status: ProviderStatus | undefined): string {
  if (status === undefined) return t('checking')
  if (status.busy) return t('loginInProgress')
  if (status.accounts.length > 0) return t('loggedInCount', { count: status.accounts.length })
  return t('notLoggedIn')
}

/**
 * Localized label of one usage window (kind, plus the model scope when named).
 * @param t - section translate.
 * @param window - the reported window.
 * @returns e.g. "5-hour window" or "Weekly · Opus".
 */
function usageWindowLabel(t: SubscriptionsSectionInjected['t'], window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base
}

/** Bar fill color: success normally, warn from 80%, error from 95%. */
function usageBarColor(usedPercent: number): string {
  if (usedPercent >= 95) return 'var(--dsw-alias-state-error-primary)'
  if (usedPercent >= 80) return 'var(--dsw-alias-state-warn-label)'
  return 'var(--dsw-alias-state-success-primary)'
}

/** One-line status text of the proxy config card. */
function proxyStatusText(
  t: SubscriptionsSectionInjected['t'],
  proxy: ProxyConfigView | undefined,
  loadError: string | undefined,
): string {
  if (loadError !== undefined) return t('proxyLoadFailed', { message: loadError })
  if (proxy === undefined) return t('proxyLoading')
  if (proxy.error !== undefined) return t('proxyStatusError', { message: proxy.error })
  if (proxy.enabled) return t('proxyStatusEnabled', { url: proxy.url })
  return t('proxyStatusNone')
}

/** Feedback-line color of the proxy dialog. */
function messageColor(tone: 'success' | 'error'): string {
  return tone === 'error'
    ? 'var(--dsw-alias-state-error-primary)'
    : 'var(--dsw-alias-state-success-primary)'
}

/** What one provider's collapsible default-effort section renders. */
export interface ModelDefaultsView {
  /** Models with reasoning levels, after the name filter — one row each. */
  shown: ModelDefaultView[]
  /** Models with reasoning levels before filtering (the header total). */
  total: number
  /** How many of those carry a user override (the header count). */
  overridden: number
  /** Models without reasoning levels: one count line, never a row each. */
  withoutEfforts: number
  /** Whether the list is long enough to deserve a filter box. */
  showFilter: boolean
}

/**
 * Derive one provider's default-effort section from its catalog and filter.
 * Pure so the collapsed-header counts and the filter stay testable without a
 * DOM: rows come only from models that advertise levels, the count of the rest
 * rides as one line, and the filter matches display name or model id.
 * @param models - the provider's catalog models, or undefined while loading.
 * @param filter - the raw filter input (trimmed and lowercased here).
 * @returns the section's rows and header counts.
 */
export function deriveModelDefaultsView(
  models: readonly ModelDefaultView[] | undefined,
  filter: string,
): ModelDefaultsView {
  const all = models ?? []
  const withEfforts = all.filter(model => model.efforts.length > 0)
  const query = filter.trim().toLowerCase()
  const shown = query === ''
    ? withEfforts
    : withEfforts.filter(model => model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query))
  return {
    shown,
    total: withEfforts.length,
    overridden: withEfforts.filter(model => model.configured !== undefined).length,
    withoutEfforts: all.length - withEfforts.length,
    showFilter: withEfforts.length > MODEL_FILTER_THRESHOLD,
  }
}

/** Inputs of the default-effort fetch decision (see {@link shouldFetchModelDefaults}). */
export interface ModelDefaultsFetchInput {
  /** Providers that currently have at least one account. */
  loggedIn: readonly SubscriptionProvider[]
  /** Providers whose disclosure is open. */
  open: readonly SubscriptionProvider[]
  /** The account signature the last completed fetch was answered for. */
  loadedFor: string | undefined
  /** The account signature of the current status snapshot. */
  signature: string
  /** Whether the last attempt failed (a failure latches until Retry). */
  failed: boolean
}

/**
 * Whether the default-effort catalog needs (re)fetching.
 *
 * Fetching is gated on an *attempt* signature rather than on the payload
 * being empty: an empty answer is a legitimate result (a narrowed
 * `config.providers`, or a catalog that is momentarily unavailable), and
 * treating it as "not loaded yet" re-ran this effect forever. The signature
 * also covers the accounts, so logging a second provider in refetches
 * instead of leaving that card on the previous answer.
 * @param input - the decision inputs.
 * @returns true when the caller should start a fetch.
 */
export function shouldFetchModelDefaults(input: ModelDefaultsFetchInput): boolean {
  if (input.failed) return false
  if (input.loggedIn.length === 0) return false
  // Only an open disclosure pays for the per-model live resolve.
  if (!input.open.some(provider => input.loggedIn.includes(provider))) return false
  return input.loadedFor !== input.signature
}

/**
 * Stable signature of the accounts a catalog answer depends on. A change
 * means a previous answer is stale (an account arrived or left), so the next
 * open disclosure refetches.
 * @param statuses - the per-provider status snapshot.
 * @returns a signature string, stable across renders with equal accounts.
 */
export function modelDefaultsSignature(
  statuses: Partial<Record<SubscriptionProvider, ProviderStatus>>,
): string {
  return PROVIDERS
    .map(({ id }) => `${id}:${(statuses[id]?.accounts ?? []).map(account => account.key).sort().join(',')}`)
    .join('|')
}

/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  const { rpc } = props
  const t = props.t ?? fallbackTranslate
  const [statuses, setStatuses] = useState<Partial<Record<SubscriptionProvider, ProviderStatus>>>({})
  const [errors, setErrors] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const [manualDrafts, setManualDrafts] = useState<Record<SubscriptionProvider, string>>({
    codex: '', claude: '', grok: '', copilot: '',
  })
  /** Pending device-flow codes (copilot), shown while the attempt polls. */
  const [deviceCodes, setDeviceCodes] = useState<Partial<Record<SubscriptionProvider, { userCode: string; verificationUrl: string }>>>({})
  const [copiedCode, setCopiedCode] = useState<SubscriptionProvider | undefined>(undefined)
  /** Usage snapshots keyed `${provider}:${accountKey}` — every account tracks its own windows. */
  const [usages, setUsages] = useState<Record<string, ProviderUsage>>({})
  const [usageErrors, setUsageErrors] = useState<Record<string, string>>({})
  const [usageLoading, setUsageLoading] = useState<Record<string, boolean>>({})
  const mountedRef = useRef(true)
  const pollersRef = useRef(new Map<SubscriptionProvider, ReturnType<typeof setInterval>>())
  /** Accounts with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
  const usageInflightRef = useRef(new Set<string>())
  /** Proxy config as last answered by `proxyGet`/`proxySet`. */
  const [proxy, setProxy] = useState<ProxyConfigView | undefined>(undefined)
  const [proxyLoadError, setProxyLoadError] = useState<string | undefined>(undefined)
  /** Proxy dialog state (draft fields; the password never pre-fills). */
  const [proxyOpen, setProxyOpen] = useState(false)
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyUsername, setProxyUsername] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [proxyClearPassword, setProxyClearPassword] = useState(false)
  const [proxyBypass, setProxyBypass] = useState('')
  const [proxySaving, setProxySaving] = useState(false)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyMessage, setProxyMessage] = useState<{ tone: 'success' | 'error'; text: string } | undefined>(undefined)
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | undefined>(undefined)
  /** Global Auto-Review default as last answered by Settings RPC. */
  const [autoReviewDefault, setAutoReviewDefaultState] = useState<AutoReviewState | undefined>(undefined)
  const [autoReviewDefaultSaving, setAutoReviewDefaultSaving] = useState(false)
  const [autoReviewDefaultError, setAutoReviewDefaultError] = useState<string | undefined>(undefined)
  /** Per-model default-effort picker state as answered by `modelDefaults`. */
  const [modelDefaults, setModelDefaults] = useState<Partial<Record<SubscriptionProvider, ModelDefaultsCatalog>>>({})
  const [modelDefaultsLoading, setModelDefaultsLoading] = useState(false)
  const [modelDefaultsLoadError, setModelDefaultsLoadError] = useState<string | undefined>(undefined)
  /** One set in flight: the `${provider}/${model}` key. */
  const [modelDefaultsSaving, setModelDefaultsSaving] = useState<string | undefined>(undefined)
  /** Per-model save failures, keyed `${provider}/${model}`. */
  const [modelDefaultsSaveErrors, setModelDefaultsSaveErrors] = useState<Record<string, string>>({})
  /** Providers whose default-effort disclosure is open (collapsed by default). */
  const [modelDefaultsOpen, setModelDefaultsOpen] = useState<Partial<Record<SubscriptionProvider, boolean>>>({})
  /** Per-provider name filter of the expanded list. */
  const [modelDefaultsFilters, setModelDefaultsFilters] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  /** Account signature the last completed catalog fetch was answered for. */
  const [modelDefaultsLoadedFor, setModelDefaultsLoadedFor] = useState<string | undefined>(undefined)
  /** Optimistic in-flight selections, keyed `${provider}/${model}` ('' = follow provider). */
  const [modelDefaultsPending, setModelDefaultsPending] = useState<Record<string, string>>({})
  /** Guard the catalog effect against concurrent loads. */
  const modelDefaultsInflightRef = useRef(false)

  const setProviderError = useCallback((provider: SubscriptionProvider, message: string | undefined): void => {
    if (!mountedRef.current) return
    setErrors((prev) => {
      const next = { ...prev }
      if (message === undefined) delete next[provider]
      else next[provider] = message
      return next
    })
  }, [])

  const stopPolling = useCallback((provider: SubscriptionProvider): void => {
    const poller = pollersRef.current.get(provider)
    if (poller !== undefined) {
      clearInterval(poller)
      pollersRef.current.delete(provider)
    }
  }, [])

  /** Refetch every provider's status; stop a provider's poller once its attempt settles. */
  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    let response: StatusResponse
    try {
      response = await callSubscriptionsAuth<StatusResponse>(rpc, 'status', {})
    } catch {
      // A failed poll must not kill the page; busy providers keep polling and
      // the action paths report their own errors.
      return
    }
    if (!mountedRef.current) return
    setStatuses(response.providers)
    for (const { id } of PROVIDERS) {
      const status = response.providers[id]
      if (status.accounts.length > 0 || !status.busy) {
        stopPolling(id)
        // The attempt settled (success, timeout, or cancel): drop the code card.
        setDeviceCodes((prev) => {
          if (prev[id] === undefined) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    }
  }, [rpc, stopPolling])

  const startPolling = useCallback((provider: SubscriptionProvider): void => {
    if (pollersRef.current.has(provider)) return
    pollersRef.current.set(provider, setInterval(() => { void refresh() }, POLL_INTERVAL_MS))
  }, [refresh])

  // Initial load; every busy provider (e.g. an attempt started before a page
  // reload) resumes polling. Teardown clears pollers and the mounted guard.
  useEffect(() => {
    mountedRef.current = true
    void refresh().then(() => {
      if (!mountedRef.current) return
      setStatuses((current) => {
        for (const { id } of PROVIDERS) {
          if (current[id]?.busy === true) startPolling(id)
        }
        return current
      })
    })
    return () => {
      mountedRef.current = false
      for (const poller of pollersRef.current.values()) clearInterval(poller)
      pollersRef.current.clear()
    }
  }, [refresh, startPolling])

  const loadUsage = useCallback(async (provider: SubscriptionProvider, account: string, force = false): Promise<void> => {
    const key = `${provider}:${account}`
    if (rpc === undefined || usageInflightRef.current.has(key)) return
    usageInflightRef.current.add(key)
    setUsageLoading(prev => ({ ...prev, [key]: true }))
    try {
      const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider, account, ...force ? { force: true } : {} })
      if (!mountedRef.current) return
      setUsages(prev => ({ ...prev, [key]: usage }))
      setUsageErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    } catch (error) {
      if (mountedRef.current) setUsageErrors(prev => ({ ...prev, [key]: messageOf(error) }))
    } finally {
      usageInflightRef.current.delete(key)
      if (mountedRef.current) setUsageLoading(prev => ({ ...prev, [key]: false }))
    }
  }, [rpc])

  // Fetch usage once an account is logged in; drop the snapshots of accounts
  // that vanished so a re-login refetches. A failed lookup does not auto-retry
  // — the per-account Refresh button is the retry path.
  useEffect(() => {
    const live = new Set<string>()
    for (const { id } of PROVIDERS) {
      for (const account of statuses[id]?.accounts ?? []) {
        const key = `${id}:${account.key}`
        live.add(key)
        if (usages[key] === undefined && usageErrors[key] === undefined) void loadUsage(id, account.key)
      }
    }
    setUsages(prev => dropStale(prev, live))
    setUsageErrors(prev => dropStale(prev, live))
  }, [statuses, usages, usageErrors, loadUsage])

  const loadModelDefaultsData = useCallback(async (signature: string): Promise<void> => {
    if (rpc === undefined || modelDefaultsInflightRef.current) return
    modelDefaultsInflightRef.current = true
    setModelDefaultsLoading(true)
    try {
      const catalog = await callSubscriptionsAuth<ModelDefaultsCatalog[]>(rpc, 'modelDefaults', {})
      if (!mountedRef.current) return
      const next: Partial<Record<SubscriptionProvider, ModelDefaultsCatalog>> = {}
      for (const entry of catalog) next[entry.provider] = entry
      setModelDefaults(next)
      setModelDefaultsLoadError(undefined)
      // Latch the answered signature, empty answer included: an empty catalog
      // is a result, not a missing load, and re-deriving "loaded" from the
      // payload re-triggered this fetch on every render.
      setModelDefaultsLoadedFor(signature)
      // The shown state is now authoritative; stale per-row failures would
      // otherwise linger next to rows that are correct again.
      setModelDefaultsSaveErrors({})
    } catch (error) {
      if (mountedRef.current) setModelDefaultsLoadError(messageOf(error))
    } finally {
      modelDefaultsInflightRef.current = false
      if (mountedRef.current) setModelDefaultsLoading(false)
    }
  }, [rpc])

  // Fetch the default-effort catalogs only once a card's list is expanded: the
  // node half resolves live model info per model, so a collapsed page must not
  // pay for it. One fetch covers every logged-in provider (the node half
  // answers them together), and the levels follow the picker's catalog union
  // across that provider's accounts. The account signature drives refetching,
  // so connecting another provider or account does not leave an open card on
  // the previous answer. Everything resets once the last account logs out.
  useEffect(() => {
    const loggedIn = PROVIDERS.filter(({ id }) => hasAccount(statuses[id])).map(({ id }) => id)
    const signature = modelDefaultsSignature(statuses)
    if (loggedIn.length > 0) {
      const open = PROVIDERS.filter(({ id }) => modelDefaultsOpen[id] === true).map(({ id }) => id)
      if (shouldFetchModelDefaults({
        loggedIn,
        open,
        loadedFor: modelDefaultsLoadedFor,
        signature,
        failed: modelDefaultsLoadError !== undefined,
      })) {
        void loadModelDefaultsData(signature)
      }
    } else if (modelDefaultsLoadedFor !== undefined
      || Object.keys(modelDefaults).length > 0
      || Object.keys(modelDefaultsOpen).length > 0) {
      setModelDefaults({})
      setModelDefaultsSaveErrors({})
      setModelDefaultsLoadError(undefined)
      setModelDefaultsLoadedFor(undefined)
      setModelDefaultsLoading(false)
      setModelDefaultsOpen({})
      setModelDefaultsFilters({})
    }
  }, [
    statuses,
    modelDefaults,
    modelDefaultsOpen,
    modelDefaultsLoadError,
    modelDefaultsLoadedFor,
    loadModelDefaultsData,
  ])

  /** Open or close one provider's default-effort disclosure. */
  const toggleModelDefaults = useCallback((provider: SubscriptionProvider): void => {
    setModelDefaultsOpen(prev => ({ ...prev, [provider]: prev[provider] !== true }))
  }, [])

  const setModelDefault = useCallback(async (provider: SubscriptionProvider, model: string, effort: string | undefined): Promise<void> => {
    if (rpc === undefined) return
    const key = `${provider}/${model}`
    setModelDefaultsSaving(key)
    // Hold the picked level locally for the duration of the save: the select
    // is controlled by server state, which only updates after the round trip,
    // so without this the row visibly snaps back to "Follow provider" (greyed
    // out) mid-save and reads as a rejected change.
    setModelDefaultsPending(prev => ({ ...prev, [key]: effort ?? '' }))
    setModelDefaultsSaveErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'setModelDefault', {
        provider,
        model,
        ...(effort === undefined ? {} : { effort }),
      })
      if (!mountedRef.current) return
      setModelDefaults((prev) => {
        const section = prev[provider]
        if (section === undefined) return prev
        return {
          ...prev,
          [provider]: {
            ...section,
            models: section.models.map((entry) => {
              if (entry.id !== model) return entry
              if (effort !== undefined) return { ...entry, configured: effort }
              // Cleared: drop the key rather than keep the stale level, or the
              // select would snap back and the header would keep counting it.
              const { configured: _cleared, ...rest } = entry
              return rest
            }),
          },
        }
      })
    } catch (error) {
      if (mountedRef.current) setModelDefaultsSaveErrors((prev) => ({ ...prev, [key]: messageOf(error) }))
    } finally {
      if (mountedRef.current) {
        setModelDefaultsSaving(current => current === key ? undefined : current)
        // Drop the optimistic value: on success the server state now carries
        // it, on failure the row must fall back to the real stored level
        // rather than keep showing a change that did not land.
        setModelDefaultsPending((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    }
  }, [rpc])

  const login = useCallback(async (provider: SubscriptionProvider, method?: 'oauth' | 'keychain'): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    try {
      const response = await callSubscriptionsAuth<LoginResponse>(rpc, 'login', {
        provider,
        ...method === undefined ? {} : { method },
      })
      if (typeof response.authorizeUrl === 'string' && response.authorizeUrl === '') {
        // Instant login (e.g. imported from Claude Code credentials)
        await refresh()
        return
      }
      if (typeof response.authorizeUrl !== 'string') {
        throw new SubscriptionsAuthError(t('loginMissingUrl'))
      }
      if (!mountedRef.current) return
      // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
      setStatuses(prev => ({
        ...prev,
        [provider]: { accounts: prev[provider]?.accounts ?? [], ...prev[provider], busy: true },
      }))
      if (typeof response.userCode === 'string' && response.userCode.length > 0) {
        // Device flow: show the code card instead of opening the page blind —
        // the user copies the code first, then opens the verification page.
        setDeviceCodes(prev => ({ ...prev, [provider]: { userCode: response.userCode as string, verificationUrl: response.authorizeUrl } }))
      } else {
        window.open(response.authorizeUrl, '_blank', 'noopener')
      }
      startPolling(provider)
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
  }, [rpc, t, setProviderError, startPolling])

  const cancel = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    stopPolling(provider)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'cancel', { provider })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, stopPolling, setProviderError, refresh])

  const submitManual = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    const input = manualDrafts[provider].trim()
    if (input === '') return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'manual', { provider, input })
      if (mountedRef.current) setManualDrafts(prev => ({ ...prev, [provider]: '' }))
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, manualDrafts, setProviderError, refresh])

  const logout = useCallback(async (provider: SubscriptionProvider, account: string, display: string, name: string): Promise<void> => {
    if (rpc === undefined) return
    if (!window.confirm(t('logoutAccountConfirm', { provider: name, account: display }))) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'logout', { provider, account })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, t, setProviderError, refresh])

  const setDefault = useCallback(async (provider: SubscriptionProvider, account: string): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'setDefault', { provider, account })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, setProviderError, refresh])

  const copyDeviceCode = useCallback((provider: SubscriptionProvider, userCode: string): void => {
    void navigator.clipboard?.writeText(userCode).then(() => {
      if (!mountedRef.current) return
      setCopiedCode(provider)
      setTimeout(() => {
        if (mountedRef.current) {
          setCopiedCode(current => current === provider ? undefined : current)
        }
      }, 1500)
    }).catch(() => undefined)
  }, [])

  // Global Auto-Review default: YAML bootstraps it; Settings owns the durable
  // runtime choice after the first save.
  useEffect(() => {
    if (rpc === undefined) return
    let alive = true
    void createAutoReviewDefaultLoader(rpc)().then((state) => {
      if (!alive) return
      setAutoReviewDefaultState(state)
      setAutoReviewDefaultError(undefined)
    }).catch((error) => {
      if (alive) setAutoReviewDefaultError(messageOf(error))
    })
    return () => { alive = false }
  }, [rpc])

  const saveAutoReviewDefault = useCallback(async (reviewer: AutoReviewMode): Promise<void> => {
    if (rpc === undefined || autoReviewDefaultSaving) return
    setAutoReviewDefaultSaving(true)
    setAutoReviewDefaultError(undefined)
    try {
      setAutoReviewDefaultState(await createAutoReviewDefaultSetter(rpc)(reviewer))
    } catch (error) {
      setAutoReviewDefaultError(messageOf(error))
    } finally {
      setAutoReviewDefaultSaving(false)
    }
  }, [rpc, autoReviewDefaultSaving])

  // Proxy configuration: load once on mount; the dialog drives proxySet/proxyTest.
  useEffect(() => {
    if (rpc === undefined) return
    let alive = true
    void callSubscriptionsAuth<ProxyConfigView>(rpc, 'proxyGet', {}).then((view) => {
      if (!alive) return
      setProxy(view)
      setProxyLoadError(undefined)
    }).catch((error) => {
      if (alive) setProxyLoadError(messageOf(error))
    })
    return () => { alive = false }
  }, [rpc])

  useEffect(() => {
    if (!proxyOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProxyOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [proxyOpen])

  const openProxyDialog = useCallback((): void => {
    if (proxy === undefined) return
    setProxyEnabled(proxy.enabled)
    setProxyUrl(proxy.url)
    setProxyUsername(proxy.username ?? '')
    setProxyPassword('')
    setProxyClearPassword(false)
    setProxyBypass(proxy.bypass.join(', '))
    setProxyMessage(undefined)
    setProxyTestResult(undefined)
    setProxyOpen(true)
  }, [proxy])

  const saveProxy = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    setProxySaving(true)
    setProxyMessage(undefined)
    try {
      const view = await callSubscriptionsAuth<ProxyConfigView>(rpc, 'proxySet', {
        enabled: proxyEnabled,
        url: proxyUrl.trim(),
        username: proxyUsername,
        ...proxyClearPassword ? { password: null } : proxyPassword !== '' ? { password: proxyPassword } : {},
        bypass: proxyBypass.split(/[,\n]/).map(entry => entry.trim()).filter(entry => entry !== ''),
      })
      setProxy(view)
      setProxyLoadError(undefined)
      setProxyMessage({ tone: 'success', text: t('proxySaved') })
      setProxyOpen(false)
    } catch (error) {
      setProxyMessage({ tone: 'error', text: t('proxySaveFailed', { message: messageOf(error) }) })
    } finally {
      setProxySaving(false)
    }
  }, [rpc, proxyEnabled, proxyUrl, proxyUsername, proxyPassword, proxyClearPassword, proxyBypass, t])

  const testProxy = useCallback(async (): Promise<void> => {
    if (rpc === undefined || proxyTesting) return
    setProxyTesting(true)
    setProxyTestResult(undefined)
    try {
      // Test the dialog's current inputs (they do not need to be saved first);
      // the host builds a throwaway agent for the probe.
      setProxyTestResult(await callSubscriptionsAuth<ProxyTestResult>(rpc, 'proxyTest', {
        proxy: {
          url: proxyUrl.trim(),
          ...proxyUsername.trim() !== '' ? { username: proxyUsername.trim() } : {},
          ...proxyPassword !== '' ? { password: proxyPassword } : {},
        },
      }))
    } catch (error) {
      setProxyTestResult({ ok: false, viaProxy: false, error: messageOf(error) })
    } finally {
      setProxyTesting(false)
    }
  }, [rpc, proxyTesting, proxyUrl, proxyUsername, proxyPassword])

  if (rpc === undefined) {
    return <p style={styles.intro}>{t('unavailable')}</p>
  }

  return (
    <div style={styles.section}>
      <p style={styles.intro}>{t('intro')}</p>
      <div style={styles.proxyCard}>
        <div style={styles.cardHeader}>
          <span style={{
            ...styles.dot,
            background: proxy?.enabled === true
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-dimmed)',
          }} />
          <span style={styles.name}>{t('proxyTitle')}</span>
          <button
            type="button"
            style={{ ...styles.button, marginLeft: 'auto', flexShrink: 0 }}
            onClick={openProxyDialog}
          >
            {t('proxyConfigure')}
          </button>
        </div>
        <p style={styles.statusLine}>{proxyStatusText(t, proxy, proxyLoadError)}</p>
      </div>
      <div style={styles.proxyCard}>
        <div style={styles.cardHeader}>
          <span style={{
            ...styles.dot,
            background: autoReviewDefault !== undefined
              && displayedAutoReview(autoReviewDefault) !== 'none'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-dimmed)',
          }} />
          <span style={styles.name}>{t('autoReviewDefaultTitle')}</span>
          <select
            style={{ ...styles.defaultEffortSelect, marginLeft: 'auto' }}
            aria-label={t('autoReviewDefaultTitle')}
            value={autoReviewDefault === undefined ? 'none' : displayedAutoReview(autoReviewDefault)}
            disabled={autoReviewDefault === undefined || autoReviewDefaultSaving}
            onChange={(event) => { void saveAutoReviewDefault(event.target.value as AutoReviewMode) }}
          >
            <option value="none">{t('autoReviewNone')}</option>
            {(autoReviewDefault?.reviewers ?? []).map(option => (
              <option key={option.reviewer} value={option.reviewer}>{option.label}</option>
            ))}
          </select>
        </div>
        <p style={styles.statusLine}>
          {autoReviewDefaultSaving
            ? t('autoReviewDefaultSaving')
            : autoReviewDefault === undefined && autoReviewDefaultError === undefined
              ? t('autoReviewDefaultLoading')
              : t('autoReviewDefaultHint')}
        </p>
        {autoReviewDefaultError !== undefined && (
          <p style={styles.errorLine} role="alert">
            {t(autoReviewDefault === undefined ? 'autoReviewDefaultLoadFailed' : 'autoReviewDefaultSaveFailed', {
              message: autoReviewDefaultError,
            })}
          </p>
        )}
      </div>
      <div style={styles.separator} />
      {PROVIDERS.map(({ id, name }) => {
        const status = statuses[id]
        const busy = status?.busy === true
        const deviceCode = deviceCodes[id]
        const accounts = status?.accounts ?? []
        return (
          <div key={id} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={{ ...styles.dot, background: dotColor(status) }} />
              <span style={styles.name}>{name}</span>
            </div>
            <p style={styles.statusLine}>{statusText(t, status)}</p>
            {status?.detail !== undefined && status.detail !== '' && (
              <p style={styles.statusLine}>{status.detail}</p>
            )}
            {errors[id] !== undefined && <p style={styles.errorLine}>{errors[id]}</p>}
            {accounts.map((account) => {
              const usageKey = `${id}:${account.key}`
              const usage = usages[usageKey]
              const usageError = usageErrors[usageKey]
              const display = account.account ?? account.key
              // Providers without a usage endpoint answer supported:false — no block.
              const showUsage = usage?.supported !== false
                && (usage !== undefined || usageError !== undefined || usageLoading[usageKey] === true)
              return (
                <div key={account.key} style={styles.accountRow}>
                  <div style={styles.accountHeader}>
                    <button
                      type="button"
                      style={styles.starButton}
                      title={account.isDefault ? t('defaultBadge') : t('setDefault')}
                      onClick={() => {
                        if (!account.isDefault) void setDefault(id, account.key)
                      }}
                    >
                      {account.isDefault ? '★' : '☆'}
                    </button>
                    <span style={styles.accountName}>{display}</span>
                    {account.plan !== undefined && (
                      <span style={styles.usagePlan}>{account.plan}</span>
                    )}
                    {account.expiresAt !== undefined && (
                      <span style={styles.statusLine}>
                        {t('accountExpires', { date: new Date(account.expiresAt).toLocaleString() })}
                      </span>
                    )}
                    <button
                      type="button"
                      style={{ ...styles.button, marginLeft: 'auto', flexShrink: 0 }}
                      onClick={() => { void logout(id, account.key, display, name) }}
                    >
                      {t('logout')}
                    </button>
                  </div>
                  {showUsage && (
                    <div style={styles.usage}>
                      <div style={styles.usageHeader}>
                        <span style={styles.usageTitle}>{t('usageTitle')}</span>
                        {usage?.plan !== undefined && (
                          <span style={styles.usagePlan}>{t('usagePlan', { plan: usage.plan })}</span>
                        )}
                        <button
                          type="button"
                          style={{ ...styles.usageRefresh, ...usageLoading[usageKey] === true ? { opacity: 0.5, cursor: 'default' } : {} }}
                          disabled={usageLoading[usageKey] === true}
                          onClick={() => { void loadUsage(id, account.key, true) }}
                        >
                          {t('usageRefresh')}
                        </button>
                      </div>
                      {usage === undefined && usageError === undefined && (
                        <p style={styles.statusLine}>{t('usageLoading')}</p>
                      )}
                      {usageError !== undefined && (
                        <p style={styles.errorLine}>{t('usageError', { message: usageError })}</p>
                      )}
                      {usage?.windows !== undefined && usage.windows.length === 0 && (
                        <p style={styles.statusLine}>{t('usageEmpty')}</p>
                      )}
                      {(usage?.windows ?? []).map((window, index) => {
                        const percent = Math.min(100, Math.max(0, window.usedPercent))
                        return (
                          <div key={index} style={styles.usageRow}>
                            <div style={styles.usageMeta}>
                              <span>{usageWindowLabel(t, window)}</span>
                              <span>
                                {`${String(Math.round(percent))}%`}
                                {window.resetsAt !== undefined
                                  && ` · ${t('usageResets', { date: new Date(window.resetsAt).toLocaleString() })}`}
                              </span>
                            </div>
                            <div style={styles.usageTrack}>
                              <div style={{ ...styles.usageFill, width: `${String(percent)}%`, background: usageBarColor(percent) }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
            <div style={styles.actions}>
              {!busy && accounts.length === 0 && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('login')}
                </button>
              )}
              {!busy && accounts.length > 0 && id === 'claude' && (
                <>
                  <button type="button" style={styles.button} onClick={() => { void login(id, 'oauth') }}>
                    {t('addAccountOAuth')}
                  </button>
                  <button type="button" style={styles.button} onClick={() => { void login(id, 'keychain') }}>
                    {t('addAccountKeychain')}
                  </button>
                </>
              )}
              {!busy && accounts.length > 0 && id !== 'claude' && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('addAccount')}
                </button>
              )}
              {busy && (
                <button type="button" style={styles.button} onClick={() => { void cancel(id) }}>
                  {t('cancel')}
                </button>
              )}
            </div>
            {!busy && accounts.length > 0 && (
              <p style={styles.statusLine}>{t('addAccountHint')}</p>
            )}
            {accounts.length > 0 && (() => {
              // Collapsed by default: providers with a large catalog (Copilot
              // lists dozens of models) must not push the page down. The
              // header carries the summary so the collapsed state still says
              // how many models are overridden. The section is per provider,
              // not per account: the override keys off the model id, which the
              // pool shares across a provider's accounts.
              const open = modelDefaultsOpen[id] === true
              const catalog = modelDefaults[id]
              const filter = modelDefaultsFilters[id] ?? ''
              const view = deriveModelDefaultsView(catalog?.models, filter)
              const saveErrors = Object.entries(modelDefaultsSaveErrors).filter(([key]) => key.startsWith(`${id}/`))
              return (
                <div style={styles.defaultEffort}>
                  <button
                    type="button"
                    style={styles.defaultEffortToggle}
                    aria-expanded={open}
                    onClick={() => { toggleModelDefaults(id) }}
                  >
                    <span style={styles.usageTitle}>{t('modelDefaultsTitle')}</span>
                    <span style={styles.usagePlan}>
                      {catalog === undefined
                        ? (modelDefaultsLoading ? t('modelDefaultsLoading') : '')
                        : view.total === 0
                          ? t('modelDefaultsSummaryEmpty')
                          : view.overridden === 0
                            ? t('modelDefaultsSummaryNone', { total: view.total })
                            : t('modelDefaultsSummary', { total: view.total, configured: view.overridden })}
                    </span>
                    {/* Decoration: `aria-expanded` on the button already
                        carries the state, and labelling the glyph only
                        appended it to the button's accessible name. */}
                    <span style={styles.defaultEffortChevron} aria-hidden="true">
                      {open ? '▲' : '▼'}
                    </span>
                  </button>
                  {/* Save failures stay visible while collapsed: a row the user
                      cannot see must not swallow its own error. */}
                  {saveErrors.map(([key, message]) => (
                    // Named: the failing row may be scrolled out of the
                    // bounded list, and several anonymous "Save failed" lines
                    // cannot be told apart.
                    <p key={key} style={styles.errorLine} role="alert">
                      {t('modelDefaultsSaveFailedNamed', {
                        model: catalog?.models.find(entry => `${id}/${entry.id}` === key)?.name
                          ?? key.slice(id.length + 1),
                        message,
                      })}
                    </p>
                  ))}
                  {open && (
                    <>
                      <p style={styles.statusLine}>{t('modelDefaultsHint')}</p>
                      {modelDefaultsLoadError !== undefined && (
                        <>
                          <p style={styles.errorLine}>{t('modelDefaultsLoadFailed', { message: modelDefaultsLoadError })}</p>
                          <div style={styles.actions}>
                            <button
                              type="button"
                              style={styles.button}
                              onClick={() => {
                                // Clearing the latch lets the effect pick the
                                // fetch back up on the next render.
                                setModelDefaultsLoadError(undefined)
                              }}
                            >
                              {t('modelDefaultsRetry')}
                            </button>
                          </div>
                        </>
                      )}
                      {modelDefaultsLoadError === undefined && catalog === undefined && (
                        <p style={styles.statusLine}>{t('modelDefaultsLoading')}</p>
                      )}
                      {view.showFilter && (
                        <input
                          style={styles.defaultEffortFilter}
                          value={filter}
                          placeholder={t('modelDefaultsFilterPlaceholder')}
                          // The placeholder disappears once the user types, so
                          // the name has to live somewhere permanent too.
                          aria-label={t('modelDefaultsFilterPlaceholder')}
                          onChange={(event) => {
                            setModelDefaultsFilters(prev => ({ ...prev, [id]: event.target.value }))
                          }}
                        />
                      )}
                      {view.shown.length > 0 && (
                        <div style={styles.defaultEffortList}>
                          {view.shown.map((model) => {
                            const rowKey = `${id}/${model.id}`
                            const saving = modelDefaultsSaving === rowKey
                            // Ids carry the provider: a model id alone repeats
                            // across cards, and duplicate ids break the label
                            // association the select relies on.
                            const labelId = `dsh-model-default-${id}-${model.id}`
                            return (
                              <div key={model.id} style={styles.defaultEffortRow}>
                                <span id={labelId} style={styles.defaultEffortName} title={model.id}>{model.name}</span>
                                {saving && (
                                  <span style={styles.defaultEffortSaving}>{t('modelDefaultsSaving')}</span>
                                )}
                                <select
                                  style={styles.defaultEffortSelect}
                                  // The row's only accessible name: a sibling
                                  // span is not associated by adjacency, which
                                  // left every select announced identically.
                                  aria-labelledby={labelId}
                                  value={modelDefaultsPending[rowKey] ?? model.configured ?? ''}
                                  disabled={saving}
                                  onChange={(event) => {
                                    void setModelDefault(id, model.id, event.target.value === '' ? undefined : event.target.value)
                                  }}
                                >
                                  <option value="">{t('modelDefaultsFollowProvider')}</option>
                                  {model.efforts.map(effort => (
                                    <option key={effort.id} value={effort.id}>{effort.name}</option>
                                  ))}
                                </select>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {catalog !== undefined && view.shown.length === 0 && filter.trim() !== '' && (
                        <p style={styles.statusLine}>{t('modelDefaultsFilterEmpty', { query: filter.trim() })}</p>
                      )}
                      {/* Models without reasoning levels collapse into one
                          count line instead of one dead row each. */}
                      {view.withoutEfforts > 0 && (
                        <p style={styles.statusLine}>{t('modelDefaultsNoLevels', { count: view.withoutEfforts })}</p>
                      )}
                    </>
                  )}
                </div>
              )
            })()}
            {busy && deviceCode !== undefined && (
              <div style={styles.deviceCode}>
                <span style={styles.statusLine}>{t('deviceCodePrompt')}</span>
                <span style={styles.deviceCodeText}>{deviceCode.userCode}</span>
                <div style={styles.actions}>
                  <button type="button" style={styles.button} onClick={() => { copyDeviceCode(id, deviceCode.userCode) }}>
                    {copiedCode === id ? t('deviceCodeCopied') : t('deviceCodeCopy')}
                  </button>
                  <button
                    type="button"
                    style={styles.button}
                    onClick={() => { window.open(deviceCode.verificationUrl, '_blank', 'noopener') }}
                  >
                    {t('deviceCodeOpenPage')}
                  </button>
                </div>
              </div>
            )}
            {busy && deviceCode === undefined && (
              <details style={styles.manual}>
                <summary>{t('manualSummary')}</summary>
                <div style={styles.manualRow}>
                  <input
                    style={styles.manualInput}
                    value={manualDrafts[id]}
                    placeholder={t('manualPlaceholder')}
                    onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                  />
                  <button type="button" style={styles.button} onClick={() => { void submitManual(id) }}>
                    {t('submit')}
                  </button>
                </div>
              </details>
            )}
          </div>
        )
      })}
      {proxyOpen && (
        <div style={styles.modalOverlay} onClick={() => setProxyOpen(false)}>
          <div style={styles.modal} onClick={event => event.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>{t('proxyDialogTitle')}</span>
              <button type="button" style={{ ...styles.button, marginLeft: 'auto' }} onClick={() => setProxyOpen(false)}>
                {t('proxyDialogClose')}
              </button>
            </div>
            <label style={styles.proxyCheck}>
              <input type="checkbox" checked={proxyEnabled} onChange={event => setProxyEnabled(event.target.checked)} />
              <span>{t('proxyEnabled')}</span>
            </label>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyUrl')}</span>
              <input
                style={styles.proxyInput}
                value={proxyUrl}
                placeholder={t('proxyUrlPlaceholder')}
                onChange={event => setProxyUrl(event.target.value)}
              />
              <p style={styles.proxyHint}>{t('proxyUrlHint')}</p>
            </label>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyUsername')}</span>
              <input
                style={styles.proxyInput}
                value={proxyUsername}
                placeholder={t('proxyUsernamePlaceholder')}
                onChange={event => setProxyUsername(event.target.value)}
              />
            </label>
            <div style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyPassword')}</span>
              <input
                type="password"
                style={styles.proxyInput}
                value={proxyPassword}
                placeholder={t('proxyPasswordPlaceholder')}
                onChange={event => setProxyPassword(event.target.value)}
              />
              <label style={styles.proxyCheck}>
                <input
                  type="checkbox"
                  checked={proxyClearPassword}
                  onChange={event => setProxyClearPassword(event.target.checked)}
                />
                <span>{t('proxyClearPassword')}</span>
              </label>
            </div>
            <label style={styles.proxyField}>
              <span style={styles.proxyLabel}>{t('proxyBypass')}</span>
              <input
                style={styles.proxyInput}
                value={proxyBypass}
                placeholder={t('proxyBypassPlaceholder')}
                onChange={event => setProxyBypass(event.target.value)}
              />
              <p style={styles.proxyHint}>{t('proxyBypassHint')}</p>
            </label>
            <p style={styles.proxyHint}>{t('proxyNote')}</p>
            {proxyMessage !== undefined && (
              <p style={{ ...styles.proxyMessage, color: messageColor(proxyMessage.tone) }}>{proxyMessage.text}</p>
            )}
            {proxyTestResult !== undefined && (
              <p style={{
                ...styles.proxyMessage,
                color: proxyTestResult.ok
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-state-error-primary)',
              }}>
                {proxyTestResult.ok
                  ? (proxyTestResult.viaProxy
                    ? t('proxyTestOk', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) })
                    : t('proxyTestOkDirect', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) }))
                  : t('proxyTestFail', { message: proxyTestResult.error ?? '' })}
              </p>
            )}
            <div style={styles.proxyActions}>
              <button
                type="button"
                style={{ ...styles.button, ...proxyTesting ? { opacity: 0.5, cursor: 'default' } : {} }}
                disabled={proxyTesting}
                onClick={() => { void testProxy() }}
              >
                {proxyTesting ? t('proxyTesting') : t('proxyTest')}
              </button>
              <button
                type="button"
                style={{ ...styles.button, ...proxySaving ? { opacity: 0.5, cursor: 'default' } : {} }}
                disabled={proxySaving}
                onClick={() => { void saveProxy() }}
              >
                {proxySaving ? t('proxySaving') : t('proxySave')}
              </button>
              <button type="button" style={styles.button} onClick={() => setProxyOpen(false)}>
                {t('proxyCancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
