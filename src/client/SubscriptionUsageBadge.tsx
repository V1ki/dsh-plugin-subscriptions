/**
 * Subscription usage badge: a compact readout in the composer's stats strip
 * (`conversation.composer.dock`), showing rate-limit window percentages for
 * each provider's DEFAULT account (Claude, Codex, etc.). Polls the
 * `/subscriptions-auth` `status` + `usage` endpoints on a slow interval;
 * renders nothing when no provider has a logged-in account or usage is
 * unsupported.
 *
 * Only the default account is shown — the same account direct (non-pool)
 * routes serve — so the badge stays a single compact line even for a
 * provider with several accounts connected. The full per-account breakdown
 * already lives in Settings → Subscriptions.
 *
 * Every color resolves through a `--dsw-alias-*` design token; this component
 * uses no locale `t` — it renders fixed short labels (provider names,
 * "5h", "Wk") that are universal.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import type { AccountStatus, ProviderStatus, ProviderUsage, SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'

/** How often the badge re-reads usage; the server also shares its own cache/negative-cache across UI surfaces. */
const POLL_INTERVAL_MS = 15 * 60_000

/** Injected dependencies (slot `inject`). */
export interface SubscriptionUsageBadgeInjected {
  /** Connection RPC caller to reach the `/subscriptions-auth` channel. */
  rpc: ConnectionHandle['rpc']
}

/** Props delivered by the slot outlet + inject. */
export type SubscriptionUsageBadgeProps = PropsRuntime<'conversation.composer.dock'>
  & Partial<SubscriptionUsageBadgeInjected>

/** One provider's usage snapshot as rendered by the badge (default account only). */
interface ProviderUsageDisplay {
  provider: SubscriptionProvider
  name: string
  windows: UsageWindow[]
}

/** Brand display names (short form for the compact badge). */
const PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  copilot: 'Copilot',
}

/**
 * Compact time-remaining label derived from the window's `resetsAt` timestamp:
 * "6d18h" (days+hours), "1h58m" (hours+minutes), or "42m" (minutes only).
 * Falls back to the scope/kind abbreviation when no reset time is known.
 */
function windowLabel(w: UsageWindow): string {
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

/** The default account of a provider's account list, when any is logged in. */
function defaultAccountOf(status: ProviderStatus | undefined): AccountStatus | undefined {
  if (status === undefined || status.accounts.length === 0) return undefined
  return status.accounts.find(a => a.isDefault) ?? status.accounts[0]
}

/**
 * The composer subscription-usage badge. Renders a compact text segment like
 * `Claude 1h58m 13% · 6d18h 3%` (time-remaining + used%) — one segment per
 * provider with a logged-in default account that supports usage. Returns
 * null when no data is available.
 */
export function SubscriptionUsageBadge({ rpc }: SubscriptionUsageBadgeProps) {
  const [displays, setDisplays] = useState<ProviderUsageDisplay[]>([])
  const inflightRef = useRef(false)
  const mountedRef = useRef(true)
  // Last-known-good display per provider, kept across a failed poll (e.g. a
  // 429 during the server's own negative-cache cooldown) so the segment
  // doesn't flicker away — it only disappears once the default account
  // actually logs out or a fetch succeeds but reports the window as
  // unsupported.
  const lastKnownRef = useRef(new Map<SubscriptionProvider, ProviderUsageDisplay>())

  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined || inflightRef.current) return
    inflightRef.current = true
    try {
      const statusResp = await callSubscriptionsAuth<{
        providers: Record<SubscriptionProvider, ProviderStatus>
      }>(rpc, 'status', {})
      if (!mountedRef.current) return

      const accounts = new Map<SubscriptionProvider, string>()
      for (const id of Object.keys(statusResp.providers) as SubscriptionProvider[]) {
        const account = defaultAccountOf(statusResp.providers[id])
        if (account !== undefined) accounts.set(id, account.key)
      }

      const lastKnown = lastKnownRef.current
      // Drop last-known state for anything no longer logged in — that is a
      // real signal, unlike a fetch failure.
      for (const provider of lastKnown.keys()) {
        if (!accounts.has(provider)) lastKnown.delete(provider)
      }

      if (accounts.size === 0) {
        setDisplays([])
        return
      }

      const results = await Promise.allSettled(
        [...accounts.entries()].map(async ([provider, account]) => {
          const usage = await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider, account })
          return { provider, usage }
        }),
      )
      if (!mountedRef.current) return

      for (const r of results) {
        if (r.status !== 'fulfilled') continue // keep whatever is cached for this provider
        const { provider, usage } = r.value
        if (!usage.supported || !usage.windows || usage.windows.length === 0) {
          lastKnown.delete(provider)
          continue
        }
        lastKnown.set(provider, { provider, name: PROVIDER_NAMES[provider], windows: usage.windows })
      }
      // Render in a stable order (the account map's insertion order, which
      // follows Object.keys(statusResp.providers)) so a segment doesn't jump
      // around as polls settle at different times.
      const order = [...accounts.keys()]
      setDisplays(order.map(provider => lastKnown.get(provider)).filter((d): d is ProviderUsageDisplay => d !== undefined))
    } catch {
      // A failed poll must not crash the badge; keep last known state.
    } finally {
      inflightRef.current = false
    }
  }, [rpc])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [refresh])

  if (displays.length === 0) return null

  const segments: string[] = []
  for (const d of displays) {
    const parts = d.windows.map(w => `${windowLabel(w)} ${Math.round(Math.min(100, Math.max(0, w.usedPercent)))}%`)
    segments.push(`${d.name} ${parts.join(' · ')}`)
  }

  return <span style={styles.root}>{segments.join(' | ')}</span>
}

const styles: Record<string, CSSProperties> = {
  root: {
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 12,
    lineHeight: '18px',
    whiteSpace: 'nowrap',
  },
}
