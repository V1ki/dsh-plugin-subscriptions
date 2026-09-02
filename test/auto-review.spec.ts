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

function fixtureAgent(
  events: ApprovalReviewSessionEvent[] = [],
  origin?: 'subagent',
): ApprovalReviewHostAgent {
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
    session: {
      events,
      surface: { nodes: [] },
      ...origin === undefined ? {} : { header: { origin } },
      append,
    },
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
    return 'allowed-once'
  }), 'rejected')
  assert.equal(reviews, 1)
  assert.equal(manualApprovals, 0)
})

test('deny, ask, and provider failure stay rejected while a reviewer is selected', async () => {
  const cases = [
    {
      id: 'deny',
      implementation: reviewer('codex', async () => ({ decision: 'deny', reason: 'Unsafe.' })),
      expected: 'rejected',
      audit: 'rejected',
    },
    {
      id: 'ask',
      implementation: reviewer('codex', async () => ({ decision: 'ask', reason: 'Ambiguous.' })),
      expected: 'rejected',
      audit: 'unavailable',
    },
    {
      id: 'failure',
      implementation: reviewer('codex', async () => { throw new Error('offline') }),
      expected: 'rejected',
      audit: 'unavailable',
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
    assert.equal(manual, 0)
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

test('a delegated subagent fails closed when its automatic reviewer is unavailable', async () => {
  const agent = fixtureAgent([], 'subagent')
  let manual = 0
  const gate = new AutoReviewGate(new ApprovalReviewRouter([
    reviewer('codex', async () => { throw new Error('reviewer unavailable') }),
  ], () => 'codex'))

  await gate.preExecute(execution(agent, 'delegated-failure'), async () => ({ kind: 'ask' }))
  const outcome = await gate.answerApproval({
    agent,
    callId: toolCallId('delegated-failure'),
    toolName: 'bash',
  }, async () => {
    manual += 1
    return 'allowed-once'
  })

  assert.equal(outcome, 'rejected')
  assert.equal(manual, 0)
})

test('an approval cannot consume another tool or call id', async () => {
  const agent = fixtureAgent()
  let reviews = 0
  let manual = 0
  const gate = new AutoReviewGate(new ApprovalReviewRouter([
    reviewer('codex', async () => {
      reviews += 1
      return { decision: 'allow', reason: 'Scoped.' }
    }),
  ], () => 'codex'))
  await gate.preExecute(execution(agent), async () => ({ kind: 'ask' }))

  assert.equal(await gate.answerApproval({ agent, callId: toolCallId('other'), toolName: 'bash' }, async () => {
    manual += 1
    return 'allowed-once'
  }), 'rejected')
  assert.equal(await gate.answerApproval({ agent, callId: toolCallId('call-1'), toolName: 'write_file' }, async () => {
    manual += 1
    return 'allowed-once'
  }), 'rejected')
  assert.equal(reviews, 0)
  assert.equal(manual, 0)
})

test('a selected reviewer does not fall through when correlation is missing', async () => {
  const agent = fixtureAgent()
  let reviews = 0
  let manual = 0
  const gate = new AutoReviewGate(new ApprovalReviewRouter([
    reviewer('codex', async () => {
      reviews += 1
      return { decision: 'allow', reason: 'Scoped.' }
    }),
  ], () => 'codex'))
  await gate.preExecute(execution(agent), async () => ({ kind: 'ask' }))
  const outcome = await gate.answerApproval({ agent, toolName: 'bash' }, async () => {
    manual += 1
    return 'allowed-once'
  })
  assert.equal(outcome, 'rejected')
  assert.equal(reviews, 0)
  assert.equal(manual, 0)
})

test('a selected reviewer does not fall through after the 64-call eviction window', async () => {
  const agent = fixtureAgent()
  let reviews = 0
  let manual = 0
  const gate = new AutoReviewGate(new ApprovalReviewRouter([
    reviewer('codex', async () => {
      reviews += 1
      return { decision: 'allow', reason: 'Scoped.' }
    }),
  ], () => 'codex'))
  await gate.preExecute(execution(agent, 'evicted'), async () => ({ kind: 'ask' }))
  for (let index = 0; index < 64; index += 1) {
    await gate.preExecute(execution(agent, `keep-${index}`), async () => ({ kind: 'ask' }))
  }
  const outcome = await gate.answerApproval({
    agent,
    callId: toolCallId('evicted'),
    toolName: 'bash',
  }, async () => {
    manual += 1
    return 'allowed-once'
  })
  assert.equal(outcome, 'rejected')
  assert.equal(reviews, 0)
  assert.equal(manual, 0)
})

test('a selected-reviewer abort is cancelled rather than denied', async () => {
  const agent = fixtureAgent()
  let manual = 0
  const gate = new AutoReviewGate(new ApprovalReviewRouter([
    reviewer('codex', async () => { throw new Error('offline') }),
  ], () => 'codex'))
  const signal = AbortSignal.abort()
  await gate.preExecute(execution(agent, 'aborted'), async () => ({ kind: 'ask' }))
  const outcome = await gate.answerApproval({
    agent,
    callId: toolCallId('aborted'),
    toolName: 'bash',
    signal,
  }, async () => {
    manual += 1
    return 'allowed-once'
  })
  assert.equal(outcome, 'cancelled')
  assert.equal(manual, 0)
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

test('a same-mode sandbox denial is retried inside the original Bash call', async () => {
  const context = new Context()
  const agent = fixtureAgent()
  const retries: Array<{ callId: unknown; rootCallId: unknown; name: string; arguments: unknown; parent: unknown }> = []
  context.provide('tools', {
    async execute(input: typeof retries[number] & { signal: AbortSignal }) {
      retries.push(input)
      return {
        isError: false as const,
        value: {
          kind: 'foreground',
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 10_000,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: 'danger-full-access', denied: false },
        },
        content: [{ type: 'text' as const, text: '[exit code: 0]' }],
      }
    },
  })
  installAutoReview(context, new ApprovalReviewRouter([
    reviewer('codex', async () => ({ decision: 'allow', reason: 'Matches the request.' })),
  ], () => 'codex'))

  const hook = context.events._hooks['tools/post-execute']?.[0]?.callback
  assert.equal(typeof hook, 'function')
  const callId = toolCallId('sandbox-retry')
  const token = Symbol('outer-tool-call')
  const outer = execution(agent, 'sandbox-retry')
  const decision = await hook?.({
    ...outer,
    arguments: {
      command: 'rm -rf /tmp/requested-smoke-test',
      description: 'Remove requested smoke test directory',
      sandbox_permissions: 'workspace-write',
      justification: 'Remove the requested directory outside the session workspace.',
    },
    rootCallId: callId,
    token,
  }, {
    isError: false,
    value: {
      kind: 'foreground',
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 10_000,
      stdout: { text: '', truncated: false },
      stderr: { text: 'Operation not permitted', truncated: false },
      sandbox: { mode: 'workspace-write', denied: true },
    },
    content: [{ type: 'text', text: 'Operation not permitted\n[sandbox: file access denied under workspace-write mode]\n[exit code: 1]' }],
  }, async () => ({ kind: 'accept' }))

  assert.equal(retries.length, 1)
  assert.deepEqual(retries[0], {
    callId: toolCallId('sandbox-retry:auto-review-retry'),
    rootCallId: callId,
    name: 'bash',
    arguments: {
      command: 'rm -rf /tmp/requested-smoke-test',
      description: 'Remove requested smoke test directory',
      sandbox_permissions: 'danger-full-access',
      justification: 'The sandbox denied this exact command under workspace-write; retry it once with danger-full-access.',
    },
    parent: token,
    agent,
    signal: outer.signal,
  })
  assert.deepEqual(decision, {
    kind: 'accept',
    value: {
      kind: 'foreground',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 10_000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'danger-full-access', denied: false },
    },
  })
})
