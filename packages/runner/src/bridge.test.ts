import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentHelper, type AgentRuntime, type BridgeOp, RUNTIME_CAPABILITIES, type RunEvent, type RunSpec } from '@factorix/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { callBridge, serveBridge } from './bridge'
import { createHelperDesk } from './helpers'
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
    server = await serveBridge(path, (op, input) => session.request(op as BridgeOp, input))
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

describe('helpers behind the delegate tool', () => {
  let dir = ''
  let server: Server | null = null
  afterEach(() => {
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const helpers: AgentHelper[] = [
    { name: 'code-search', description: 'Finds code', prompt: 'Search.', model: 'small', access: 'read' },
    { name: 'test-runner', description: 'Runs tests', prompt: 'Run.', model: null, access: 'all' },
  ]
  const withHelpers = { helpers } as unknown as RunSpec
  const runtimeOf = (mode: 'native' | 'delegate', runHelper?: AgentRuntime['runHelper']) =>
    ({ capabilities: () => ({ ...RUNTIME_CAPABILITIES.codex, helpers: mode }), runHelper }) as unknown as AgentRuntime

  async function toolsOf(runtime: AgentRuntime, signal = new AbortController().signal, groups = ['preview', 'helpers']) {
    dir = mkdtempSync(join(tmpdir(), 'fx-helpers-'))
    const path = join(dir, 'bridge.sock')
    const desk = createHelperDesk(withHelpers, runtime, io, signal)
    server = await serveBridge(path, (op, input) => desk(op as never, input))
    return createMcpHandler((op, input) => callBridge(path, op, input), groups)
  }
  const names = async (handle: Awaited<ReturnType<typeof toolsOf>>) =>
    ((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    )
  const delegate = (handle: Awaited<ReturnType<typeof toolsOf>>, args: unknown) =>
    handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate', arguments: args } }) as Promise<{
      result: { content: { text: string }[]; isError?: boolean }
    }>

  it('offers the tool with the run’s helpers, runs the one asked for, and returns its answer', async () => {
    const asked: unknown[] = []
    const handle = await toolsOf(
      runtimeOf('delegate', async (_spec, helper, task) => {
        asked.push([helper.name, helper.model, task])
        return 'Defined in src/a.ts:12'
      }),
      undefined,
      ['helpers'],
    )
    const listed = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
      result: { tools: { name: string; description: string; inputSchema: { properties: { helper: { enum: string[] } } } }[] }
    }
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(['delegate'])
    expect(listed.result.tools[0]?.description).toContain('- code-search: Finds code')
    expect(listed.result.tools[0]?.inputSchema.properties.helper.enum).toEqual(['code-search', 'test-runner'])

    const answer = await delegate(handle, { helper: 'code-search', task: 'Where is parse defined?' })
    expect(answer.result).toEqual({ content: [{ type: 'text', text: 'Defined in src/a.ts:12' }] })
    expect(asked).toEqual([['code-search', 'small', 'Where is parse defined?']])
  })

  it('says which helpers exist when asked for one that does not, and wants a task', async () => {
    const handle = await toolsOf(runtimeOf('delegate', async () => 'x'))
    const unknown = await delegate(handle, { helper: 'nobody', task: 'x' })
    expect(unknown.result.isError).toBe(true)
    expect(unknown.result.content[0]?.text).toContain('Choose one of: code-search, test-runner')
    expect((await delegate(handle, { helper: 'code-search', task: ' ' })).result.content[0]?.text).toContain('task')
  })

  it('is not offered where the SDK runs helpers itself, or where the server was not asked for it', async () => {
    expect(await names(await toolsOf(runtimeOf('native', async () => 'x')))).not.toContain('delegate')
    server?.close()
    expect(
      await names(
        await toolsOf(
          runtimeOf('delegate', async () => 'x'),
          undefined,
          ['preview'],
        ),
      ),
    ).not.toContain('delegate')
  })

  it('refuses once the run is ending', async () => {
    const abort = new AbortController()
    const handle = await toolsOf(
      runtimeOf('delegate', async () => 'x'),
      abort.signal,
    )
    abort.abort()
    expect((await delegate(handle, { helper: 'code-search', task: 'x' })).result.content[0]?.text).toContain('ending')
  })
})

describe('plugin tools', () => {
  const listed = [
    { name: 'docs_search', description: 'Searches the docs.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'preview_start', description: 'A plugin cannot take a name of ours.', inputSchema: { type: 'object' } },
  ]
  const calls: [string, unknown][] = []
  const handleFor = (groups: string[]) =>
    createMcpHandler(async (op, input) => {
      calls.push([op, input])
      if (op === 'tool.list') return listed
      if (op === 'tool.call' && (input as { name: string }).name === 'docs_search') return 'Found 2 pages'
      throw new Error('There is no tool called that')
    }, groups)
  const list = async (groups: string[]) =>
    ((await handleFor(groups)({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } }).result.tools
  const callTool = (groups: string[], name: string) =>
    handleFor(groups)({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: { query: 'retries' } } }) as Promise<{
      result?: { content: { text: string }[]; isError?: boolean }
      error?: { message: string }
    }>

  it('lists what the worker lists, after the built-in tools, and never under a built-in name', async () => {
    expect((await list(['preview', 'plugins'])).map((tool) => tool.name)).toEqual([
      'preview_start',
      'preview_status',
      'preview_logs',
      'preview_stop',
      'docs_search',
    ])
    expect(await list(['plugins'])).toEqual([listed[0]])
  })

  it('carries a call to the worker with its name and arguments, and returns the answer as text', async () => {
    calls.length = 0
    expect((await callTool(['plugins'], 'docs_search')).result).toEqual({ content: [{ type: 'text', text: 'Found 2 pages' }] })
    expect(calls).toEqual([['tool.call', { name: 'docs_search', input: { query: 'retries' } }]])
    const failed = await callTool(['plugins'], 'docs_gone')
    expect(failed.result).toMatchObject({ isError: true, content: [{ text: 'There is no tool called that' }] })
  })

  it('offers nothing and calls nothing where the server was not asked for plugin tools', async () => {
    calls.length = 0
    expect(await list(['preview'])).toHaveLength(4)
    expect((await callTool(['preview'], 'docs_search')).error?.message).toBe('There is no tool called docs_search.')
    expect(calls).toEqual([])
  })
})
