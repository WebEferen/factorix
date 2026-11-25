import { json, type RunRow } from '@factorix/db'
import { AsyncQueue, EMPTY_USAGE, encodeLine, type RunEventBody } from '@factorix/runtime'
import type { AgentHandle, SandboxProvider, StepRequest } from '@factorix/sandbox'
import { expect, inject, it, vi } from 'vitest'
import { executeRun, LEASE_SECONDS } from './services/executor'
import { ApiClient, createHarness, type Harness } from './testing/harness'

async function createRun(harness: Harness) {
  const admin = new ApiClient(harness.app)
  await admin.ok('POST', '/api/auth/setup', {
    orgName: 'Acme',
    name: 'Ada',
    email: 'ada@example.com',
    password: 'correct horse battery',
  })
  const { agents } = await admin.ok('GET', '/api/agents')
  const { run } = await admin.ok<{ run: { id: string } }>('POST', '/api/runs', {
    agentId: agents[0].id,
    prompt: 'Wait for approval',
    gitUrl: 'https://example.com/repo',
  })
  return { admin, run }
}

/** Stores the agent's done event the way ingest does before finalizing starts, and returns the line a replay of its container would repeat. */
async function storeDone(harness: Harness, runId: string, update: Partial<RunRow>): Promise<string> {
  const { db } = harness.deps
  const done: RunEventBody = { type: 'done', outcome: 'completed', finalText: 'Answered.', sessionRef: 'saved-session', usage: EMPTY_USAGE }
  const seq = ((await db<RunRow>('runs').where({ id: runId }).first())?.lastSeq ?? 0) + 1
  await db('run_events').insert({ runId, seq, type: 'done', payload: json(done) })
  await db('runs')
    .where({ id: runId })
    .update({ ...update, lastSeq: seq, lastRunnerSeq: 1 })
  return encodeLine({ ...done, runId, seq: 1, ts: new Date().toISOString() })
}

it('finishes cancelling a run whose approval wait expires during cancellation', async () => {
  const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
  const { db, redis } = harness.deps
  const subscriber = redis.duplicate()
  const lines = new AsyncQueue<string>()
  let execution: Promise<void> | undefined
  try {
    const { admin, run } = await createRun(harness)
    const row = () => db<RunRow>('runs').where({ id: run.id }).first()
    const containerId = 'test-container'
    await db('runs').where({ id: run.id }).update({ state: 'running', containerId })

    let seq = 0
    const emit = (body: RunEventBody) => lines.push(encodeLine({ ...body, runId: run.id, seq: ++seq, ts: new Date().toISOString() }))
    const handle: AgentHandle = {
      containerId,
      lines,
      send: vi.fn(),
      onStderr: () => undefined,
      wait: async () => ({ exitCode: 0 }),
      detach: () => lines.close(),
    }
    const sandbox = {
      ensureWorkspace: async (key: string) => ({ key, volume: 'test-volume', mirrorVolume: 'test-mirror' }),
      reattach: async () => handle,
      stop: vi.fn(async () => lines.close()),
      remove: vi.fn(async () => undefined),
      runStep: async () => ({ exitCode: 0, stdout: '', stderr: '', values: {} }),
    }
    const timings = { heartbeatMs: 50, suspendAfterMs: Number.POSITIVE_INFINITY }
    execution = executeRun({ ...harness.deps, sandbox: sandbox as unknown as SandboxProvider, owner: 'test-worker', subscriber, timings }, run.id)
    emit({ type: 'approval.requested', approvalId: 'test-approval', kind: 'tool', tool: 'test', summary: 'Approve the test tool' })
    await vi.waitFor(async () => expect((await row())?.state).toBe('waiting_approval'), { timeout: 5000 })

    await admin.ok('POST', `/api/runs/${run.id}/cancel`, {})
    timings.suspendAfterMs = 0
    // Leave the runner waiting until the worker has had time to deliver cancel and check for suspension.
    const nextLease = Date.now() + LEASE_SECONDS * 1000 + 2 * timings.heartbeatMs
    await vi.waitFor(
      async () => {
        const current = await row()
        if (current?.state !== 'suspended') expect(current?.leaseExpiresAt?.getTime() ?? 0).toBeGreaterThan(nextLease)
      },
      { timeout: 5000 },
    )
    expect((await row())?.state).toBe('waiting_approval')
    expect(handle.send).toHaveBeenCalledWith(expect.stringContaining('"type":"cancel"'))
    expect(sandbox.stop).not.toHaveBeenCalled()

    emit({ type: 'done', outcome: 'cancelled', finalText: '', sessionRef: '', usage: EMPTY_USAGE })
    await execution
    expect(await row()).toMatchObject({ state: 'cancelled', outcome: 'cancelled' })
  } finally {
    lines.close()
    await execution?.catch(() => undefined)
    subscriber.disconnect()
    await harness.destroy()
  }
})

