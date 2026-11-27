import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubscriptionUsageBadgeInjected } from './SubscriptionUsageBadge.js'
import { SubscriptionUsageBadge } from './SubscriptionUsageBadge.js'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

type Model = { provider: string; model: string }
type TurnNode = {
  kind: string
  anchorSeq: number
  data: unknown
}
type ChatView = { nodes: { values: () => readonly TurnNode[] } }

/**
 * Child session model directories are unavailable by design. Only claim quota
 * ownership when a completed child's billed request records a route from the
 * subscription provider itself. The final route wins if a turn retries.
 */
export function latestSubagentSubscriptionModel(chat: unknown): Model | undefined {
  if (typeof chat !== 'object' || chat === null || !('nodes' in chat)) return undefined
  const nodes = (chat as ChatView).nodes
  if (!nodes || typeof nodes.values !== 'function') return undefined
  const turnTails = nodes.values()
    .filter(node => node.kind === 'turn-tail')
    .sort((left, right) => right.anchorSeq - left.anchorSeq)
  const latest = turnTails[0]
  if (!latest || typeof latest.data !== 'object' || latest.data === null
    || !('tokenUsage' in latest.data)) return undefined
  const usage = latest.data.tokenUsage
  if (typeof usage !== 'object' || usage === null || !('routes' in usage)
    || !Array.isArray(usage.routes)) return undefined
  const routes = usage.routes as unknown[]
  const route = routes.at(-1)
  if (!route || typeof route !== 'object' || !('provider' in route)
    || !('model' in route) || typeof route.provider !== 'string'
    || typeof route.model !== 'string') return undefined
  return { provider: route.provider, model: route.model }
}

/** Read-only child sessions have no composer dock; put their true provider's quota in the header. */
export function SubagentSubscriptionUsageBadge({
  sessionId, useSession, useSessions, useConversation, rpc, t,
}: PropsRuntime<'conversation.session.header.utilities'>
  & Partial<SubscriptionUsageBadgeInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>) {
  const addressedChild = useSession(snapshot => snapshot.subagent !== null)
  const listedChild = useSessions(state => state.byId[sessionId]?.origin === 'subagent')
  // Chat's completed turn tail contains the actual billed route, unlike
  // a model directory which intentionally rejects subagent sessions.
  const chat = useConversation(state =>
    (state.views as unknown as { get: (target: string) => unknown }).get('chat'))
  const model = latestSubagentSubscriptionModel(chat)
  if (!addressedChild && !listedChild) return null
  return <SubscriptionUsageBadge
    {...(rpc === undefined ? {} : { rpc })}
    currentModel={async () => model}
    {...(t === undefined ? {} : { t })}
    headerPlacement
  />
}
