import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DockerSandboxProvider, dockerClientFromEnv } from '@factorix/sandbox'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { AppDeps } from './deps'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness, issuePayload, removeOwnSandboxes, sendLinearWebhook, waitFor } from './testing/harness'
import { startWorkers, type WorkerHandle } from './worker'

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
    redisUrl: string
  }
}

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const suffix = randomUUID().slice(0, 8)
const agentsNetwork = `fx-test-agents-${suffix}`
const egressNetwork = `fx-test-egress-${suffix}`
const remoteVolume = `fx-test-egress-remote-${suffix}`

const ECHO_SERVER = `require('node:http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({url:q.url,headers:q.headers}))})}).listen(8000)`

describe('egress control', () => {
  let harness: Harness
  let worker: WorkerHandle
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
        `set -e; git init -q -b main --bare /remote/repo.git; git init -q -b main /tmp/seed; cd /tmp/seed; git config user.name seed; git config user.email seed@example.com; echo base > base.txt; git add -A; git commit -qm init; git push -q /remote/repo.git main; git -C /remote/repo.git symbolic-ref HEAD refs/heads/main; chown -R 1000:1000 /remote`,
      ],
      HostConfig: { Mounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] },
    })
    await seed.start()
    await seed.wait()
    await seed.remove({ force: true })

    const stub = await docker.createContainer({
      Image: image,
      Cmd: ['node', '-e', ECHO_SERVER],
      HostConfig: { NetworkMode: egressNetwork },
      NetworkingConfig: { EndpointsConfig: { [egressNetwork]: { Aliases: ['allowed.test', 'connector.test', 'other-connector.test', 'org.test'] } } },
    })
    await stub.start()
    containers.push(stub.id)

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

    const redisPort = new URL(inject('redisUrl')).port
    const proxy = await docker.createContainer({
      Image: image,
      Cmd: ['node', '/tmp/proxy.cjs'],
      Env: [`REDIS_URL=redis://host.docker.internal:${redisPort}`, 'PORT=8080', 'FACTORIX_ANTHROPIC_UPSTREAM=http://allowed.test:8000'],
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
            extraStepMounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }],
          },
          docker,
        ),
        scriptFor: (phase) =>
          phase === 'implement'
            ? {
                steps: [
                  { exec: 'curl -sS --max-time 10 http://allowed.test:8000/through-proxy; echo " exit=$?"' },
                  { exec: 'curl -sS --max-time 10 https://denied.example/ 2>&1; echo " exit=$?"' },
                  { exec: 'curl -sS --max-time 10 http://denied-plain.example/ 2>&1; echo " exit=$?"' },
                  { exec: `curl -sS --noproxy '*' --max-time 5 http://allowed.test:8000/direct 2>&1; echo " exit=$?"` },
                  { exec: `curl -sS --noproxy '*' --max-time 5 http://1.1.1.1/ 2>&1; echo " exit=$?"` },
                  { exec: `curl -sS --max-time 10 -H "x-api-key: $ANTHROPIC_API_KEY" -d '{}' "$ANTHROPIC_BASE_URL/v1/messages"; echo " exit=$?"` },
                  { exec: 'env | grep -c real-anthropic-key; echo " exit=$?"' },
                  { exec: 'curl -sS --max-time 10 http://connector.test:8000/through-connector; echo " exit=$?"' },
                  { exec: 'curl -sS --max-time 10 http://other-connector.test:8000/; echo " exit=$?"' },
                  {
                    exec: `node -e "fetch('http://allowed.test:8000/node-fetch').then((r)=>r.json()).then((b)=>console.log(b.url))" 2>/dev/null; echo " exit=$?"`,
                  },
                  { exec: 'curl -sS --max-time 10 http://org.test:8000/through-org; echo " exit=$?"' },
                  { writeFile: { path: 'egress.txt', content: 'done\n' } },
                  { exec: 'git add egress.txt && git commit -qm "chore: egress check"' },
                ],
                structuredOutput: { summary: 'Checked egress.', approach: 'curl', testing: 'curl', notes: '' },
              }
            : undefined,
        timings: { heartbeatMs: 500, leaseSeconds: 3, recoveryMs: 500, noteDebounceMs: 300 },
      },
    )
    ;(harness.deps.env as { FACTORIX_PROXY_URL?: string }).FACTORIX_PROXY_URL = 'http://egress-proxy:8080'
    worker = startWorkers(harness.deps as AppDeps & { sandbox: NonNullable<AppDeps['sandbox']> }, { prefix: harness.prefix, log: () => undefined })
  })

  afterAll(async () => {
    await worker?.close()
    if (harness) await removeOwnSandboxes(harness, docker)
    await harness?.destroy()
    for (const id of containers)
      await docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => undefined)
    await docker
      .getNetwork(agentsNetwork)
      .remove()
      .catch(() => undefined)
    await docker
      .getNetwork(egressNetwork)
      .remove()
      .catch(() => undefined)
    await docker
      .getVolume(remoteVolume)
      .remove({ force: true })
      .catch(() => undefined)
  })

  it('confines the agent to the allowlist, logs denials, and keeps the real model key out of the container', async () => {
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
    await admin.ok('POST', '/api/connections', { kind: 'anthropic', name: 'Claude', secret: 'real-anthropic-key' })
    const linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'x' })).connection
    const gitlab = (
      await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'y', config: { host: 'http://connector.test:8000' } })
    ).connection
    await admin.ok('POST', '/api/connections', {
      kind: 'gitlab',
      name: 'Other GitLab',
      secret: 'z',
      config: { host: 'http://other-connector.test:8000' },
    })
    await admin.ok('PUT', '/api/settings/network', { mode: 'extend', hosts: ['org.test'] })
    const { project } = await admin.ok('POST', '/api/projects', {
      name: 'Web',
      trackerConnectionId: linear.id,
      trackerTeamId: TEAM_ID,
      scmConnectionId: gitlab.id,
      repos: [{ scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'file:///remote/repo.git', defaultBranch: 'main' }],
      networkPolicy: 'restricted',
      networkAllowlist: ['allowed.test'],
      stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
    })
    const imported = await waitFor(async () => {
      const current = (await admin.ok('GET', `/api/projects/${project.id}`)).project
      return current.syncState === 'idle' && current
    }, 'the project import')
    const labelId = imported.agentLabels['engineer-1']
    const tracker = harness.world.addIssue({
      title: 'Probe the network',
      labels: [{ id: labelId, name: 'engineer-1', parentId: null, isGroup: false }],
    })
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
    const results = payloads.filter((event) => event.type === 'tool.result').map((event) => String(event.output))
    const [allowed, deniedTls, deniedPlain, directStub, directInternet, model, keyCount, connectorHost, otherConnectorHost, nodeFetch, orgHost] =
      results

    const seenByStub = JSON.parse((allowed as string).replace(/ exit=\d+\s*$/, ''))
    expect(seenByStub.url).toBe('/through-proxy')
    expect(seenByStub.headers['proxy-authorization']).toBeUndefined()

    expect(deniedTls).not.toContain('exit=0')
    expect(deniedPlain).toContain('blocked')
    expect(directStub).not.toContain('exit=0')
    expect(directInternet).not.toContain('exit=0')

    const seenByUpstream = JSON.parse((model as string).replace(/ exit=\d+\s*$/, ''))
    expect(seenByUpstream.url).toBe('/v1/messages')
    expect(seenByUpstream.headers['x-api-key']).toBe('real-anthropic-key')
    expect(keyCount?.trim().startsWith('0')).toBe(true)

    const seen = (output: string | undefined) => JSON.parse((output as string).replace(/ exit=\d+\s*$/, ''))
    expect(seen(connectorHost).url).toBe('/through-connector')
    expect(otherConnectorHost).toContain('blocked')
    expect(nodeFetch).toContain('/node-fetch')
    expect(nodeFetch).toContain('exit=0')
    expect(seen(orgHost).url).toBe('/through-org')

    const denials = payloads.filter((event) => event.type === 'log' && event.source === 'egress-proxy').map((event) => event.message)
    expect(denials.some((message) => message.includes('denied.example'))).toBe(true)
    expect(denials.some((message) => message.includes('denied-plain.example'))).toBe(true)
    expect(JSON.stringify(payloads)).toContain('real-anthropic-key')
    await waitFor(async () => (await harness.deps.redis.keys('proxy:token:*')).length === 0, 'the run proxy token to be revoked')

    const probe = async (title: string) => {
      const next = harness.world.addIssue({ title, labels: [{ id: labelId, name: 'engineer-1', parentId: null, isGroup: false }] })
      await sendLinearWebhook(harness.app, linear.id, linear.webhookSecret, issuePayload(next, 'create'))
      const mirror = await waitFor(() => harness.deps.db('issues').where({ trackerIssueId: next.id }).first(), 'the probe mirror row')
      const finished = await waitFor(
        async () => {
          const row = await harness.deps.db('runs').where({ issueId: mirror.id, phase: 'implement' }).first()
          return row && ['succeeded', 'failed'].includes(row.state) ? row : null
        },
        'the probe run to finish',
        180_000,
      )
      return (await events(finished.id)).filter((event) => event.type === 'tool.result').map((event) => String(event.output))
    }

    await admin.ok('PUT', '/api/settings/network', { mode: 'replace', hosts: ['org.test'] })
    const replaced = await probe('Probe with only the organization list')
    expect(seen(replaced[10]).url).toBe('/through-org')
    expect(seen(replaced[0]).url).toBe('/through-proxy')
    expect(replaced[7]).toContain('blocked')

    await admin.ok('PUT', `/api/projects/${project.id}`, { networkPolicy: 'none' })
    const sealed = await probe('Probe a sealed network')
    expect(sealed[7]).toContain('blocked')
    expect(sealed[10]).toContain('blocked')
  })
})
