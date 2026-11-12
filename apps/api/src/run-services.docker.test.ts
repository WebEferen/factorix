// biome-ignore-all lint/suspicious/noTemplateCurlyInString: definitions use ${...} templates
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TrackerResource } from '@factorix/connectors'
import type { EnvironmentInstanceRow } from '@factorix/db'
import type { ScriptedPlan } from '@factorix/runtime'
import { DockerSandboxProvider, dockerClientFromEnv } from '@factorix/sandbox'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { AppDeps } from './deps'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness, issuePayload, removeOwnSandboxes, sendLinearWebhook, waitFor } from './testing/harness'
import { startWorkers, type WorkerHandle } from './worker'

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const suffix = randomUUID().slice(0, 8)
const stack = `test-${suffix}`
const agentsNetwork = `fx-test-rs-agents-${suffix}`
const egressNetwork = `fx-test-rs-egress-${suffix}`
const remoteVolume = `fx-test-rs-remote-${suffix}`

const DEFINITION = `services:
  cache:
    image: redis:7
    data: /data
    secrets: [hidden]
    files:
      - { repo: r, path: init, to: /seed }
    ready:
      command: test -f /seed/greeting && redis-cli ping
  web:
    repo: r
    start: python3 -m http.server 3000 --bind 0.0.0.0
    port: 3000
    ready:
      http: /
expose:
  service: web
agents:
  services: [cache]
  env:
    CACHE_URL: redis://\${services.cache.host}:6379
`

/** Drives the MCP server the way an agent's runtime would, then reaches the preview directly. */
const MCP_CHECK = `import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
const server = spawn('node', ['/opt/factorix/runner/index.mjs', '--mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })
const waiting = new Map()
createInterface({ input: server.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  waiting.get(message.id)?.(message)
})
let id = 0
const rpc = (method, params) => new Promise((resolve) => {
  id += 1
  waiting.set(id, resolve)
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n')
})
const call = async (name, args = {}) => {
  const { result } = await rpc('tools/call', { name, arguments: args })
  if (result.isError) throw new Error(result.content[0].text)
  try { return JSON.parse(result.content[0].text) } catch { return result.content[0].text }
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })
let status = await call('preview_start', { source: 'worktree' })
for (let tries = 0; tries < 6 && ['starting', 'refreshing'].includes(status.state); tries += 1) status = await call('preview_status', { wait: true })
const page = status.reach
  ? await fetch(status.reach.web + '/page.txt').then((response) => response.text(), (error) => 'fetch failed: ' + (error.cause?.code ?? error.message))
  : null
console.log(JSON.stringify({ status, page, logs: await call('preview_logs', { service: 'web', lines: 200 }), stopped: await call('preview_stop') }))
server.stdin.end()
`

