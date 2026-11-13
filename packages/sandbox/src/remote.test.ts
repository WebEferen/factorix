import { AsyncQueue } from '@factorix/runtime'
import { describe, expect, it } from 'vitest'
import type { AgentHandle, LogLine, SandboxProvider } from './provider'
import { RemoteSandboxProvider, type RunnerFrame, runnerOfContainer, serveSandbox } from './remote'
import { RoutingSandboxProvider } from './routing'
import { memoryWire as wire } from './testing/wire'

const RUNNER = '11111111-2222-4333-8444-555555555555'

class FakeAgent implements AgentHandle {
  readonly queue = new AsyncQueue<string>()
  readonly sent: string[] = []
  private stderr: (line: string) => void = () => undefined
  detached = false

  constructor(readonly containerId: string) {}

  get lines() {
    return this.queue
  }

  send(line: string) {
    this.sent.push(line)
    if (line === 'boom') this.stderr('it broke')
    else this.queue.push(`echo ${line}`)
    if (line === 'bye') this.queue.close()
  }

  onStderr(listener: (line: string) => void) {
    this.stderr = listener
  }

  async wait() {
    return { exitCode: 7 }
  }

  detach() {
    this.detached = true
    this.queue.close()
  }
}

function fakeProvider(overrides: Partial<SandboxProvider> = {}) {
  const calls: [string, ...unknown[]][] = []
  const agents: FakeAgent[] = []
  const provider = {
    ensureWorkspace: async (key: string) => {
      calls.push(['ensureWorkspace', key])
      return { key, volume: `fx-ws-${key}`, mirrorVolume: `fx-mirror-${key}` }
    },
    runStep: async (workspace: unknown, request: { op: string }) => {
      calls.push(['runStep', workspace, request])
      if (request.op === 'push') throw new Error('push refused')
      return { op: request.op, exitCode: 0, stdout: 'ok', stderr: '', values: { HEAD: 'abc' }, timedOut: false, durationMs: 1 }
    },
    startAgent: async (_workspace: unknown, options: { runId: string }) => {
      const agent = new FakeAgent(`docker-${options.runId}`)
      agents.push(agent)
      agent.queue.push('early line')
      return agent
    },
    reattach: async (containerId: string) => (containerId === 'gone' ? null : new FakeAgent(containerId)),
    remove: async (containerId: string) => {
      calls.push(['remove', containerId])
    },
    listManaged: async () => ({
      containers: [
        { id: 'c1', kind: 'agent', running: true, createdAt: new Date('2026-01-02T03:04:05Z'), stack: 'runner-stack', envKey: 'envaaaaaaa' },
        { id: 'c2', kind: 'agent', running: true, createdAt: new Date(), stack: 'someone-else' },
      ],
      volumes: [{ name: 'v1', workspaceKey: 'k', stack: 'runner-stack' }],
    }),
    followLogs: async (containerId: string, options: { signal: AbortSignal }, onLine: (line: LogLine) => void) => {
      onLine({ ts: 1, stream: 'stdout', text: `first from ${containerId}` })
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve()))
      calls.push(['followLogs ended', containerId])
    },
    stopEnvironment: async (key: string) => {
      calls.push(['stopEnvironment', key])
    },
    ...overrides,
  } as unknown as SandboxProvider
  return { provider, calls, agents }
}

function connect(overrides: Partial<SandboxProvider> = {}, online: () => Promise<boolean> = async () => true) {
  const link = wire()
  const fake = fakeProvider(overrides)
  const stop = serveSandbox(fake.provider, link.runner, { stack: 'runner-stack' })
  const remote = new RemoteSandboxProvider(link.worker, { runnerId: RUNNER, name: 'big-box', online, stack: 'factorix', presenceCheckMs: 10 })
  return { ...fake, ...link, remote, stop }
}

