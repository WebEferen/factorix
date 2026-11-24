import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { EventBuffer } from './services/event-buffer'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }

describe('EventBuffer', () => {
  let harness: Harness
  let runId: string

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    const admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', SETUP)
    const archetypeId = (await admin.ok('GET', '/api/archetypes')).archetypes.find((item: { name: string }) => item.name === 'Engineer').id
    const { agent } = await admin.ok('POST', '/api/agents', {
      handle: 'coder',
      displayName: 'Coder',
      archetypeId,
      systemPrompt: 'Code',
      policy: { mode: 'edit', allow: [], deny: [], requireApproval: [], networkAccess: true },
      runtime: 'codex',
    })
    const { orgId } = await harness.deps.db('accounts').where({ id: agent.id }).first()
    const [run] = await harness.deps
      .db('runs')
      .insert({ orgId, agentId: agent.id, agentSnapshot: JSON.stringify({}), phase: 'prompt', runtime: 'codex', state: 'running' })
      .returning('id')
    runId = run.id
  })
  afterAll(() => harness.destroy())

  const stored = () => harness.deps.db('run_events').where({ runId }).orderBy('seq')

  it('stores output with NUL characters, which Postgres refuses in JSON, without them', async () => {
    const buffer = new EventBuffer(harness.deps.db, harness.deps.redis, runId, 0, 0)
    // What `vite build` printed in a real run: a virtual module id starts with a NUL.
    buffer.append({ type: 'tool.result', toolUseId: 't1', output: 'vite:reporter (!) \u0000vite/preload-helper.js', isError: false } as never)
    await buffer.flush()
    const [row] = await stored()
    expect(row.payload.output).toBe('vite:reporter (!) vite/preload-helper.js')
  })

  it('stores output cut in the middle of an emoji, which Postgres refuses in JSON, with a replacement character', async () => {
    const buffer = new EventBuffer(harness.deps.db, harness.deps.redis, runId, 5, 0)
    buffer.append({ type: 'tool.result', toolUseId: 't2', output: `built ${'🚀'.slice(0, 1)}`, isError: false } as never)
    await buffer.flush()
    const row = await harness.deps.db('run_events').where({ runId, seq: 6 }).first()
    expect(row.payload.output).toBe('built \uFFFD')
  })

  it('keeps writing after a write fails, and loses nothing it was given', async () => {
    const buffer = new EventBuffer(harness.deps.db, harness.deps.redis, runId, 10, 0)
    await harness.deps.db.raw('ALTER TABLE run_events ADD CONSTRAINT fail_once CHECK (seq <> 11)')
    buffer.append({ type: 'log', level: 'info', source: 'worker', message: 'first' })
    await expect(buffer.flush()).rejects.toThrow()
    await harness.deps.db.raw('ALTER TABLE run_events DROP CONSTRAINT fail_once')
    buffer.append({ type: 'log', level: 'info', source: 'worker', message: 'second' })
    await buffer.flush()
    const messages = (await stored())
      .filter((row: { seq: number }) => row.seq > 10)
      .map((row: { payload: { message: string } }) => row.payload.message)
    expect(messages).toEqual(['first', 'second'])
  })

  it('never lets a write that fails in the background take the process down', async () => {
    const buffer = new EventBuffer(harness.deps.db, harness.deps.redis, runId, 20, 0)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    process.on('unhandledRejection', onUnhandled)
    try {
      await harness.deps.db.raw('ALTER TABLE run_events ADD CONSTRAINT fail_bg CHECK (seq <> 21)')
      buffer.append({ type: 'log', level: 'info', source: 'worker', message: 'background' })
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringContaining(`writing events of run ${runId} failed`)), {
        timeout: 10_000,
      })
      // An unhandled rejection is reported once the microtasks after it have run.
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      logged.mockRestore()
      await harness.deps.db.raw('ALTER TABLE run_events DROP CONSTRAINT IF EXISTS fail_bg')
    }
    await buffer.flush()
    expect((await stored()).some((row: { payload: { message?: string } }) => row.payload.message === 'background')).toBe(true)
  })
})