describe('agent runs with the project environment', () => {
  let harness: Harness
  let worker: WorkerHandle
  let script: ScriptedPlan | undefined
  let linear: { id: string; webhookSecret: string }
  let labelId: string
  const containers: string[] = []
  const events = async (runId: string) => (await harness.deps.db('run_events').where({ runId }).orderBy('seq')).map((row) => row.payload)

  beforeAll(async () => {
    await docker.createNetwork({ Name: agentsNetwork, Internal: true })
    await docker.createNetwork({ Name: egressNetwork })
    await docker.createVolume({ Name: remoteVolume })
    const seed = await docker.createContainer({
      Image: image,
      User: '0',
      Env: ['HOME=/tmp'],
      Cmd: [
        'bash',
        '-c',
        'set -e; git init -q -b main --bare /remote/repo.git; git init -q -b main /tmp/seed; cd /tmp/seed; git config user.name seed; git config user.email seed@example.com; echo base > base.txt; mkdir init; echo hello > init/greeting; git add -A; git commit -qm init; git push -q /remote/repo.git main; git -C /remote/repo.git symbolic-ref HEAD refs/heads/main; chown -R 1000:1000 /remote',
      ],
      HostConfig: { Mounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] },
    })
    await seed.start()
    await seed.wait()
    await seed.remove({ force: true })

    const bundleDir = mkdtempSync(join(tmpdir(), 'fx-proxy-'))
    await build({
      entryPoints: [resolve(import.meta.dirname, '../../egress-proxy/src/index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: join(bundleDir, 'proxy.cjs'),
      logLevel: 'silent',
    })
    const tarPath = join(bundleDir, 'proxy.tar')
    execFileSync('tar', ['--no-xattrs', '-C', bundleDir, '-cf', tarPath, 'proxy.cjs'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const proxy = await docker.createContainer({
      Image: image,
      Cmd: ['node', '/tmp/proxy.cjs'],
      Env: [`REDIS_URL=redis://host.docker.internal:${new URL(inject('redisUrl')).port}`, 'PORT=8080'],
      Labels: { 'factorix.role': 'egress', 'factorix.stack': stack },
      HostConfig: { NetworkMode: egressNetwork, ExtraHosts: ['host.docker.internal:host-gateway'] },
    })
    await proxy.putArchive(tarPath, { path: '/tmp' })
    await docker.getNetwork(agentsNetwork).connect({ Container: proxy.id, EndpointConfig: { Aliases: ['egress-proxy'] } })
    await proxy.start()
    containers.push(proxy.id)
    rmSync(bundleDir, { recursive: true, force: true })

    harness = await createHarness(
      { databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') },
      {
        sandbox: new DockerSandboxProvider(
          {
            image,
            stepNetwork: egressNetwork,
            agentNetwork: agentsNetwork,
            stack,
            extraStepMounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }],
          },
          docker,
        ),
        scriptFor: (phase) => (phase === 'implement' ? script : undefined),
        timings: { heartbeatMs: 500, leaseSeconds: 3, recoveryMs: 500, noteDebounceMs: 300 },
      },
    )
    ;(harness.deps.env as { FACTORIX_PROXY_URL?: string; FACTORIX_STACK?: string }).FACTORIX_PROXY_URL = 'http://egress-proxy:8080'
    harness.deps.env.FACTORIX_STACK = stack
    worker = startWorkers(harness.deps as AppDeps & { sandbox: NonNullable<AppDeps['sandbox']> }, { prefix: harness.prefix, log: () => undefined })

    const admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    const { agents } = await admin.ok('GET', '/api/agents')
    for (const agent of agents)
      await admin.ok('PUT', `/api/agents/${agent.id}`, {
        handle: agent.handle,
        displayName: agent.displayName,
        archetypeId: agent.archetype.id,
        runtime: 'scripted',
        policy: { mode: agent.policy.mode },
      })
    linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'x' })).connection
    const gitlab = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'y', config: {} })).connection
    const doppler = (await admin.ok('POST', '/api/connections', { kind: 'doppler', name: 'Doppler', secret: 'dp.sa.the-token' })).connection
    harness.world.dopplerConfigs = new Map<string, Record<string, string>>([
      ['app/dev', { APP_SECRET: 'app-secret-value' }],
      ['hidden/dev', { HIDDEN_SECRET: 'not-for-agents' }],
    ])
    const { project } = await admin.ok('POST', '/api/projects', {
      name: 'Web',
      trackerConnectionId: linear.id,
      trackerTeamId: TEAM_ID,
      scmConnectionId: gitlab.id,
      repos: [{ scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'file:///remote/repo.git', defaultBranch: 'main' }],
      networkPolicy: 'restricted',
      stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
    })
    await admin.ok('PUT', `/api/projects/${project.id}/environment`, {
      source: DEFINITION,
      secretSets: [
        { name: 'app', connectionId: doppler.id, project: 'app', config: 'dev' },
        { name: 'hidden', connectionId: doppler.id, project: 'hidden', config: 'dev' },
      ],
    })
    const imported = await waitFor(async () => {
      const current = (await admin.ok('GET', `/api/projects/${project.id}`)).project
      return current.syncState === 'idle' && current
    }, 'the project import')
    labelId = imported.agentLabels['engineer-1']
  })

  /** Files an issue for engineer-1 and waits for its implement run to end. */
  async function implement(title: string, resources: TrackerResource[] = []) {
    const tracker = harness.world.addIssue({ title, labels: [{ id: labelId, name: 'engineer-1', parentId: null, isGroup: false }] })
    harness.world.resources.set(tracker.id, resources)
    await sendLinearWebhook(harness.app, linear.id, linear.webhookSecret, issuePayload(tracker, 'create'))
    const issue = await waitFor(() => harness.deps.db('issues').where({ trackerIssueId: tracker.id }).first(), 'the mirror row')
    const run = await waitFor(
      async () => {
        const row = await harness.deps.db('runs').where({ issueId: issue.id, phase: 'implement' }).first()
        return row && ['succeeded', 'failed'].includes(row.state) ? row : null
      },
      'the implement run to finish',
      180_000,
    )
    const payloads = await events(run.id)
    expect(run.state, JSON.stringify(payloads.filter((event) => event.type === 'log' || event.type === 'error'))).toBe('succeeded')
    return { issue, run, payloads, outputs: payloads.filter((event) => event.type === 'tool.result').map((event) => String(event.output)) }
  }

  afterAll(async () => {
    await worker?.close()
    for (const row of (await harness?.deps.db<EnvironmentInstanceRow>('environment_instances')) ?? []) {
      await harness.deps.sandbox?.stopEnvironment(row.slug).catch(() => undefined)
      await harness.deps.sandbox?.removeEnvironmentVolumes(row.slug, { source: true }).catch(() => undefined)
    }
    if (harness) await removeOwnSandboxes(harness, docker)
    await harness?.destroy()
    for (const id of containers)
      await docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => undefined)
    for (const name of [agentsNetwork, egressNetwork])
      await docker
        .getNetwork(name)
        .remove()
        .catch(() => undefined)
    await docker
      .getVolume(remoteVolume)
      .remove({ force: true })
      .catch(() => undefined)
  })

  it('gives the agent its own services and no secret values, then removes the services with the run', async () => {
    script = {
      steps: [
        {
          exec: `node -e "const u = new URL(process.env.CACHE_URL); const s = require('net').connect(Number(u.port), u.hostname, () => s.write('PING\\r\\n')); s.on('data', (d) => { process.stdout.write(d.toString().trim()); s.end() })"; echo " exit=$?"`,
        },
        { exec: 'echo "${APP_SECRET:-none}/${HIDDEN_SECRET:-none}"' },
        { exec: `doppler run -p app -c dev -- sh -c 'echo "doppler sees \${APP_SECRET:-nothing}"'; echo " exit=$?"` },
        { exec: 'env | grep -c dp.sa; echo " exit=$?"' },
        { writeFile: { path: 'services.txt', content: 'done\n' } },
        { exec: 'git add services.txt && git commit -qm "chore: services check"' },
      ],
      structuredOutput: { summary: 'Checked the services.', approach: 'node', testing: 'node', notes: '' },
    }
    const { issue, run, payloads, outputs } = await implement('Use the cache')
    const [ping, secrets, viaDoppler, tokenCount] = outputs
    expect(ping).toContain('+PONG exit=0')
    expect(secrets?.trim()).toBe('none/none')
    expect(viaDoppler).toContain('doppler sees nothing')
    expect(tokenCount?.trim().startsWith('0')).toBe(true)
    const logs = payloads.filter((event) => event.type === 'log').map((event) => String(event.message))
    expect(logs).toContain('Starting cache for this run.')
    expect(logs).toContain('cache starts without the secret sets hidden, since agent runs never get secret values.')

    const instance = await waitFor(
      () => harness.deps.db<EnvironmentInstanceRow>('environment_instances').where({ runId: run.id, kind: 'run', state: 'stopped' }).first(),
      'the run services to stop',
    )
    expect(instance.secretSets).toEqual([])
    const left = { label: [`factorix.env=${instance.slug}`] }
    expect(await docker.listContainers({ all: true, filters: JSON.stringify(left) })).toEqual([])
    expect((await docker.listVolumes({ filters: JSON.stringify(left) })).Volumes ?? []).toEqual([])
    expect((await docker.listNetworks({ filters: JSON.stringify({ name: [`fx-env-${instance.slug}`] }) })).length).toBe(0)
    const workspace = await harness.deps.db('workspaces').where({ issueId: issue.id }).first()
    expect((await docker.getVolume(workspace.volumeName).inspect()).Name).toBe(workspace.volumeName)
  })

  it('hands the agent copies of the files attached to the issue, outside its repository and masked', async () => {
    harness.world.media.set('https://uploads.linear.app/o/n/1', { contentType: 'text/plain', body: 'the token is dp.sa.the-token\n' })
    script = {
      steps: [
        { exec: 'cat /workspace/.factorix/issue-files/1-notes.txt' },
        { exec: 'git status --porcelain; echo " exit=$?"' },
        { writeFile: { path: 'files.txt', content: 'done\n' } },
        { exec: 'git add files.txt && git commit -qm "chore: files check"' },
      ],
      structuredOutput: { summary: 'Read the files.', approach: 'cat', testing: 'cat', notes: '' },
    }
    const { outputs } = await implement('Read the notes', [
      { kind: 'file', title: 'notes.txt', url: 'https://uploads.linear.app/o/n/1', subtitle: null, content: null },
    ])
    expect(outputs[0]).toBe('the token is [secret removed]\n')
    expect(outputs[1]?.trim()).toBe('exit=0')
  })

  it('lets the agent preview its uncommitted files through the MCP tools and reach the preview directly', async () => {
    script = {
      steps: [
        { writeFile: { path: 'page.txt', content: 'from the working copy\n' } },
        { writeFile: { path: '/tmp/mcp-check.mjs', content: MCP_CHECK } },
        { exec: 'node /tmp/mcp-check.mjs' },
        { exec: 'git add page.txt && git commit -qm "chore: page"' },
      ],
      structuredOutput: { summary: 'Checked the preview.', approach: 'mcp', testing: 'fetch', notes: '' },
    }
    const { issue, outputs } = await implement('Preview the page')
    const check = JSON.parse((outputs[2] as string).split('\n')[0] as string) as {
      status: Record<string, unknown>
      page: string | null
      logs: string
      stopped: unknown
    }
    expect(check.status).toMatchObject({ state: 'ready', source: 'worktree', reach: { web: 'http://web.preview.internal:3000' } })
    expect(check.page).toBe('from the working copy\n')
    expect(check.logs).toContain('web: [factorix] start: python3 -m http.server')
    expect(check.stopped).toEqual({ state: 'stopping' })

    const preview = await waitFor(
      () => harness.deps.db<EnvironmentInstanceRow>('environment_instances').where({ issueId: issue.id, kind: 'preview', state: 'stopped' }).first(),
      'the preview to stop',
    )
    expect(Object.values(preview.commits).map((commit) => commit.ref)).toEqual(['working copy'])
    const audit = await harness.deps.db('audit_log').where({ targetId: issue.id }).whereIn('action', ['preview.start', 'preview.stop']).orderBy('id')
    expect(audit.map((entry) => [entry.action, entry.actorKind])).toEqual([
      ['preview.start', 'agent'],
      ['preview.stop', 'agent'],
    ])
    expect(await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`factorix.env=${preview.slug}`] }) })).toEqual([])
  })
})
