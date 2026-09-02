/** Provider-neutral routing for automatic reviews of native approval requests. */

import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
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
    readonly header?: {
      readonly origin?: 'subagent'
    }
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
  /**
   * When true, an unavailable or failed review stays denied and must not
   * fall through to a human prompt. Codex leaves this unset.
   */
  readonly failClosed?: boolean
  /** False when the provider has no usable login; the selector omits it. */
  isAvailable?(): Promise<boolean>
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
    onRouted?: (reviewerId: ProviderId, reviewerLabel: string, failClosed: boolean) => void,
  ): Promise<ApprovalReviewDecision | undefined> {
    const reviewer = await this.selectedReviewer(request.agent)
    if (reviewer === undefined) return undefined
    onRouted?.(reviewer.reviewerId, reviewer.reviewerLabel, reviewer.failClosed === true)
    return reviewer.reviewApproval(request)
  }

  /** The registered reviewer this agent currently selects, if any. */
  async selectedReviewer(agent: ApprovalReviewAgent): Promise<ApprovalReviewer | undefined> {
    const reviewerId = await this.reviewerFor(agent)
    if (reviewerId === undefined) return undefined
    return this.reviewers.get(reviewerId)
  }

  /** Whether this agent currently selects one registered machine reviewer. */
  async hasReviewer(agent: ApprovalReviewAgent): Promise<boolean> {
    return (await this.selectedReviewer(agent)) !== undefined
  }
}

export type GatePreToolDecision = PreToolDecision

export type GateApprovalOutcome = ApprovalOutcome

export type GateExecution = ApprovalExecutionFields

interface GateRetryExecution {
  readonly callId: ToolExecution['callId']
  readonly name: ToolExecution['name']
  readonly arguments: ToolExecution['arguments']
  readonly signal: ToolExecution['signal']
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build the single narrowest retry sanctioned by a structured Bash denial. */
function sandboxRetryArguments(
  exec: GateExecution,
  result: Readonly<ToolExecutionResult>,
): Record<string, unknown> | undefined {
  if (exec.name !== 'bash' || result.isError || !isRecord(exec.arguments) || !isRecord(result.value)) {
    return undefined
  }
  if (result.value.kind !== 'foreground' || !isRecord(result.value.sandbox)) return undefined
  const sandbox = result.value.sandbox
  if (sandbox.denied !== true) return undefined
  // A requested mode equal to the mode that actually ran is not a completed
  // widening. DSH may tolerate that same-mode request as a no-op, and child
  // models commonly emit it up front. A different requested mode is an
  // inconsistent result, so leave it to the native flow rather than guess.
  const requestedMode = exec.arguments.sandbox_permissions
  if (requestedMode !== undefined && requestedMode !== sandbox.mode) return undefined
  const target = sandbox.mode === 'read-only'
    ? 'workspace-write'
    : sandbox.mode === 'workspace-write'
      ? 'danger-full-access'
      : undefined
  if (target === undefined) return undefined
  return {
    ...exec.arguments,
    sandbox_permissions: target,
    justification: `The sandbox denied this exact command under ${sandbox.mode}; retry it once with ${target}.`,
  }
}

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
    const selected = await this.router.selectedReviewer(request.agent)
    const failClosedSelected = selected?.failClosed === true
    const fallback = (): Promise<GateApprovalOutcome> => request.agent.session.header?.origin === 'subagent'
      || failClosedSelected
      ? Promise.resolve(request.signal?.aborted ? 'cancelled' : 'rejected')
      : next()
    if (request.callId === undefined) return fallback()
    const callId = request.callId
    const action = this.candidates.get(request.agent)?.get(callId)
    if (action === undefined || action.name !== request.toolName) return fallback()
    this.consume(request.agent, callId)

    const signal = request.signal ?? action.signal
    let reviewId: ReturnType<typeof ApprovalRequestId> | undefined
    let failClosed = false
    let decision: ApprovalReviewDecision | undefined
    const closeOrAsk = (): Promise<GateApprovalOutcome> => {
      if (request.agent.session.header?.origin === 'subagent' || failClosed) {
        return Promise.resolve(signal.aborted ? 'cancelled' : 'rejected')
      }
      return fallback()
    }
    try {
      decision = await this.router.review({
        agent: request.agent,
        action: { name: action.name, callId: action.callId, arguments: action.arguments },
        ...request.reason === undefined ? {} : { reason: request.reason },
        signal,
      }, (reviewerId, reviewerLabel, closed) => {
        failClosed = closed
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
      return closeOrAsk()
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
    return closeOrAsk()
  }

  /** Collapse a denied Bash call and its sanctioned escalation into one model-visible call. */
  async postExecute(
    exec: GateExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
    retry: (execution: GateRetryExecution) => Promise<ToolExecutionResult>,
  ): Promise<PostToolDecision> {
    const retryArguments = sandboxRetryArguments(exec, result)
    if (retryArguments === undefined || exec.agent === undefined) return next()
    try {
      if (!await this.router.hasReviewer(exec.agent)) return next()
      // This completed denial will not ask for approval itself; only its nested
      // escalation can do so, and that call receives its own correlation id.
      this.consume(exec.agent, exec.callId)
      const retried = await retry({
        callId: ToolCallId(`${String(exec.callId)}:auto-review-retry`),
        name: exec.name,
        arguments: retryArguments,
        signal: exec.signal,
      })
      if (retried.isError) {
        return {
          kind: 'block',
          feedback: retried.content,
          ...retried.additionalContexts === undefined ? {} : { additionalContexts: retried.additionalContexts },
        }
      }
      return {
        kind: 'accept',
        value: retried.value,
        ...retried.additionalContexts === undefined ? {} : { additionalContexts: retried.additionalContexts },
      }
    } catch {
      // A retry plumbing failure must not hide the original structured denial.
      return next()
    }
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
  context.on('tools/post-execute', (exec, result, next) => gate.postExecute(
    exec,
    result,
    next,
    retry => context.tools.execute({
      ...retry,
      rootCallId: exec.rootCallId,
      parent: exec.token,
      ...exec.agent === undefined ? {} : { agent: exec.agent },
    }),
  ), { prepend: true })
  context.on('approval/request', (request, next) => gate.answerApproval(request, next), { prepend: true })
}
