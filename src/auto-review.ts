/** Provider-neutral routing for automatic reviews of native approval requests. */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ProviderId } from './auth/store.js'

type DshToolAgent = NonNullable<ToolExecution['agent']>

/** One exact durable event from the DSH agent session. */
export type ApprovalReviewSessionEvent = DshToolAgent['session']['events'][number]

type ApprovalAskedEvent = Extract<ApprovalReviewSessionEvent, { readonly type: 'approval/asked' }>
type ApprovalDecidedEvent = Extract<ApprovalReviewSessionEvent, { readonly type: 'approval/decided' }>

/** The only cancellation capability an automatic reviewer may exercise. */
export type ApprovalReviewCancellation = Extract<
  Parameters<DshToolAgent['cancel']>[0],
  { readonly kind: 'hook' }
>

/**
 * Least-privilege view of the live DSH agent shared with reviewer providers.
 * A real DSH Agent satisfies it structurally; reviewers cannot reach unrelated
 * agent state, and test doubles remain fully type-checked without assertions.
 */
export interface ApprovalReviewAgent {
  readonly id: string
  readonly session: {
    readonly events: readonly ApprovalReviewSessionEvent[]
    readonly surface: {
      readonly nodes: readonly number[]
    }
  }
  cancel(cause: ApprovalReviewCancellation): void
}

/** Host-only audit capability; provider implementations receive the narrower read-only agent above. */
export interface ApprovalReviewHostAgent extends ApprovalReviewAgent {
  readonly session: ApprovalReviewAgent['session'] & {
    append(type: ApprovalAskedEvent['type'], data: ApprovalAskedEvent['data']): ApprovalAskedEvent
    append(type: ApprovalDecidedEvent['type'], data: ApprovalDecidedEvent['data']): ApprovalDecidedEvent
  }
}

/**
 * Least-privilege tool execution retained until the matching approval request.
 * `arguments` intentionally remains `unknown`: that is the upstream DSH
 * ToolExecution contract after registry validation, not an untyped local API.
 */
interface ApprovalExecutionFields {
  readonly name: ToolExecution['name']
  readonly callId: ToolExecution['callId']
  readonly arguments: ToolExecution['arguments']
  readonly agent?: ApprovalReviewHostAgent
  readonly signal: ToolExecution['signal']
}

/** Exact tool action captured before the tool asks the native approval service. */
export type ApprovalReviewAction = Pick<ApprovalExecutionFields, 'name' | 'callId' | 'arguments'>

/** Provider-neutral request passed only after a real native approval prompt exists. */
export interface ApprovalReviewRequest {
  readonly agent: ApprovalReviewAgent
  readonly action: ApprovalReviewAction
  readonly reason?: string
  readonly signal: AbortSignal
}

/** Closed review result. `ask` delegates the same request to the native human reviewer. */
export interface ApprovalReviewDecision {
  readonly decision: 'allow' | 'deny' | 'ask'
  readonly reason: string
}

/**
 * One provider-owned automatic reviewer implementation.
 *
 * The provider owns classifier policy, transcript projection, transport,
 * retries, and provider-specific failure semantics. The shared gate only
 * routes a real DSH approval request and preserves manual approval as its
 * fallback.
 */
export interface ApprovalReviewer {
  readonly reviewerId: ProviderId
  /** User-facing provider name used by the selector and review activity. */
  readonly reviewerLabel: string
  reviewApproval(request: ApprovalReviewRequest): Promise<ApprovalReviewDecision | undefined>
}

/** Routes one real approval request to the reviewer selected for that session. */
export class ApprovalReviewRouter {
  private readonly reviewers = new Map<ProviderId, ApprovalReviewer>()

  constructor(
    reviewers: Iterable<ApprovalReviewer>,
    private readonly reviewerFor: (
      agent: ApprovalReviewAgent,
    ) => ProviderId | undefined | Promise<ProviderId | undefined>,
  ) {
    for (const reviewer of reviewers) {
      if (this.reviewers.has(reviewer.reviewerId)) {
        throw new Error(`duplicate approval reviewer: ${reviewer.reviewerId}`)
      }
      this.reviewers.set(reviewer.reviewerId, reviewer)
    }
  }

  async review(
    request: ApprovalReviewRequest,
    onRouted?: (reviewerId: ProviderId, reviewerLabel: string) => void,
  ): Promise<ApprovalReviewDecision | undefined> {
    const reviewerId = await this.reviewerFor(request.agent)
    if (reviewerId === undefined) return undefined
    const reviewer = this.reviewers.get(reviewerId)
    if (reviewer === undefined) return undefined
    onRouted?.(reviewerId, reviewer.reviewerLabel)
    return reviewer.reviewApproval(request)
  }
}

