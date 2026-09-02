import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Config } from '../src/index.js'
import {
  ApprovalReviewRouter,
  AutoReviewGate,
  installAutoReview,
  type ApprovalReviewHostAgent,
  type ApprovalReviewSessionEvent,
  type ApprovalReviewRequest,
  type ApprovalReviewer,
} from '../src/auto-review.js'

test('auto-review is disabled by default and exposes the Codex reviewer choice', () => {
  const config = Config({})

  assert.equal(config.autoReview, 'none')
  assert.equal(Config({ autoReview: 'codex' }).autoReview, 'codex')
  assert.throws(() => Config({ autoReview: 'claude' as 'codex' }), /expected/)
  assert.deepEqual(Config.dict?.autoReview?.list?.map(option => option.meta.description), ['None', 'Codex'])
})

let agentSequence = 0

type ApprovalAskedEvent = Extract<ApprovalReviewSessionEvent, { type: 'approval/asked' }>
type ApprovalDecidedEvent = Extract<ApprovalReviewSessionEvent, { type: 'approval/decided' }>

function fixtureAgent(events: ApprovalReviewSessionEvent[] = []): ApprovalReviewHostAgent {
  agentSequence += 1
  function append(type: ApprovalAskedEvent['type'], data: ApprovalAskedEvent['data']): ApprovalAskedEvent
  function append(type: ApprovalDecidedEvent['type'], data: ApprovalDecidedEvent['data']): ApprovalDecidedEvent
  function append(
    type: ApprovalAskedEvent['type'] | ApprovalDecidedEvent['type'],
    data: ApprovalAskedEvent['data'] | ApprovalDecidedEvent['data'],
  ): ApprovalAskedEvent | ApprovalDecidedEvent {
    if (type === 'approval/asked' && 'toolName' in data) {
      const event: ApprovalAskedEvent = { type, seq: events.length, time: 0, data }
      events.push(event)
      return event
    }
    if (type === 'approval/decided' && 'outcome' in data) {
      const event: ApprovalDecidedEvent = { type, seq: events.length, time: 0, data }
      events.push(event)
      return event
    }
    throw new Error(`invalid fixture approval event: ${type}`)
  }
  return {
    id: `auto-review-agent-${agentSequence}`,
    session: { events, surface: { nodes: [] }, append },
    cancel() {},
  }
}

function toolCallId(value: string) {
  return ToolCallId(value)
}

function execution(agent: ApprovalReviewHostAgent, callId = 'call-1') {
  return {
    name: 'bash',
    callId: toolCallId(callId),
    agent,
    signal: new AbortController().signal,
    arguments: {
      command: 'git fetch upstream',
      workdir: '/repo',
      sandbox_permissions: 'danger-full-access',
      justification: 'Network access is required to fetch upstream.',
    },
  }
}

function reviewer(
  id: ApprovalReviewer['reviewerId'],
  review: (request: ApprovalReviewRequest) => ReturnType<ApprovalReviewer['reviewApproval']>,
): ApprovalReviewer {
  const reviewerLabel = id === 'codex'
    ? 'Codex'
    : id === 'claude'
      ? 'Claude'
      : id === 'grok'
        ? 'Grok'
        : 'GitHub Copilot'
  return { reviewerId: id, reviewerLabel, reviewApproval: review }
}

test('the generic router selects the configured provider implementation', async () => {
  const agent = fixtureAgent()
  const calls: string[] = []
  const router = new ApprovalReviewRouter([
    reviewer('codex', async () => {
      calls.push('codex')
      return { decision: 'allow', reason: 'Allowed by Codex.' }
    }),
    reviewer('claude', async () => {
      calls.push('claude')
      return { decision: 'deny', reason: 'Denied by Claude.' }
    }),
  ], candidate => candidate === agent ? 'claude' : 'codex')

  const decision = await router.review({
    agent,
    action: execution(agent),
    reason: 'Needs approval.',
    signal: new AbortController().signal,
  })

  assert.deepEqual(decision, { decision: 'deny', reason: 'Denied by Claude.' })
  assert.deepEqual(calls, ['claude'])
})