it('rejects cancellation of finished or finalizing runs and accepts repeated cancellation', async () => {
  const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
  try {
    const { admin, run } = await createRun(harness)
    const { db } = harness.deps
    const url = `/api/runs/${run.id}/cancel`
    for (const state of ['succeeded', 'failed', 'finalizing']) {
      await db('runs').where({ id: run.id }).update({ state })
      expect((await admin.request('POST', url, {})).status).toBe(409)
    }
    await db('runs').where({ id: run.id }).update({ state: 'running' })
    expect(await admin.ok('POST', url, {})).toEqual({ ok: true })
    // The cancel it accepted is what the worker is finalizing.
    await db('runs').where({ id: run.id }).update({ state: 'finalizing' })
    expect(await admin.ok('POST', url, {})).toEqual({ ok: true })
    await db('runs').where({ id: run.id }).update({ state: 'cancelled', outcome: 'cancelled' })
    expect(await admin.ok('POST', url, {})).toEqual({ ok: true })
  } finally {
    await harness.destroy()
  }
})

it.each([
  { duringReattach: false, discard: false },
  { duringReattach: true, discard: false },
  { duringReattach: true, discard: true },
])('recovers cancellation and respects partial work choices ($duringReattach, $discard)', async ({ duringReattach, discard }) => {
  const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
  const { db, redis } = harness.deps
  const subscriber = redis.duplicate()
  try {
    const { admin, run } = await createRun(harness)
    const containerId = 'removed-container'
    await db('runs').where({ id: run.id }).update({ state: 'running', phase: 'implement', containerId })
    const cancel = async () => {
      const url = `/api/runs/${run.id}/cancel`
      expect(await admin.ok('POST', url, { discard })).toEqual({ ok: true })
      expect(await admin.ok('POST', url, {})).toEqual({ ok: true })
    }
    if (!duringReattach) await cancel()
    const runStep = vi.fn(async (_workspace, { op }: StepRequest) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      values: op === 'bundle' ? { CHANGED: '1' } : {},
    }))
    const sandbox = {
      ensureWorkspace: async (key: string) => ({ key, volume: 'test-volume', mirrorVolume: 'test-mirror' }),
      reattach: vi.fn(async () => {
        if (duringReattach) await cancel()
        return null
      }),
      remove: async () => undefined,
      runStep,
    }
    await executeRun({ ...harness.deps, sandbox: sandbox as unknown as SandboxProvider, owner: 'test-worker', subscriber }, run.id)
    expect(sandbox.reattach).toHaveBeenCalledWith(containerId)
    expect(await db<RunRow>('runs').where({ id: run.id }).first()).toMatchObject({
      state: 'cancelled',
      outcome: 'cancelled',
      error: null,
      discardOnCancel: discard,
    })
    expect(await db('run_commands').where({ runId: run.id })).toHaveLength(1)
    if (discard) expect(runStep).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: 'push' }))
    else expect(runStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: 'push' }))
  } finally {
    subscriber.disconnect()
    await harness.destroy()
  }
})