describe('a sandbox on another machine', () => {
  it('answers plain calls and carries a failure as its message', async () => {
    const { remote, calls } = connect()
    const workspace = await remote.ensureWorkspace('issue-1')
    expect(workspace).toEqual({ key: 'issue-1', volume: 'fx-ws-issue-1', mirrorVolume: 'fx-mirror-issue-1' })
    const step = await remote.runStep(workspace, { op: 'checkout', env: { FX_REPO_NAME: 'web' } })
    expect(step.values).toEqual({ HEAD: 'abc' })
    expect(calls.at(-1)).toEqual(['runStep', workspace, { op: 'checkout', env: { FX_REPO_NAME: 'web' } }])
    await expect(remote.runStep(workspace, { op: 'push', gitToken: 't' })).rejects.toThrow('push refused')
  })

  it('streams an agent both ways and tags its container with the runner', async () => {
    const { remote, agents } = connect()
    const handle = await remote.startAgent({ key: 'k', volume: 'v', mirrorVolume: 'm' }, { runId: 'r1', issueKey: 'k', readOnlyRepo: false })
    expect(handle.containerId).toBe(`rn-${RUNNER}:docker-r1`)
    expect(runnerOfContainer(handle.containerId)).toBe(RUNNER)
    expect(runnerOfContainer('3f2a9c')).toBeNull()
    const stderr: string[] = []
    handle.onStderr((line) => stderr.push(line))
    handle.send('spec')
    handle.send('boom')
    handle.send('bye')
    const lines: string[] = []
    for await (const line of handle.lines) lines.push(line)
    expect(lines).toEqual(['early line', 'echo spec', 'echo bye'])
    expect(stderr).toEqual(['it broke'])
    expect(await handle.wait()).toEqual({ exitCode: 7 })
    handle.detach()
    await expect.poll(() => agents[0]?.detached).toBe(true)
  })

  it('reattaches by the tagged id, and reports a container that is gone', async () => {
    const { remote } = connect()
    expect((await remote.reattach(`rn-${RUNNER}:abc`))?.containerId).toBe(`rn-${RUNNER}:abc`)
    expect(await remote.reattach(`rn-${RUNNER}:gone`)).toBeNull()
  })

  it('lists only the runner stack, under the worker stack, with dates restored', async () => {
    const { remote } = connect()
    const managed = await remote.listManaged()
    expect(managed.containers).toHaveLength(1)
    expect(managed.containers[0]).toMatchObject({ id: `rn-${RUNNER}:c1`, stack: 'factorix' })
    expect(managed.containers[0]?.createdAt.getTime()).toBe(Date.parse('2026-01-02T03:04:05Z'))
    expect(managed.volumes).toEqual([{ name: 'v1', workspaceKey: 'k', stack: 'factorix' }])
  })

  it('follows logs until the caller aborts', async () => {
    const { remote, calls } = connect()
    const controller = new AbortController()
    const seen: LogLine[] = []
    const following = remote.followLogs(`rn-${RUNNER}:svc`, { signal: controller.signal }, (line) => seen.push(line))
    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]?.text).toBe('first from svc')
    controller.abort()
    await following
    expect(calls.at(-1)).toEqual(['followLogs ended', 'svc'])
  })

  it('refuses at once when the runner is offline, and fails what is pending when it goes away', async () => {
    let online = false
    const { remote, frames } = connect({ ensureWorkspace: () => new Promise(() => undefined) }, async () => online)
    await expect(remote.ensureWorkspace('k')).rejects.toThrow('Runner big-box is offline.')
    expect(frames).toHaveLength(0)

    online = true
    const stuck = remote.ensureWorkspace('k')
    const handle = await remote.startAgent({ key: 'k', volume: 'v', mirrorVolume: 'm' }, { runId: 'r2', issueKey: 'k', readOnlyRepo: false })
    online = false
    await expect(stuck).rejects.toThrow('Runner big-box went offline.')
    const lines: string[] = []
    for await (const line of handle.lines) lines.push(line)
    expect(lines).toEqual(['early line'])
  })

  it('times out a call the runner never answers, and stamps calls with a deadline', async () => {
    const link = wire()
    const remote = new RemoteSandboxProvider(link.worker, { runnerId: RUNNER, name: 'big-box', timeoutMs: 20 })
    await expect(remote.ensureWorkspace('k')).rejects.toThrow('did not answer ensureWorkspace in time')
    const call = link.frames[0] as Extract<RunnerFrame, { t: 'call' }>
    expect(call.exp).toBeGreaterThan(Date.now() - 1000)
  })

  it('says so when the runner is older than the worker', async () => {
    const { remote } = connect()
    await expect(remote.call('somethingNew', {})).rejects.toThrow('This runner does not know somethingNew. Update it.')
  })
})

describe('routing between this machine and runners', () => {
  function routed() {
    const local = fakeProvider()
    const far = connect()
    const router = new RoutingSandboxProvider(local.provider, {
      runnerOfWorkspace: async (key) => (key.startsWith('far') ? RUNNER : null),
      runnerOfEnvironment: async (key) => (key === 'farenv' ? RUNNER : key === 'nearenv' ? null : undefined),
      provider: async () => far.remote,
      onlineRunners: async () => [RUNNER],
    })
    return { router, local, far }
  }

  it('sends a workspace and its steps to the machine that holds it', async () => {
    const { router, local, far } = routed()
    const near = await router.ensureWorkspace('near-1')
    const distant = await router.ensureWorkspace('far-1')
    await router.runStep(near, { op: 'diff' })
    await router.runStep(distant, { op: 'diff' })
    expect(local.calls.map((call) => call[0])).toEqual(['ensureWorkspace', 'runStep'])
    expect(far.calls.map((call) => call[0])).toEqual(['ensureWorkspace', 'runStep'])
  })

  it('sends container calls by the tag on the id', async () => {
    const { router, local, far } = routed()
    await router.remove('plain-id')
    await router.remove(`rn-${RUNNER}:far-id`)
    expect(local.calls).toEqual([['remove', 'plain-id']])
    expect(far.calls).toEqual([['remove', 'far-id']])
  })

  it('lists every machine and remembers where an unknown environment was seen', async () => {
    const { router, local, far } = routed()
    const managed = await router.listManaged()
    expect(managed.containers.map((container) => container.id)).toEqual(['c1', 'c2', `rn-${RUNNER}:c1`])
    await router.stopEnvironment('envaaaaaaa')
    await router.stopEnvironment('farenv')
    await router.stopEnvironment('nearenv')
    expect(far.calls.filter((call) => call[0] === 'stopEnvironment')).toEqual([
      ['stopEnvironment', 'envaaaaaaa'],
      ['stopEnvironment', 'farenv'],
    ])
    expect(local.calls).toEqual([['stopEnvironment', 'nearenv']])
  })
})
