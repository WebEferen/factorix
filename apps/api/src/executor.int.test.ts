import type { RunRow } from '@factorix/db'
import { AsyncQueue, EMPTY_USAGE, encodeLine, type RunEventBody } from '@factorix/runtime'
import type { AgentHandle, SandboxProvider } from '@factorix/sandbox'
import { expect, inject, it, vi } from 'vitest'
import { executeRun, LEASE_SECONDS } from './services/executor'
import { ApiClient, createHarness } from './testing/harness'

it('finishes cancelling a run whose approval wait expires during cancellation', async () => {
  const harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
  const { db, redis } = harness.deps
  const subscriber = redis.duplicate()
  const lines = new AsyncQueue<string>()
  let execution: Promise<void> | undefined
  try {
    const admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', {
      orgName: 'Acme',
      name: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery',
    })
    const { agents } = await admin.ok('GET', '/api/agents')
    const { run } = await admin.ok('POST', '/api/runs', { agentId: agents[0].id, prompt: 'Wait for approval', gitUrl: 'https://example.com/repo' })
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