it('honors an accepted cancellation when checkout subsequently fails', async () => {
  const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
  const { db, redis } = harness.deps
  const subscriber = redis.duplicate()
  try {
    const { admin, run } = await createRun(harness)
    await db('runs').where({ id: run.id }).update({ runtime: 'scripted' })
    const runStep = vi.fn(async (_workspace, { op }: StepRequest) => {
      if (op === 'checkout') {
        expect(await admin.ok('POST', `/api/runs/${run.id}/cancel`, {})).toEqual({ ok: true })
        return { exitCode: 1, stdout: '', stderr: 'Checkout failed', values: {} }
      }
      return { exitCode: 0, stdout: '', stderr: '', values: {} }
    })
    const sandbox = { ensureWorkspace: async (key: string) => ({ key, volume: 'test-volume', mirrorVolume: 'test-mirror' }), runStep }
    await executeRun({ ...harness.deps, sandbox: sandbox as unknown as SandboxProvider, owner: 'test-worker', subscriber }, run.id)
    expect(runStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: 'checkout' }))
    expect(await db<RunRow>('runs').where({ id: run.id }).first()).toMatchObject({ state: 'cancelled', outcome: 'cancelled', error: null })
  } finally {
    subscriber.disconnect()
    await harness.destroy()
  }
})

it.each(['checkout', 'docs'] as const)('never starts the agent when the run is cancelled during %s', async (during) => {
  const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
  const { db, redis } = harness.deps
  const subscriber = redis.duplicate()
  try {
    const { admin, run } = await createRun(harness)
    await db('runs').where({ id: run.id }).update({ runtime: 'scripted' })
    const runStep = vi.fn(async (_workspace, { op }: StepRequest) => {
      if (op === during) expect(await admin.ok('POST', `/api/runs/${run.id}/cancel`, {})).toEqual({ ok: true })
      return { exitCode: 0, stdout: op === 'docs' ? '{"agents":"","claude":""}' : '', stderr: '', values: {} }
    })
    const startAgent = vi.fn(async () => {
      throw new Error('The agent started after its run was cancelled')
    })
    const sandbox = { ensureWorkspace: async (key: string) => ({ key, volume: 'test-volume', mirrorVolume: 'test-mirror' }), runStep, startAgent }
    await executeRun({ ...harness.deps, sandbox: sandbox as unknown as SandboxProvider, owner: 'test-worker', subscriber }, run.id)
    expect(runStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: during }))
    expect(startAgent).not.toHaveBeenCalled()
    expect(await db<RunRow>('runs').where({ id: run.id }).first()).toMatchObject({ state: 'cancelled', outcome: 'cancelled', error: null })
  } finally {
    subscriber.disconnect()
    await harness.destroy()
  }
})

it('retries force-stop after a temporary sandbox error', async () => {
  const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
  const { db, redis } = harness.deps
  const subscriber = redis.duplicate()
  const lines = new AsyncQueue<string>()
  let execution: Promise<void> | undefined
  try {
    const { admin, run } = await createRun(harness)
    const containerId = 'unresponsive-container'
    await db('runs').where({ id: run.id }).update({ state: 'running', containerId })
    await admin.ok('POST', `/api/runs/${run.id}/cancel`, {})
    const handle: AgentHandle = {
      containerId,
      lines,
      send: vi.fn(),
      onStderr: () => undefined,
      wait: async () => ({ exitCode: 137 }),
      detach: () => lines.close(),
    }
    const sandbox = {
      ensureWorkspace: async (key: string) => ({ key, volume: 'test-volume', mirrorVolume: 'test-mirror' }),
      reattach: async () => handle,
      stop: vi.fn(async () => lines.close()).mockRejectedValueOnce(new Error('Runner temporarily unreachable')),
      remove: async () => undefined,
      runStep: async () => ({ exitCode: 0, stdout: '', stderr: '', values: {} }),
    }
    const timings = { heartbeatMs: 50, forceStopAfterCancelMs: 25 }
    execution = executeRun({ ...harness.deps, sandbox: sandbox as unknown as SandboxProvider, owner: 'test-worker', subscriber, timings }, run.id)
    await vi.waitFor(() => expect(sandbox.stop).toHaveBeenNthCalledWith(2, containerId, 5), { timeout: 5000 })
    await execution
    expect(await db<RunRow>('runs').where({ id: run.id }).first()).toMatchObject({ state: 'cancelled', outcome: 'cancelled', error: null })
  } finally {
    lines.close()
    await execution?.catch(() => undefined)
    subscriber.disconnect()
    await harness.destroy()
  }
})

