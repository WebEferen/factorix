import { randomUUID } from 'node:crypto'
import { decodeEvent, encodeLine, type RunEvent, type RunSpec } from '@factorix/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerSandboxProvider, dockerClientFromEnv } from './docker'
import type { AgentHandle, Workspace } from './provider'

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const suffix = randomUUID().slice(0, 8)
const remoteVolume = `fx-test-remote-${suffix}`
const key = `test-${suffix}`
const remoteUrl = '/remote/repo.git'

async function runAsRoot(script: string): Promise<string> {
  const container = await docker.createContainer({
    Image: image,
    User: '0',
    Cmd: ['bash', '-c', script],
    HostConfig: { Mounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] },
  })
  await container.start()
  const { StatusCode } = (await container.wait()) as { StatusCode: number }
  const logs = (await container.logs({ stdout: true, stderr: true })).toString('utf8')
  await container.remove({ force: true })
  if (StatusCode !== 0) throw new Error(`setup failed: ${logs}`)
  return logs
}

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

describe('DockerSandboxProvider', () => {
  let provider: DockerSandboxProvider
  let workspace: Workspace
  const branch = 'factorix/abc-1-add-hello'
  const baseEnv = {
    FX_REPO_NAME: 'repo',
    FX_REPO_URL: remoteUrl,
    FX_BASE_BRANCH: 'main',
    FX_BRANCH: branch,
    FX_PUBLIC_URL: 'https://gitlab.example/x.git',
    FX_RUN: 'r1',
    FX_AGENT: 'engineer-1',
  }
  const containers: string[] = []

  beforeAll(async () => {
    await docker.createVolume({ Name: remoteVolume })
    await runAsRoot(`
      set -e
      git init -q -b main --bare /remote/repo.git
      git init -q -b main /tmp/seed && cd /tmp/seed
      git config user.name seed && git config user.email seed@example.com
      echo '# Project rules' > AGENTS.md && echo base > base.txt
      git add -A && git commit -qm init
      git push -q /remote/repo.git main
      git -C /remote/repo.git symbolic-ref HEAD refs/heads/main
      chown -R 1000:1000 /remote
    `)
    provider = new DockerSandboxProvider({ image, extraStepMounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] }, docker)
    workspace = await provider.ensureWorkspace(key)
  })

  afterAll(async () => {
    for (const id of containers) await provider.remove(id)
    await provider.destroyWorkspace(key)
    await docker.getVolume(remoteVolume).remove({ force: true })
  })

  it('fetches into a mirror and reports the default branch', async () => {
    const result = await provider.runStep(workspace, { op: 'mirror-fetch', env: baseEnv, gitToken: 'not-a-real-token' })
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.values.DEFAULT_BRANCH).toBe('main')
  })

  it('checks out the working branch with no remote credentials and a tokenless origin', async () => {
    const result = await provider.runStep(workspace, {
      op: 'checkout',
      env: { ...baseEnv, FX_SETUP: 'echo FX_HEAD=forged; echo setup-ran > .setup-marker; exit 7' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.values.SETUP_FAILED).toBe('7')
    expect(result.values.HEAD).toMatch(/^[0-9a-f]{40}$/)
    expect(result.stderr).toContain('forged')
  })

  it('delivers the run spec as the first bytes on stdin, every time', async () => {
    const outcomes: unknown[] = []
    for (let index = 0; index < 20; index += 1) {
      const run = spec({ scripted: { steps: [{ say: 'hi' }] } })
      const handle = await provider.startAgent(workspace, { runId: run.runId, issueKey: key, readOnlyRepo: false, env: {} })
      containers.push(handle.containerId)
      handle.send(encodeLine(run))
      const events = await collect(handle)
      handle.detach()
      outcomes.push((events.at(-1) as { outcome?: string } | undefined)?.outcome)
    }
    expect(outcomes).toEqual(Array(20).fill('completed'))
  })

  it('reads the repo docs as JSON', async () => {
    const result = await provider.runStep(workspace, { op: 'docs', env: baseEnv })
    expect(JSON.parse(result.stdout)).toEqual({ agents: '# Project rules', claude: '' })
  })

  it('runs a scripted agent, proves it cannot see the token or the mirror, and streams events', async () => {
    const script = spec({
      scripted: {
        steps: [
          { say: 'starting' },
          {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion inside the container
            exec: 'id -u; git config user.name; test ! -e /mirror/repo.git && echo no-mirror; echo "token=[${GIT_TOKEN:-}]"; git remote get-url origin; git rev-parse --abbrev-ref HEAD',
          },
          { writeFile: { path: 'hello.txt', content: 'hello from the agent\n' } },
          { exec: 'rm .setup-marker && git add hello.txt && git commit -qm "feat: add hello" && git log -1 --format=%B' },
          { writeFile: { path: 'leftover.txt', content: 'not committed\n' } },
        ],
      },
    })
    const handle = await provider.startAgent(workspace, {
      runId: script.runId,
      issueKey: key,
      readOnlyRepo: false,
      env: { FX_AGENT: 'engineer-1', FX_RUN: script.runId },
    })
    containers.push(handle.containerId)
    handle.send(encodeLine(script))
    const events = await collect(handle)
    expect(await handle.wait()).toEqual({ exitCode: 0 })

    const outputs = events.filter((event) => event.type === 'tool.result').map((event) => (event as unknown as { output: string }).output)
    expect(outputs[0]).toContain('1000\nFactorix Bot\nno-mirror\ntoken=[]\nhttps://gitlab.example/x.git\nfactorix/abc-1-add-hello\n')
    expect(outputs[2]).toContain('Factorix-Agent: engineer-1')
    expect(outputs[2]).toContain(`Factorix-Run: ${script.runId}`)
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'completed' })
    expect(events.map((event) => event.seq).filter((seq) => seq > 0)).toEqual(events.map((_, index) => index + 1))
  })

  it('bundles leftovers as a wip commit with no network', async () => {
    const result = await provider.runStep(workspace, { op: 'bundle', env: baseEnv })
    expect(result.exitCode).toBe(0)
    expect(result.values).toMatchObject({ CHANGED: '1', COMMITS: '2' })
  })

  it('shows the diff against the base branch', async () => {
    const result = await provider.runStep(workspace, { op: 'diff', env: baseEnv })
    expect(result.stdout).toContain('hello.txt')
    expect(result.stdout).toContain('leftover.txt')
  })

  it('pushes from the mirror, even when the agent planted hostile git config', async () => {
    const malicious = spec({
      scripted: {
        steps: [
          {
            exec: `cat > /workspace/.factorix/steal <<'SH'
#!/bin/sh
echo "[$GIT_TOKEN]" >> /workspace/.factorix/leak
exit 1
SH
chmod +x /workspace/.factorix/steal
git config core.fsmonitor /workspace/.factorix/steal
git config url."file:///nowhere".insteadOf /remote/repo.git`,
          },
        ],
      },
    })
    const handle = await provider.startAgent(workspace, { runId: malicious.runId, issueKey: key, readOnlyRepo: false })
    containers.push(handle.containerId)
    handle.send(encodeLine(malicious))
    await collect(handle)

    const bundled = await provider.runStep(workspace, { op: 'bundle', env: baseEnv })
    expect(bundled.exitCode).toBe(0)
    const pushed = await provider.runStep(workspace, { op: 'push', env: baseEnv, gitToken: 'not-a-real-token' })
    expect(pushed.stderr).toBe('')
    expect(pushed.exitCode).toBe(0)
    expect(pushed.values.PUSHED).toMatch(/^[0-9a-f]{40}$/)

    const log = await runAsRoot(
      `git -c safe.directory='*' -C /remote/repo.git log --format='%s|%an|%(trailers:key=Factorix-Agent,valueonly,separator=)' ${branch}`,
    )
    expect(log).toContain('feat: add hello|Factorix Bot|engineer-1')
    expect(log).toContain('wip: unfinished changes from run r1|Factorix Bot|engineer-1')

    const check = spec({ scripted: { steps: [{ exec: 'cat /workspace/.factorix/leak' }] } })
    const inspect = await provider.startAgent(workspace, { runId: check.runId, issueKey: key, readOnlyRepo: false })
    containers.push(inspect.containerId)
    inspect.send(encodeLine(check))
    const output = (await collect(inspect)).find((event) => event.type === 'tool.result') as unknown as { output: string }
    // The planted monitor did fire, proving the attack is live, but only in the tokenless bundle step.
    expect(output.output).toContain('[]')
    expect(output.output).not.toContain('not-a-real-token')
  })

  it('refuses to push to the base branch', async () => {
    const result = await provider.runStep(workspace, { op: 'push', env: { ...baseEnv, FX_BRANCH: 'main' }, gitToken: 'x' })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('refusing')
  })

  it('reports a rejected push rather than forcing it', async () => {
    await runAsRoot(`
      set -e
      git config --global --add safe.directory '*'
      git clone -q /remote/repo.git -b ${branch} /tmp/other && cd /tmp/other
      git config user.name human && git config user.email human@example.com
      echo human > human.txt && git add -A && git commit -qm "human change"
      git push -q origin ${branch}
      chown -R 1000:1000 /remote
    `)
    const agent = spec({ scripted: { steps: [{ exec: 'echo more >> hello.txt && git add -A && git commit -qm "agent change"' }] } })
    const handle = await provider.startAgent(workspace, {
      runId: agent.runId,
      issueKey: key,
      readOnlyRepo: false,
      env: { FX_AGENT: 'engineer-1', FX_RUN: agent.runId },
    })
    containers.push(handle.containerId)
    handle.send(encodeLine(agent))
    await collect(handle)
    expect((await provider.runStep(workspace, { op: 'bundle', env: baseEnv })).values.CHANGED).toBe('1')
    const pushed = await provider.runStep(workspace, { op: 'push', env: baseEnv, gitToken: 'x' })
    expect(pushed.exitCode).toBe(4)
    expect(pushed.values.PUSH_REJECTED).toBe('1')
  })

  it('rebases onto the remote branch on the next checkout', async () => {
    expect((await provider.runStep(workspace, { op: 'mirror-fetch', env: baseEnv, gitToken: 'x' })).exitCode).toBe(0)
    const result = await provider.runStep(workspace, { op: 'checkout', env: baseEnv })
    expect(result.exitCode).toBe(0)
    expect(result.values.CONFLICT).toBeUndefined()
    const bundled = await provider.runStep(workspace, { op: 'bundle', env: baseEnv })
    expect(bundled.values.COMMITS).toBe('1')
    expect((await provider.runStep(workspace, { op: 'push', env: baseEnv, gitToken: 'x' })).exitCode).toBe(0)
  })

  it('mounts the repo read-only for review phases, leaving the rest of the workspace writable', async () => {
    const review = spec({
      phase: 'review',
      scripted: {
        steps: [
          { exec: 'touch /workspace/repos/repo/nope 2>&1 || echo repo-read-only' },
          { exec: 'touch /workspace/.factorix/ok && echo factorix-writable' },
          { exec: 'cat hello.txt' },
        ],
      },
    })
    const handle = await provider.startAgent(workspace, { runId: review.runId, issueKey: key, readOnlyRepo: true })
    containers.push(handle.containerId)
    handle.send(encodeLine(review))
    const events = await collect(handle)
    const outputs = events.filter((event) => event.type === 'tool.result').map((event) => (event as unknown as { output: string }).output)
    expect(outputs[0]).toContain('repo-read-only')
    expect(outputs[1]).toContain('factorix-writable')
    expect(outputs[2]).toContain('hello from the agent')
  })

  it('lists the models of the real SDKs with no network and no credentials', async () => {
    const catalogs = await provider.listRuntimeModels()
    expect(catalogs.claude?.defaultModel).toMatch(/^claude-/)
    expect(catalogs.claude?.models.map((model) => model.id)).toContain(catalogs.claude?.defaultModel)
    expect(catalogs.claude?.models.every((model) => model.id.startsWith('claude-'))).toBe(true)
    expect(catalogs.codex?.models.length).toBeGreaterThan(0)
    expect(catalogs.codex?.models[0]?.efforts.length).toBeGreaterThan(0)
  }, 120_000)

  it('keeps several repositories apart in one workspace', async () => {
    await runAsRoot(`
      set -e
      git init -q -b main --bare /remote/second.git
      git init -q -b main /tmp/seed && cd /tmp/seed
      git config user.name seed && git config user.email seed@example.com
      echo other > other.txt && git add -A && git commit -qm init
      git push -q /remote/second.git main
      git -C /remote/second.git symbolic-ref HEAD refs/heads/main
      chown -R 1000:1000 /remote
    `)
    const first = { ...baseEnv, FX_DIFF_PREFIX: 'repo' }
    const second = { ...baseEnv, FX_REPO_NAME: 'second', FX_REPO_URL: '/remote/second.git', FX_DIFF_PREFIX: 'second' }
    expect((await provider.runStep(workspace, { op: 'mirror-fetch', env: second, gitToken: 'x' })).exitCode).toBe(0)
    expect((await provider.runStep(workspace, { op: 'checkout', env: second })).exitCode).toBe(0)
    expect((await provider.runStep(workspace, { op: 'mirror-fetch', env: first, gitToken: 'x' })).exitCode).toBe(0)
    expect((await provider.runStep(workspace, { op: 'checkout', env: first })).exitCode).toBe(0)

    const run = spec({
      cwd: '/workspace/repos',
      scripted: {
        steps: [
          { exec: 'ls | sort | tr "\\n" " "; test ! -e /mirror/second.git && echo no-mirror' },
          { writeFile: { path: 'second/new.txt', content: 'only here\n' } },
          { exec: 'git -C second add -A && git -C second commit -qm "feat: touch one repository"' },
        ],
      },
    })
    const handle = await provider.startAgent(workspace, { runId: run.runId, issueKey: key, readOnlyRepo: false })
    containers.push(handle.containerId)
    handle.send(encodeLine(run))
    const events = await collect(handle)
    const outputs = events.filter((event) => event.type === 'tool.result').map((event) => (event as unknown as { output: string }).output)
    expect(outputs[0]).toContain('repo second')
    expect(outputs[0]).toContain('no-mirror')
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'completed' })

    const untouched = await provider.runStep(workspace, { op: 'bundle', env: first })
    expect(untouched.values.CHANGED).toBe('0')
    const changed = await provider.runStep(workspace, { op: 'bundle', env: second })
    expect(changed.values).toMatchObject({ CHANGED: '1', AHEAD: '1' })
    expect((await provider.runStep(workspace, { op: 'diff', env: second })).stdout).toContain('+++ b/second/new.txt')
    expect((await provider.runStep(workspace, { op: 'push', env: second, gitToken: 'x' })).exitCode).toBe(0)
    expect(await runAsRoot(`git -c safe.directory='*' -C /remote/second.git log --format=%s ${branch}`)).toContain('feat: touch one repository')

    const review = spec({
      phase: 'review',
      cwd: '/workspace/repos',
      scripted: { steps: [{ exec: 'touch second/nope 2>&1 || echo second-read-only' }, { exec: 'touch repo/nope 2>&1 || echo first-read-only' }] },
    })
    const reader = await provider.startAgent(workspace, { runId: review.runId, issueKey: key, readOnlyRepo: true })
    containers.push(reader.containerId)
    reader.send(encodeLine(review))
    const read = (await collect(reader))
      .filter((event) => event.type === 'tool.result')
      .map((event) => (event as unknown as { output: string }).output)
    expect(read[0]).toContain('second-read-only')
    expect(read[1]).toContain('first-read-only')
  })

  it('refuses a repository name that would leave its folder, even in a step holding the token', async () => {
    for (const name of ['../../etc', 'a/b', '.hidden', '']) {
      const result = await provider.runStep(workspace, { op: 'mirror-fetch', env: { ...baseEnv, FX_REPO_NAME: name }, gitToken: 'x' })
      expect(result.exitCode, name).not.toBe(0)
    }
  })

  it('round-trips approval and cancel commands over stdin', async () => {
    const script = spec({ scripted: { steps: [{ askApproval: { tool: 'Bash', summary: 'deploy' } }, { sleepMs: 60_000, say: 'too late' }] } })
    const handle = await provider.startAgent(workspace, { runId: script.runId, issueKey: key, readOnlyRepo: false })
    containers.push(handle.containerId)
    handle.send(encodeLine(script))
    const events = await collect(handle, (event) => {
      if (event.type === 'approval.requested') handle.send(encodeLine({ type: 'approval.decide', approvalId: event.approvalId, decision: 'approve' }))
      if (event.type === 'approval.resolved') handle.send(encodeLine({ type: 'cancel', reason: 'test', graceSeconds: 10 }))
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'cancelled' })
  })

  it('replays output when reattaching to a running or finished container', async () => {
    const script = spec({ scripted: { steps: [{ say: 'one' }, { sleepMs: 1500, say: 'two' }] } })
    const handle = await provider.startAgent(workspace, { runId: script.runId, issueKey: key, readOnlyRepo: false })
    containers.push(handle.containerId)
    handle.send(encodeLine(script))
    for await (const line of handle.lines) if (decodeEvent(line)?.type === 'message') break
    handle.detach()

    const live = await provider.reattach(handle.containerId)
    expect(live).not.toBeNull()
    const replayed = await collect(live as AgentHandle)
    expect(replayed.filter((event) => event.type === 'message').map((event) => (event as unknown as { text: string }).text)).toEqual(['one', 'two'])
    await (live as AgentHandle).wait()

    const finished = await provider.reattach(handle.containerId)
    const again = await collect(finished as AgentHandle)
    expect(again.at(-1)).toMatchObject({ type: 'done', outcome: 'completed' })
    expect(await (finished as AgentHandle).wait()).toEqual({ exitCode: 0 })
  })

  it('fails cleanly on an SDK that has no credentials', { timeout: 120_000 }, async () => {
    for (const runtime of ['claude', 'codex'] as const) {
      const run = spec({ runtime, prompt: { system: 'sys', user: 'say hi' } })
      const handle = await provider.startAgent(workspace, {
        runId: run.runId,
        issueKey: key,
        readOnlyRepo: false,
        env:
          runtime === 'claude'
            ? { ANTHROPIC_API_KEY: 'invalid', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }
            : { CODEX_API_KEY: 'invalid', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1' },
      })
      containers.push(handle.containerId)
      handle.send(encodeLine(run))
      const stderr: string[] = []
      handle.onStderr((line) => stderr.push(line))
      const events = await collect(handle)
      const done = events.at(-1)
      expect(done?.type, `${runtime} stderr: ${stderr.slice(-5).join('\n')}`).toBe('done')
      expect((done as unknown as { outcome: string }).outcome, runtime).toBe('failed')
    }
  })

  it('lists what it manages and leaves nothing behind when destroyed', async () => {
    const managed = await provider.listManaged()
    expect(managed.volumes.map((volume) => volume.name)).toEqual(expect.arrayContaining([workspace.volume, workspace.mirrorVolume]))
    expect(managed.containers.some((container) => container.id === containers[0])).toBe(true)
  })
})
