import { type AgentRuntime, RUNTIME_CAPABILITIES, type RunControl, type RunEvent, type RunEventBody, type RunSpec } from '@factorix/runtime'
import { describe, expect, it, vi } from 'vitest'
import { ScriptedRuntime } from './adapters/scripted'
import { RunnerSession } from './session'

const io = { workspaceDir: '/tmp', homeDir: '/tmp', factorixDir: '/tmp' }

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: 'run-1',
    attempt: 1,
    phase: 'implement',
    cwd: '/tmp',
    runtime: 'scripted',
    model: {},
    prompt: { system: '', user: '' },
    mcpServers: {},
    policy: { mode: 'full', allow: [], deny: [], requireApproval: [], networkAccess: false },
    startSeq: 0,
    ...overrides,
  }
}

function fakeRuntime(run: (control: RunControl) => AsyncIterable<RunEventBody>): AgentRuntime {
  return {
    id: 'scripted',
    listModels: async () => ({ defaultModel: null, models: [] }),
    capabilities: () => RUNTIME_CAPABILITIES.scripted,
    prepare: async () => {},
    run: (_spec, control) => run(control),
  }
}

function collect() {
  const events: RunEvent[] = []
  return { events, emit: (event: RunEvent) => void events.push(event) }
}

describe('RunnerSession', () => {
  it('sequences events from startSeq and leaves partials unsequenced', async () => {
    const { events, emit } = collect()
    const runtime = fakeRuntime(async function* () {
      yield { type: 'message', role: 'assistant', text: 'par', partial: true, messageId: 'm' }
      yield { type: 'message', role: 'assistant', text: 'partial', messageId: 'm' }
    })
    await new RunnerSession({ spec: spec({ startSeq: 41 }), runtime, io, emit }).run()
    expect(events.map((e) => [e.type, e.seq])).toEqual([
      ['status', 42],
      ['message', 0],
      ['message', 43],
      ['done', 44],
    ])
  })

  it('always ends with exactly one done, even when the adapter throws', async () => {
    const { events, emit } = collect()
    const runtime = fakeRuntime(async function* () {
      yield { type: 'log', level: 'info', message: 'before' }
      throw new Error('boom')
    })
    await new RunnerSession({ spec: spec(), runtime, io, emit }).run()
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'failed' })
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'runtime_crash', message: 'boom', fatal: true })
  })

  it('drops anything an adapter emits after done', async () => {
    const { events, emit } = collect()
    const runtime = fakeRuntime(async function* () {
      yield {
        type: 'done',
        outcome: 'completed',
        finalText: 'x',
        sessionRef: 's',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 },
      }
      yield { type: 'log', level: 'info', message: 'late' }
    })
    await new RunnerSession({ spec: spec(), runtime, io, emit }).run()
    expect(events.at(-1)?.type).toBe('done')
  })

  it('round-trips an approval through the wire protocol', async () => {
    const { events, emit } = collect()
    const session: RunnerSession = new RunnerSession({
      spec: spec({ scripted: { steps: [{ askApproval: { tool: 'Bash', summary: 'rm -rf' } }] } }),
      runtime: new ScriptedRuntime(),
      io,
      emit: (event) => {
        emit(event)
        if (event.type === 'approval.requested')
          queueMicrotask(() => session.handleCommand({ type: 'approval.decide', approvalId: event.approvalId, decision: 'approve' }))
      },
    })
    await session.run()
    const types = events.map((e) => e.type)
    expect(types.indexOf('approval.requested')).toBeLessThan(types.indexOf('approval.resolved'))
    expect(events.find((e) => e.type === 'message')).toMatchObject({ text: 'Approval was approved' })
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'completed' })
  })

  it('rejects pending approvals and reports cancelled on cancel', async () => {
    const { events, emit } = collect()
    const session: RunnerSession = new RunnerSession({
      spec: spec({ scripted: { steps: [{ askApproval: { tool: 'Bash', summary: 'x' } }, { say: 'never reached' }] } }),
      runtime: new ScriptedRuntime(),
      io,
      emit: (event) => {
        emit(event)
        if (event.type === 'approval.requested') queueMicrotask(() => session.handleCommand({ type: 'cancel', reason: 'test', graceSeconds: 30 }))
      },
    })
    await session.run()
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'cancelled' })
    expect(events.some((e) => e.type === 'message' && e.text === 'never reached')).toBe(false)
  })

  it('force-finishes a run whose adapter ignores cancellation', async () => {
    vi.useFakeTimers()
    try {
      const { events, emit } = collect()
      const onForceExit = vi.fn()
      const runtime = fakeRuntime(async function* () {
        yield { type: 'log', level: 'info', message: 'stuck' }
        await new Promise(() => {})
      })
      const session = new RunnerSession({ spec: spec(), runtime, io, emit, onForceExit })
      void session.run()
      await vi.advanceTimersByTimeAsync(0)
      session.handleCommand({ type: 'cancel', reason: 'test', graceSeconds: 5 })
      await vi.advanceTimersByTimeAsync(5000)
      expect(onForceExit).toHaveBeenCalledOnce()
      expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'cancelled' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a decision that arrives before its request is registered', () => {
    const { emit } = collect()
    const session = new RunnerSession({ spec: spec(), runtime: new ScriptedRuntime(), io, emit })
    expect(() => session.handleCommand({ type: 'approval.decide', approvalId: 'unknown', decision: 'reject' })).not.toThrow()
  })
})