it.each(['gone', 'exited'] as const)(
  'finishes from the saved answer when its worker stopped before finalizing and the container is %s',
  async (container) => {
    const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    const { db, redis } = harness.deps
    const subscriber = redis.duplicate()
    try {
      const { run } = await createRun(harness)
      const replay = await storeDone(harness, run.id, { state: 'running', containerId: 'agent-container', sessionRef: 'first-session' })
      const handle: AgentHandle = {
        containerId: 'agent-container',
        lines: (async function* () {
          yield replay
        })(),
        send: () => undefined,
        onStderr: () => undefined,
        wait: async () => ({ exitCode: 0 }),
        detach: () => undefined,
      }
      const sandbox = {
        ensureWorkspace: async (key: string) => ({ key, volume: 'test-volume', mirrorVolume: 'test-mirror' }),
        reattach: async () => (container === 'gone' ? null : handle),
        stop: async () => undefined,
        remove: async () => undefined,
        runStep: async () => ({ exitCode: 0, stdout: '', stderr: '', values: {} }),
      }
      await executeRun({ ...harness.deps, sandbox: sandbox as unknown as SandboxProvider, owner: 'test-worker', subscriber }, run.id)
      expect(await db<RunRow>('runs').where({ id: run.id }).first()).toMatchObject({
        state: 'succeeded',
        outcome: 'completed',
        summary: 'Answered.',
        sessionRef: 'saved-session',
        error: null,
      })
    } finally {
      subscriber.disconnect()
      await harness.destroy()
    }
  },
)

it.each([
  { when: 'before', other: { state: 'succeeded', leaseOwner: null, leaseExpiresAt: null } },
  { when: 'while', other: { state: 'finalizing', leaseOwner: 'replacement-worker', leaseExpiresAt: new Date(Date.now() + 60_000) } },
] as const)('leaves the run to the worker that took it over $when this one was finalizing', async ({ when, other }) => {
  const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
  const { db, redis } = harness.deps
  const subscriber = redis.duplicate()
  let execution: Promise<void> | undefined
  let resume = () => {}
  const resumed = new Promise<void>((resolve) => {
    resume = resolve
  })
  try {
    const { run } = await createRun(harness)
    await storeDone(harness, run.id, { state: 'finalizing' })
    const paused = vi.fn(() => resumed)
    const sandbox = {
      ensureWorkspace: async (key: string) => {
        if (when === 'before') await paused()
        return { key, volume: 'test-volume', mirrorVolume: 'test-mirror' }
      },
      runStep: async (_workspace: unknown, { op }: StepRequest) => {
        if (when === 'while' && op === 'bundle') await paused()
        return { exitCode: 0, stdout: '', stderr: '', values: {} }
      },
      stop: async () => undefined,
      remove: async () => undefined,
    }
    execution = executeRun({ ...harness.deps, sandbox: sandbox as unknown as SandboxProvider, owner: 'paused-worker', subscriber }, run.id)
    await vi.waitFor(() => expect(paused).toHaveBeenCalled(), { timeout: 5000 })
    await db('runs').where({ id: run.id }).update(other)
    resume()
    await execution
    expect(await db<RunRow>('runs').where({ id: run.id }).first()).toMatchObject({ state: other.state, leaseOwner: other.leaseOwner })
    expect(await db('audit_log').where({ targetId: run.id, action: 'run.finished' })).toHaveLength(0)
  } finally {
    resume()
    await execution?.catch(() => undefined)
    subscriber.disconnect()
    await harness.destroy()
  }
})