test('the generic router awaits a persisted reviewer selection', async () => {
  const agent = fixtureAgent()
  const calls: string[] = []
  const router = new ApprovalReviewRouter([
    reviewer('codex', async () => {
      calls.push('codex')
      return { decision: 'allow', reason: 'Allowed by persisted Settings.' }
    }),
  ], async (): Promise<'codex'> => {
    await Promise.resolve()
    return 'codex'
  })

  const decision = await router.review({
    agent,
    action: execution(agent),
    signal: new AbortController().signal,
  })

  assert.deepEqual(decision, { decision: 'allow', reason: 'Allowed by persisted Settings.' })
  assert.deepEqual(calls, ['codex'])
})

test('pre-execute only captures the action and provider review starts at the real approval request', async () => {
  const agent = fixtureAgent()
  const requests: ApprovalReviewRequest[] = []
  const router = new ApprovalReviewRouter([
    reviewer('codex', async (request) => {
      requests.push(request)
      return { decision: 'allow', reason: 'Matches the request.' }
    }),
  ], () => 'codex')
  const gate = new AutoReviewGate(router)

  assert.deepEqual(await gate.preExecute(execution(agent), async () => ({
    kind: 'ask',
    reason: 'The command needs network access.',
  })), {
    kind: 'ask',
    reason: 'The command needs network access.',
  })
  assert.equal(requests.length, 0)

  const outcome = await gate.answerApproval({
    agent,
    callId: toolCallId('call-1'),
    toolName: 'bash',
    reason: 'The command needs network access.',
    signal: new AbortController().signal,
  }, async () => 'rejected')

  assert.equal(outcome, 'allowed-once')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.action.name, 'bash')
  assert.deepEqual(requests[0]?.action.arguments, execution(agent).arguments)
  assert.equal(requests[0]?.reason, 'The command needs network access.')
})

test('a routed reviewer records its visible review lifecycle without adding model context', async () => {
  const events: ApprovalReviewSessionEvent[] = []
  const agent = fixtureAgent(events)
  const gate = new AutoReviewGate(new ApprovalReviewRouter([
    reviewer('codex', async () => ({ decision: 'allow', reason: 'The action matches the user request.' })),
  ], () => 'codex'))

  await gate.preExecute(execution(agent, 'visible-review'), async () => ({ kind: 'ask' }))
  const outcome = await gate.answerApproval({
    agent,
    callId: toolCallId('visible-review'),
    toolName: 'bash',
  }, async () => 'rejected')

  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(events.map(event => ({ type: event.type, data: event.data })), [
    {
      type: 'approval/asked',
      data: {
        id: 'auto-review-visible-review',
        toolName: 'auto-review/codex',
        callId: toolCallId('visible-review'),
        reason: 'Codex',
      },
    },
    {
      type: 'approval/decided',
      data: {
        id: 'auto-review-visible-review',
        outcome: 'allowed-once',
      },
    },
  ])
  assert.deepEqual(agent.session.surface.nodes, [])
})

test('one captured action can be reviewed only once', async () => {
  const agent = fixtureAgent()
  let reviews = 0
  let manualApprovals = 0
  const router = new ApprovalReviewRouter([
    reviewer('codex', async () => {
      reviews += 1
      return { decision: 'allow', reason: 'Scoped.' }
    }),
  ], () => 'codex')
  const gate = new AutoReviewGate(router)

  await gate.preExecute(execution(agent), async () => ({ kind: 'ask' }))
  assert.equal(await gate.answerApproval({ agent, callId: toolCallId('call-1'), toolName: 'bash' }, async () => {
    manualApprovals += 1
    return 'rejected'
  }), 'allowed-once')
  assert.equal(await gate.answerApproval({ agent, callId: toolCallId('call-1'), toolName: 'bash' }, async () => {
    manualApprovals += 1
    return 'rejected'
  }), 'rejected')
  assert.equal(reviews, 1)
  assert.equal(manualApprovals, 1)
})

