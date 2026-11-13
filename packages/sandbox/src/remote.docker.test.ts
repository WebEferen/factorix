import { randomUUID } from 'node:crypto'
import { decodeEvent, encodeLine, type RunEvent, type RunSpec } from '@factorix/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerSandboxProvider, dockerClientFromEnv } from './docker'
import type { AgentHandle, LogLine, Workspace } from './provider'
import { RemoteSandboxProvider, runnerOfContainer, serveSandbox } from './remote'
import { memoryWire } from './testing/wire'

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const suffix = randomUUID().slice(0, 8)
const originVolume = `fx-test-origin-${suffix}`
const key = `test-remote-${suffix}`
const RUNNER = '11111111-2222-4333-8444-555555555555'

function spec(overrides: Partial<RunSpec>): RunSpec {
  return {
    runId: `run-${randomUUID().slice(0, 8)}`,
    attempt: 1,
    phase: 'implement',
    cwd: '/workspace/repos/repo',
    runtime: 'scripted',
    model: {},
    prompt: { system: '', user: '' },
    mcpServers: {},
    policy: { mode: 'full', allow: [], deny: [], requireApproval: [], networkAccess: false },
    startSeq: 0,
    ...overrides,
  }
}

async function collect(handle: AgentHandle, onEvent?: (event: RunEvent) => void): Promise<RunEvent[]> {
  const events: RunEvent[] = []
  for await (const line of handle.lines) {
    const event = decodeEvent(line)
    if (!event) continue
    events.push(event)
    onEvent?.(event)
    if (event.type === 'done') break
  }
  return events
}

/** The same Docker work as the local provider's tests, with every call crossing the wire a runner would be on. */
describe('a real Docker sandbox behind the runner protocol', () => {
  let real: DockerSandboxProvider
  let remote: RemoteSandboxProvider
  let workspace: Workspace
  const env = {
    FX_REPO_NAME: 'repo',
    FX_REPO_URL: '/remote/repo.git',
    FX_BASE_BRANCH: 'main',
    FX_BRANCH: 'factorix/abc-1-remote',
    FX_PUBLIC_URL: 'https://gitlab.example/x.git',
    FX_RUN: 'r1',
    FX_AGENT: 'engineer-1',
  }
  const containers: string[] = []

  beforeAll(async () => {
    await docker.createVolume({ Name: originVolume })
    const seed = await docker.createContainer({
      Image: image,
      User: '0',
      Cmd: [
        'bash',
        '-c',
        `set -e
        git init -q -b main --bare /remote/repo.git
        git init -q -b main /tmp/seed && cd /tmp/seed
        git config user.name seed && git config user.email seed@example.com
        echo base > base.txt && git add -A && git commit -qm init
        git push -q /remote/repo.git main
        git -C /remote/repo.git symbolic-ref HEAD refs/heads/main
        chown -R 1000:1000 /remote`,
      ],
      HostConfig: { Mounts: [{ Type: 'volume', Source: originVolume, Target: '/remote' }] },
    })
    await seed.start()
    const { StatusCode } = (await seed.wait()) as { StatusCode: number }
    await seed.remove({ force: true })
    if (StatusCode !== 0) throw new Error('could not seed the test repository')

    real = new DockerSandboxProvider({ image, extraStepMounts: [{ Type: 'volume', Source: originVolume, Target: '/remote' }] }, docker)
    const wire = memoryWire()
    serveSandbox(real, wire.runner)
    remote = new RemoteSandboxProvider(wire.worker, { runnerId: RUNNER, name: 'test' })
    workspace = await remote.ensureWorkspace(key)
  })

  afterAll(async () => {
    for (const id of containers) await remote.remove(id).catch(() => undefined)
    await remote.destroyWorkspace(key)
    await docker.getVolume(originVolume).remove({ force: true })
  })

  it('runs the git steps and returns their values', async () => {
    const fetched = await remote.runStep(workspace, { op: 'mirror-fetch', env, gitToken: 'not-a-real-token' })
    expect(fetched.stderr).toBe('')
    expect(fetched.values.DEFAULT_BRANCH).toBe('main')
    const checkout = await remote.runStep(workspace, { op: 'checkout', env })
    expect(checkout.exitCode).toBe(0)
    expect(checkout.values.HEAD).toMatch(/^[0-9a-f]{40}$/)
  })

  it('runs an agent, with its events coming back and commands going in', async () => {
    const script = spec({
      scripted: { steps: [{ say: 'starting' }, { exec: 'id -u; pwd' }, { askApproval: { tool: 'Bash', summary: 'deploy' } }, { say: 'approved' }] },
    })
    const handle = await remote.startAgent(workspace, { runId: script.runId, issueKey: key, readOnlyRepo: false, env: {} })
    containers.push(handle.containerId)
    expect(runnerOfContainer(handle.containerId)).toBe(RUNNER)
    handle.send(encodeLine(script))
    const events = await collect(handle, (event) => {
      if (event.type === 'approval.requested') handle.send(encodeLine({ type: 'approval.decide', approvalId: event.approvalId, decision: 'approve' }))
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'completed' })
    const output = events.find((event) => event.type === 'tool.result') as unknown as { output: string }
    expect(output.output).toContain('1000\n/workspace/repos/repo')
    const said = events.filter((event) => event.type === 'message').map((event) => (event as unknown as { text: string }).text)
    expect(said).toEqual(['starting', 'Approval was approved', 'approved'])
    expect(await handle.wait()).toEqual({ exitCode: 0 })
    handle.detach()
  })

  it('reattaches to a container and replays what it printed', async () => {
    const script = spec({ scripted: { steps: [{ say: 'one' }, { sleepMs: 1500, say: 'two' }] } })
    const handle = await remote.startAgent(workspace, { runId: script.runId, issueKey: key, readOnlyRepo: false })
    containers.push(handle.containerId)
    handle.send(encodeLine(script))
    for await (const line of handle.lines) if (decodeEvent(line)?.type === 'message') break
    handle.detach()

    const live = (await remote.reattach(handle.containerId)) as AgentHandle
    const replayed = await collect(live)
    expect(replayed.filter((event) => event.type === 'message').map((event) => (event as unknown as { text: string }).text)).toEqual(['one', 'two'])
    expect(await live.wait()).toEqual({ exitCode: 0 })
    expect(await remote.isRunning(handle.containerId)).toBe(false)
    expect(await remote.reattach(`rn-${RUNNER}:${'0'.repeat(64)}`)).toBeNull()
  })

  it('follows a container’s logs and lists what the machine holds under tagged ids', async () => {
    const lines: LogLine[] = []
    await remote.followLogs(containers[0] as string, { signal: new AbortController().signal }, (line) => lines.push(line))
    expect(lines.some((line) => line.text.includes('"type":"done"'))).toBe(true)

    const managed = await remote.listManaged()
    expect(managed.containers.map((container) => container.id)).toEqual(expect.arrayContaining(containers))
    expect(managed.containers[0]?.createdAt).toBeInstanceOf(Date)
    expect(managed.volumes.map((volume) => volume.name)).toEqual(expect.arrayContaining([workspace.volume, workspace.mirrorVolume]))
  })
})