export type GatePreToolDecision = PreToolDecision

export type GateApprovalOutcome = ApprovalOutcome

export type GateExecution = ApprovalExecutionFields

export interface GateApprovalRequest {
  readonly agent: ApprovalReviewHostAgent
  readonly toolName: string
  readonly callId?: ToolExecution['callId']
  readonly reason?: string
  readonly signal?: AbortSignal
}

/**
 * Local safeguard, not a Codex constant. Sixty-four is above a plausible
 * parallel approval burst while bounding orphaned `ask` calls that never reach
 * `approval/request`; an evicted call simply uses native manual approval.
 */
const MAX_RECENT_CANDIDATES = 64

/**
 * Bridges the tool lifecycle to the native approval waterfall. Capturing is
 * deliberately model-free: the router is called only by `answerApproval`,
 * after the tool has actually asked the user for permission.
 */
export class AutoReviewGate {
  private readonly candidates = new WeakMap<ApprovalReviewHostAgent, Map<ToolExecution['callId'], GateExecution>>()

  constructor(private readonly router: ApprovalReviewRouter) {}

  async preExecute(
    exec: GateExecution,
    next: () => Promise<GatePreToolDecision>,
  ): Promise<GatePreToolDecision> {
    const downstream = await next()
    // Approval may follow either directly from an `ask` decision or later from
    // inside an allowed tool (bash/fs sandbox escalation). Retain both without
    // invoking a reviewer; only a matching real `approval/request` does that.
    if (downstream.kind !== 'deny' && exec.agent !== undefined) this.remember(exec.agent, exec)
    return downstream
  }

  async answerApproval(
    request: GateApprovalRequest,
    next: () => Promise<GateApprovalOutcome>,
  ): Promise<GateApprovalOutcome> {
    if (request.callId === undefined) return next()
    const callId = request.callId
    const action = this.candidates.get(request.agent)?.get(callId)
    if (action === undefined || action.name !== request.toolName) return next()
    this.consume(request.agent, callId)

    const signal = request.signal ?? action.signal
    let reviewId: ReturnType<typeof ApprovalRequestId> | undefined
    let decision: ApprovalReviewDecision | undefined
    try {
      decision = await this.router.review({
        agent: request.agent,
        action: { name: action.name, callId: action.callId, arguments: action.arguments },
        ...request.reason === undefined ? {} : { reason: request.reason },
        signal,
      }, (reviewerId, reviewerLabel) => {
        reviewId = ApprovalRequestId(`auto-review-${String(callId)}`)
        request.agent.session.append('approval/asked', {
          id: reviewId,
          toolName: `auto-review/${reviewerId}`,
          callId,
          reason: reviewerLabel,
        })
      })
    } catch {
      if (reviewId !== undefined) {
        request.agent.session.append('approval/decided', {
          id: reviewId,
          outcome: signal.aborted ? 'cancelled' : 'unavailable',
        })
      }
      return next()
    }
    if (reviewId !== undefined) {
      request.agent.session.append('approval/decided', {
        id: reviewId,
        outcome: decision?.decision === 'allow'
          ? 'allowed-once'
          : decision?.decision === 'deny'
            ? 'rejected'
            : 'unavailable',
      })
    }
    if (decision?.decision === 'allow') return 'allowed-once'
    if (decision?.decision === 'deny') return 'rejected'
    return next()
  }

  private remember(agent: ApprovalReviewHostAgent, exec: GateExecution): void {
    let recent = this.candidates.get(agent)
    if (recent === undefined) {
      recent = new Map()
      this.candidates.set(agent, recent)
    }
    recent.delete(exec.callId)
    recent.set(exec.callId, exec)
    while (recent.size > MAX_RECENT_CANDIDATES) {
      const oldest = recent.keys().next().value
      if (oldest === undefined) break
      recent.delete(oldest)
    }
  }

  private consume(agent: ApprovalReviewHostAgent, callId: ToolExecution['callId']): void {
    const recent = this.candidates.get(agent)
    recent?.delete(callId)
    if (recent?.size === 0) this.candidates.delete(agent)
  }
}

/** Mount capture and approval wrappers around one shared reviewer router. */
export function installAutoReview(
  context: Context,
  router: ApprovalReviewRouter,
): void {
  const gate = new AutoReviewGate(router)
  context.on('tools/pre-execute', (exec, next) => gate.preExecute(exec, next), { prepend: true })
  context.on('approval/request', (request, next) => gate.answerApproval(request, next), { prepend: true })
}
