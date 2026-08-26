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

/** Logical RPC channel served by the node half of this plugin. */
const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000

/** Subscription provider ids, fixed by the node half's OAuth adapters. */
export type SubscriptionProvider = 'codex' | 'claude' | 'grok' | 'copilot'

/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
  loggedIn: boolean
  busy: boolean
  expiresAt?: number
  account?: string
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

/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  // Meter geometry follows the shell's own ContextMeter bar (4px, fully
  // rounded, filled track, no border) so a progress bar contributed by a
  // plugin reads as the same control the product draws elsewhere.
  usageTrack: {
    height: 4, borderRadius: 999, overflow: 'hidden',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  usageFill: {
    height: '100%', borderRadius: 999,
    transition: 'width .3s ease, background-color .3s ease',
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
  if (status?.loggedIn === true) return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-dimmed)'
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
  if (status.loggedIn) {
    const params: Record<string, unknown> = {}
    if (status.account !== undefined) params.account = status.account
    if (status.expiresAt !== undefined) params.date = new Date(status.expiresAt).toLocaleString()
    if (params.account !== undefined && params.date !== undefined) return t('loggedInAccountExpires', params)
    if (params.account !== undefined) return t('loggedInAccount', params)
    if (params.date !== undefined) return t('loggedInExpires', params)
    return t('loggedIn')
  }
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

/**
 * Bar fill color. The steps follow the Claude Code app, which warns from 75%
 * rather than 80%, so a plan this panel and that app both report reaches its
 * warning shade at the same point. Below the warning step the meter is the
 * neutral business tone rather than success green: a half-consumed limit is a
 * reading, not an achievement, and green reads as the latter.
 */
function usageBarColor(usedPercent: number): string {
  if (usedPercent >= 95) return 'var(--dsw-alias-state-error-primary)'
  if (usedPercent >= 75) return 'var(--dsw-alias-state-warn-label)'
  return 'var(--dsw-static-blue-450)'
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
  const [usages, setUsages] = useState<Partial<Record<SubscriptionProvider, ProviderUsage>>>({})
  const [usageErrors, setUsageErrors] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const [usageLoading, setUsageLoading] = useState<Partial<Record<SubscriptionProvider, boolean>>>({})
  const mountedRef = useRef(true)
  const pollersRef = useRef(new Map<SubscriptionProvider, ReturnType<typeof setInterval>>())
  /** Providers with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
  const usageInflightRef = useRef(new Set<SubscriptionProvider>())
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
      if (status.loggedIn || !status.busy) {
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

  const loadUsage = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined || usageInflightRef.current.has(provider)) return
    usageInflightRef.current.add(provider)
    setUsageLoading(prev => ({ ...prev, [provider]: true }))
    try {
      const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider })
      if (!mountedRef.current) return
      setUsages(prev => ({ ...prev, [provider]: usage }))
      setUsageErrors((prev) => {
        const next = { ...prev }
        delete next[provider]
        return next
      })
    } catch (error) {
      if (mountedRef.current) setUsageErrors(prev => ({ ...prev, [provider]: messageOf(error) }))
    } finally {
      usageInflightRef.current.delete(provider)
      if (mountedRef.current) setUsageLoading(prev => ({ ...prev, [provider]: false }))
    }
  }, [rpc])

  // Fetch usage once a provider is logged in; drop the cached snapshot on
  // logout so a re-login refetches. A failed lookup does not auto-retry — the
  // per-card Refresh button is the retry path.
  useEffect(() => {
    for (const { id } of PROVIDERS) {
      const status = statuses[id]
      if (status === undefined) continue
      if (status.loggedIn) {
        if (usages[id] === undefined && usageErrors[id] === undefined) void loadUsage(id)
      } else if (usages[id] !== undefined || usageErrors[id] !== undefined) {
        setUsages((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        setUsageErrors((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    }
  }, [statuses, usages, usageErrors, loadUsage])

  const login = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    try {
      const response = await callSubscriptionsAuth<LoginResponse>(rpc, 'login', { provider })
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
      setStatuses(prev => ({ ...prev, [provider]: { ...prev[provider], busy: true, loggedIn: false } }))
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

  const logout = useCallback(async (provider: SubscriptionProvider, name: string): Promise<void> => {
    if (rpc === undefined) return
    if (!window.confirm(t('logoutConfirm', { provider: name }))) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'logout', { provider })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, t, setProviderError, refresh])

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
      <div style={styles.separator} />
      {PROVIDERS.map(({ id, name }) => {
        const status = statuses[id]
        const busy = status?.busy === true
        const deviceCode = deviceCodes[id]
        const usage = usages[id]
        const usageError = usageErrors[id]
        // Providers without a usage endpoint answer supported:false — no block.
        const showUsage = status?.loggedIn === true && usage?.supported !== false
          && (usage !== undefined || usageError !== undefined || usageLoading[id] === true)
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
            <div style={styles.actions}>
              {!busy && status?.loggedIn !== true && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('login')}
                </button>
              )}
              {busy && (
                <button type="button" style={styles.button} onClick={() => { void cancel(id) }}>
                  {t('cancel')}
                </button>
              )}
              {status?.loggedIn === true && (
                <button type="button" style={styles.button} onClick={() => { void logout(id, name) }}>
                  {t('logout')}
                </button>
              )}
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
                    style={{ ...styles.usageRefresh, ...usageLoading[id] === true ? { opacity: 0.5, cursor: 'default' } : {} }}
                    disabled={usageLoading[id] === true}
                    onClick={() => { void loadUsage(id) }}
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
