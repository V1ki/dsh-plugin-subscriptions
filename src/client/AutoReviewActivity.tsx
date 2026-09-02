import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {
  ConversationLocation,
  ConversationNodeDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const REVIEW_TOOL_PREFIX = 'auto-review/'
const REVIEW_ID_PREFIX = 'auto-review-'

export interface AutoReviewActivityData {
  readonly provider: string
  readonly callId: string
  readonly outcome?: ApprovalOutcome
}

interface AutoReviewActivityState extends AutoReviewActivityData {
  readonly seq: number
}

interface AutoReviewActivityNode extends ConversationViewNode {
  readonly kind: 'auto-review'
  readonly target: 'chat'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly visibility: 'visible'
  readonly data: AutoReviewActivityData
}

interface AutoReviewEventRegistry {
  register(definition: ConversationNodeDefinition<AutoReviewActivityState>): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH 0.1.1 Conversation event registry; newer hosts expose it through uiConversation.events. */
    conversationEvents: AutoReviewEventRegistry
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Keyed Chat renderer declared by the host Conversation view. */
    'conversation.chat.node': {
      kind: 'keyed'
      scope: 'session'
      keyProps: {
        'auto-review': { node: AutoReviewActivityNode }
      }
    }
  }
}

export type AutoReviewActivityProps = PropsRuntime<'conversation.chat.node', 'auto-review'>

/** Stable copy shared by the live and replayed Chat card. */
export function formatAutoReviewActivity(provider: string, outcome?: string): string {
  const result = outcome === undefined
    ? 'Reviewing...'
    : outcome === 'allowed-once'
      ? 'Allowed'
      : outcome === 'rejected'
        ? 'Denied'
        : outcome === 'unavailable'
          ? provider === 'Grok' ? 'Unavailable' : 'Manual approval'
          : outcome === 'cancelled'
            ? 'Cancelled'
            : 'Completed'
  return `Auto-Review · ${provider} · ${result}`
}

/** Fold the plugin's paired log-only approval audit events into one Chat node. */
export const autoReviewActivityDefinition: ConversationNodeDefinition<AutoReviewActivityState> = {
  kind: 'auto-review',
  target: 'chat',
  match(event) {
    if (event.type === 'approval/asked' && event.data.toolName.startsWith(REVIEW_TOOL_PREFIX)) {
      return { id: String(event.data.id), role: 'start' }
    }
    if (event.type === 'approval/decided' && String(event.data.id).startsWith(REVIEW_ID_PREFIX)) {
      return { id: String(event.data.id), role: 'update' }
    }
    return null
  },
  start(_context, match) {
    if (match.event.type !== 'approval/asked' || match.event.data.callId === undefined) {
      throw new Error('auto-review activity start requires an approval/asked event with a call id')
    }
    const reviewerId = match.event.data.toolName.slice(REVIEW_TOOL_PREFIX.length)
    return {
      provider: match.event.data.reason ?? reviewerId,
      callId: String(match.event.data.callId),
      seq: match.event.seq,
    }
  },
  update(context, match) {
    if (match.event.type !== 'approval/decided') return context.state
    return { ...context.state, outcome: match.event.data.outcome }
  },
  buildViewNode(context) {
    if (context.state === undefined) return null
    const data: AutoReviewActivityData = {
      provider: context.state.provider,
      callId: context.state.callId,
      ...context.state.outcome === undefined ? {} : { outcome: context.state.outcome },
    }
    const node: AutoReviewActivityNode = {
      key: context.key,
      kind: 'auto-review',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data,
    }
    return node
  },
}

/** Compact log-only status row; it never becomes part of the model-visible surface. */
export function AutoReviewActivity({ node }: AutoReviewActivityProps) {
  const outcome = node.data.outcome
  return (
    <div className="dsh-auto-review-activity" data-outcome={outcome ?? 'reviewing'} role="status">
      <span className="dsh-auto-review-activity-dot" aria-hidden="true" />
      <span>{formatAutoReviewActivity(node.data.provider, outcome)}</span>
    </div>
  )
}

/** Register the audit-event projection against either supported DSH Conversation service shape. */
export function registerAutoReviewActivity(ctx: ClientContext): void {
  let definitionRegistered = false
  const registerDefinition = (registry: AutoReviewEventRegistry): void => {
    if (definitionRegistered) return
    definitionRegistered = true
    registry.register(autoReviewActivityDefinition)
  }

  ctx.inject(['conversationEvents'], scope => {
    registerDefinition(scope.conversationEvents)
  })
  ctx.inject(['uiConversation'], scope => {
    registerDefinition(scope.uiConversation.events)
  })

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'auto-review',
  }, AutoReviewActivity))

  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dsh-plugin-subscriptions-auto-review')
    style.textContent = `
      .dsh-auto-review-activity {
        color: var(--dsw-alias-label-tertiary);
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 0;
        font-size: 13px;
        line-height: 20px;
      }
      .dsh-auto-review-activity-dot {
        width: 7px;
        height: 7px;
        flex: none;
        border-radius: 999px;
        background: var(--dsw-alias-state-business-primary);
      }
      .dsh-auto-review-activity[data-outcome="allowed-once"] .dsh-auto-review-activity-dot {
        background: #28a745;
      }
      .dsh-auto-review-activity[data-outcome="rejected"] .dsh-auto-review-activity-dot {
        background: #dc3545;
      }
      .dsh-auto-review-activity[data-outcome="unavailable"] .dsh-auto-review-activity-dot,
      .dsh-auto-review-activity[data-outcome="cancelled"] .dsh-auto-review-activity-dot {
        background: #d99a00;
      }
    `
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-plugin-subscriptions: auto-review Chat activity style')
}
