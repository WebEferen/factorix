import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentRuntime, RUNTIME_CAPABILITIES, type RunEvent, type RunSpec } from '@factorix/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { callBridge, serveBridge } from './bridge'
import { createMcpHandler } from './mcp'
import { RunnerSession } from './session'

const io = { workspaceDir: '/tmp', homeDir: '/tmp', factorixDir: '/tmp' }
const spec = {
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
} satisfies RunSpec

/** A session whose adapter never finishes, so requests can come and go. */
function idleSession(events: RunEvent[]) {
  let release = () => {}
  const runtime: AgentRuntime = {
    id: 'scripted',
    listModels: async () => ({ defaultModel: null, models: [] }),
    capabilities: () => RUNTIME_CAPABILITIES.scripted,
    prepare: async () => {},
    run: async function* () {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
  }
  const session = new RunnerSession({ spec, runtime, io, emit: (event) => void events.push(event) })
  const running = session.run()
  return {
    session,
    finish: () => {
      release()
      return running
    },
  }
}

const requests = (events: RunEvent[]) => events.filter((event): event is Extract<RunEvent, { type: 'request' }> => event.type === 'request')

describe('asking the worker', () => {
  let dir: string | null = null
  let server: Server | null = null
  afterEach(() => {
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    server = null
  })

  it('emits a request and resolves with the worker’s response', async () => {
    const events: RunEvent[] = []
    const { session, finish } = idleSession(events)
    const answer = session.request('preview.status', { wait: false })
    const [request] = requests(events)
    expect(request).toMatchObject({ op: 'preview.status', input: { wait: false } })
    session.handleCommand({ type: 'response', requestId: request?.requestId as string, ok: true, result: { state: 'ready' } })
    await expect(answer).resolves.toEqual({ state: 'ready' })
    const refused = session.request('preview.stop', {})
    session.handleCommand({ type: 'response', requestId: requests(events)[1]?.requestId as string, ok: false, error: 'No preview.' })
    await expect(refused).rejects.toThrow('No preview.')
    await finish()
  })

  it('gives up when no answer comes, and when the run is cancelled', async () => {
    const events: RunEvent[] = []
    const { session, finish } = idleSession(events)
    await expect(session.request('preview.status', {}, 20)).rejects.toThrow('did not answer in time')
    const pending = session.request('preview.status', {})
    session.handleCommand({ type: 'cancel', reason: 'test', graceSeconds: 0 })
    await expect(pending).rejects.toThrow('cancelled')
    await expect(session.request('preview.status', {})).rejects.toThrow('ending')
    await finish()
  })

  it('carries an MCP tool call over the socket to the session and back', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fx-bridge-'))
    const path = join(dir, 'bridge.sock')
    const events: RunEvent[] = []
    const { session, finish } = idleSession(events)
    server = await serveBridge(path, (op, input) => session.request(op, input))
    const handle = createMcpHandler((op, input) => callBridge(path, op, input))

    const listed = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(['preview_start', 'preview_status', 'preview_logs', 'preview_stop'])
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()

    const call = handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'preview_start', arguments: { source: 'worktree' } } })
    await expect.poll(() => requests(events).length).toBe(1)
    const [request] = requests(events)
    expect(request).toMatchObject({ op: 'preview.start', input: { source: 'worktree' } })
    session.handleCommand({ type: 'response', requestId: request?.requestId as string, ok: true, result: { state: 'starting' } })
    expect(await call).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{\n  "state": "starting"\n}' }] } })

    const refused = handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'preview_stop', arguments: {} } })
    await expect.poll(() => requests(events).length).toBe(2)
    session.handleCommand({
      type: 'response',
      requestId: requests(events)[1]?.requestId as string,
      ok: false,
      error: 'This issue has no preview yet.',
    })
    expect(await refused).toMatchObject({ result: { isError: true, content: [{ text: 'This issue has no preview yet.' }] } })
    expect(await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf' } })).toMatchObject({ error: { code: -32602 } })
    await finish()
  })

  it('refuses operations the bridge does not know', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fx-bridge-'))
    const path = join(dir, 'bridge.sock')
    server = await serveBridge(path, async () => 'never')
    await expect(callBridge(path, 'shell.exec' as never, {})).rejects.toThrow('There is no operation called shell.exec.')
  })
})