test('deny rejects while ask, missing reviewer, and provider failure use native manual approval', async () => {
  const cases = [
    {
      id: 'deny',
      implementation: reviewer('codex', async () => ({ decision: 'deny', reason: 'Unsafe.' })),
      expected: 'rejected',
      audit: 'rejected',
      manual: 0,
    },
    {
      id: 'ask',
      implementation: reviewer('codex', async () => ({ decision: 'ask', reason: 'Ambiguous.' })),
      expected: 'allowed-once',
      audit: 'unavailable',
      manual: 1,
    },
    {
      id: 'failure',
      implementation: reviewer('codex', async () => { throw new Error('offline') }),
      expected: 'allowed-once',
      audit: 'unavailable',
      manual: 1,
    },
  ] as const

  for (const item of cases) {
    const events: ApprovalReviewSessionEvent[] = []
    const agent = fixtureAgent(events)
    let manual = 0
    const gate = new AutoReviewGate(new ApprovalReviewRouter([item.implementation], () => 'codex'))
    await gate.preExecute(execution(agent, item.id), async () => ({ kind: 'ask' }))
    const outcome = await gate.answerApproval({ agent, callId: toolCallId(item.id), toolName: 'bash' }, async () => {
      manual += 1
      return 'allowed-once'
    })
    assert.equal(outcome, item.expected)
    assert.equal(manual, item.manual)
    const audit = events.findLast(event => event.type === 'approval/decided')
    assert.equal(audit?.data.outcome, item.audit)
  }

  const events: ApprovalReviewSessionEvent[] = []
  const agent = fixtureAgent(events)
  let manual = 0
  const disabled = new AutoReviewGate(new ApprovalReviewRouter([], () => undefined))
  await disabled.preExecute(execution(agent, 'none'), async () => ({ kind: 'ask' }))
  assert.equal(await disabled.answerApproval({ agent, callId: toolCallId('none'), toolName: 'bash' }, async () => {
    manual += 1
    return 'rejected'
  }), 'rejected')
  assert.equal(manual, 1)
  assert.equal(events.length, 0)
})

test('an approval cannot consume another tool or call id', async () => {
  const agent = fixtureAgent()
  let reviews = 0
  const gate = new AutoReviewGate(new ApprovalReviewRouter([
    reviewer('codex', async () => {
      reviews += 1
      return { decision: 'allow', reason: 'Scoped.' }
    }),
  ], () => 'codex'))
  await gate.preExecute(execution(agent), async () => ({ kind: 'ask' }))

  assert.equal(await gate.answerApproval({ agent, callId: toolCallId('other'), toolName: 'bash' }, async () => 'rejected'), 'rejected')
  assert.equal(await gate.answerApproval({ agent, callId: toolCallId('call-1'), toolName: 'write_file' }, async () => 'rejected'), 'rejected')
  assert.equal(reviews, 0)
})

test('an allowed tool can be reviewed if it asks for escalation during execute', async () => {
  const agent = fixtureAgent()
  let reviews = 0
  const gate = new AutoReviewGate(new ApprovalReviewRouter([
    reviewer('codex', async () => {
      reviews += 1
      return { decision: 'allow', reason: 'Scoped.' }
    }),
  ], () => 'codex'))
  await gate.preExecute(execution(agent, 'escalation'), async () => ({ kind: 'allow' }))
  assert.equal(await gate.answerApproval({
    agent,
    callId: toolCallId('escalation'),
    toolName: 'bash',
  }, async () => 'rejected'), 'allowed-once')
  assert.equal(reviews, 1)
})

test('auto-review installer mounts capture and approval wrappers around a generic router', () => {
  const context = new Context()
  const router = new ApprovalReviewRouter([], () => undefined)

  installAutoReview(context, router)

  assert.equal(context.events._hooks['tools/pre-execute']?.length, 1)
  assert.equal(context.events._hooks['tools/pre-execute']?.[0]?.prepend, true)
  assert.equal(context.events._hooks['approval/request']?.length, 1)
  assert.equal(context.events._hooks['approval/request']?.[0]?.prepend, true)
})
