// biome-ignore-all lint/suspicious/noTemplateCurlyInString: definitions use ${...} templates
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EnvironmentInstanceRow } from '@factorix/db'
import { DockerSandboxProvider, dockerClientFromEnv } from '@factorix/sandbox'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { AppDeps } from './deps'
import { previewKeys } from './lib/channels'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness, removeOwnSandboxes, waitFor } from './testing/harness'
import { startWorkers, type WorkerHandle } from './worker'

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const suffix = randomUUID().slice(0, 8)
const stack = `test-${suffix}`
const egressNetwork = `fx-test-penv-egress-${suffix}`
const remoteVolume = `fx-test-penv-remote-${suffix}`
const branch = 'factorix/abc-1-preview'

const SERVER = `
const http = require('http')
const net = require('net')
const [name, port] = process.argv.slice(2)
console.log(name + ' starting with ' + process.env.SECRET_TOKEN)
http.createServer(async (request, response) => {
  if (request.url === '/cache') {
    const socket = net.connect(6379, 'cache', () => socket.write('PING\\r\\n'))
    socket.on('data', (data) => { response.end(data.toString().trim()); socket.end() })
    return
  }
  if (request.url === '/out') {
    const tryFetch = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.status + ' ' + r.headers.get('content-type'), (e) => 'failed')
    response.end(JSON.stringify({ allowed: await tryFetch('http://allowed.test:8000/'), denied: await tryFetch('http://denied.example/') }))
    return
  }
  response.end(name + ' ' + request.url + ' ' + process.env.GREETING + ' ' + (process.env.VERSION_FILE ? require('fs').readFileSync(process.env.VERSION_FILE, 'utf8').trim() : ''))
}).listen(Number(port), '0.0.0.0')
`

const DEFINITION = `services:
  cache:
    image: redis:7
    ready:
      command: redis-cli ping
  api:
    repo: app
    start: node server.js api 4000
    port: 4000
    ready:
      http: /
  web:
    repo: app
    install: mkdir -p node_modules && date >> node_modules/installs
    start: node server.js web 3000
    port: 3000
    secrets: [backend]
    env:
      GREETING: hi
      VERSION_FILE: \${repos.app.path}/version.txt
    ready:
      http: /
    dependsOn: [cache, api]
expose:
  service: web
  paths:
    - prefix: /api
      service: api
      strip: true
`

async function bundle(entry: string, name: string): Promise<{ tar: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'fx-preview-'))
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, name), logLevel: 'silent' })
  const tar = join(dir, `${name}.tar`)
  execFileSync('tar', ['--no-xattrs', '-C', dir, '-cf', tar, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  return { tar, dir }
}

async function git(script: string): Promise<void> {
  const container = await docker.createContainer({
    Image: image,
    User: '0',
    Env: ['HOME=/tmp'],
    Cmd: ['bash', '-c', `set -e\ngit config --global --add safe.directory '*'\n${script}\nchown -R 1000:1000 /remote`],
    HostConfig: { Mounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] },
  })
  await container.start()
  const { StatusCode } = (await container.wait()) as { StatusCode: number }
  const output = (await container.logs({ stdout: true, stderr: true })).toString('utf8')
  await container.remove({ force: true })
  if (StatusCode !== 0) throw new Error(`git setup failed: ${output}`)
}

describe('previews end to end', () => {
  let harness: Harness
  let worker: WorkerHandle
  let member: ApiClient
  let issueId: string
  let gatewayPort: number
  const containers: string[] = []

  const preview = async () => (await member.ok('GET', `/api/issues/${issueId}/preview`)).preview
  const row = async () =>
    (await harness.deps.db<EnvironmentInstanceRow>('environment_instances').where({ issueId }).first()) as EnvironmentInstanceRow
  const until = (state: string, timeoutMs = 240_000) =>
    waitFor(
      async () => {
        const current = await preview()
        if (current.state === 'failed') throw new Error(`The preview failed: ${current.error}`)
        return current.state === state && current
      },
      `the preview to be ${state}`,
      timeoutMs,
    )
  const signIn = async (host: string) => {
    const ticket = new URL((await member.ok('POST', `/api/issues/${issueId}/preview/open`, {})).url)
    const entered = await viaGateway(host, `${ticket.pathname}${ticket.search}`)
    expect(entered.status).toBe(303)
    return String((entered.headers['set-cookie'] as string[])[0]).split(';')[0] as string
  }
  const viaGateway = (host: string, path: string, cookie?: string) =>
    new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((done, fail) => {
      const outbound = httpRequest({ host: '127.0.0.1', port: gatewayPort, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => done({ status: response.statusCode ?? 0, body, headers: response.headers }))
      })
      outbound.on('error', fail)
      outbound.end()
    })

  beforeAll(async () => {
    await docker.createNetwork({ Name: egressNetwork })
    await docker.createVolume({ Name: remoteVolume })
    await git(`
      git init -q -b main --bare /remote/app.git
      git init -q -b main /tmp/seed && cd /tmp/seed
      git config user.name seed && git config user.email seed@example.com
      echo 'node_modules/' > .gitignore && echo one > version.txt
      cat > server.js <<'JS'
${SERVER}
JS
      git add -A && git commit -qm init && git push -q /remote/app.git main
      git -C /remote/app.git symbolic-ref HEAD refs/heads/main
      git checkout -qb ${branch} && echo branch-one > version.txt && git commit -qam change && git push -q /remote/app.git ${branch}
    `)

    const redisPort = new URL(inject('redisUrl')).port
    const redisEnv = `REDIS_URL=redis://host.docker.internal:${redisPort}`
    const stub = await docker.createContainer({
      Image: image,
      Cmd: ['node', '-e', `require('node:http').createServer((q,s)=>s.end('stub')).listen(8000)`],
      HostConfig: { NetworkMode: egressNetwork },
      NetworkingConfig: { EndpointsConfig: { [egressNetwork]: { Aliases: ['allowed.test'] } } },
    })
    await stub.start()
    containers.push(stub.id)

    const proxyBundle = await bundle(resolve(import.meta.dirname, '../../egress-proxy/src/index.ts'), 'proxy.cjs')
    const proxy = await docker.createContainer({
      Image: image,
      Cmd: ['node', '/tmp/proxy.cjs'],
      Env: [redisEnv, 'PORT=8080'],
      Labels: { 'factorix.role': 'egress', 'factorix.stack': stack },
      HostConfig: { NetworkMode: egressNetwork, ExtraHosts: ['host.docker.internal:host-gateway'] },
    })
    await proxy.putArchive(proxyBundle.tar, { path: '/tmp' })
    await proxy.start()
    containers.push(proxy.id)
    rmSync(proxyBundle.dir, { recursive: true, force: true })

    const gatewayBundle = await bundle(resolve(import.meta.dirname, '../../preview-gateway/src/index.ts'), 'gateway.cjs')
    const gateway = await docker.createContainer({
      Image: image,
      Cmd: ['node', '/tmp/gateway.cjs'],
      Env: [redisEnv, 'PORT=4102', 'FACTORIX_PREVIEW_URL=http://preview.localhost'],
      Labels: { 'factorix.role': 'gateway', 'factorix.stack': stack },
      ExposedPorts: { '4102/tcp': {} },
      HostConfig: { PortBindings: { '4102/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] }, ExtraHosts: ['host.docker.internal:host-gateway'] },
    })
    await gateway.putArchive(gatewayBundle.tar, { path: '/tmp' })
    await gateway.start()
    containers.push(gateway.id)
    rmSync(gatewayBundle.dir, { recursive: true, force: true })
    gatewayPort = Number((await gateway.inspect()).NetworkSettings.Ports['4102/tcp']?.[0]?.HostPort)

    harness = await createHarness(
      { databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') },
      {
        sandbox: new DockerSandboxProvider(
          { image, stepNetwork: egressNetwork, stack, extraStepMounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] },
          docker,
        ),
      },
    )
    Object.assign(harness.deps.env, {
      FACTORIX_PROXY_URL: 'http://egress-proxy:8080',
      FACTORIX_PREVIEW_URL: `http://preview.localhost:${gatewayPort}`,
    })
    worker = startWorkers(harness.deps as AppDeps & { sandbox: NonNullable<AppDeps['sandbox']> }, { prefix: harness.prefix, log: () => undefined })

    const admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    await admin.ok('POST', '/api/members', { name: 'Bo', email: 'bo@example.com', password: 'long enough password', role: 'member' })
    member = new ApiClient(harness.app)
    await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
    const linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'lin-token' })).connection.id
    const gitlab = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'git-token', config: {} })).connection.id
    const doppler = (await admin.ok('POST', '/api/connections', { kind: 'doppler', name: 'Doppler', secret: 'dp.sa.the-token' })).connection.id
    harness.world.dopplerConfigs = new Map([['backend/dev', { SECRET_TOKEN: 'super-secret-token-value' }]])
    const project = (
      await admin.ok('POST', '/api/projects', {
        name: 'App',
        trackerConnectionId: linear,
        trackerTeamId: TEAM_ID,
        trackerProjectId: null,
        scmConnectionId: gitlab,
        repos: [{ scmRepoId: '42', scmRepoPath: 'g/app', scmCloneUrl: 'file:///remote/app.git', defaultBranch: 'main' }],
        stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
        networkPolicy: 'restricted',
        networkAllowlist: ['allowed.test'],
      })
    ).project
    await admin.ok('PUT', `/api/projects/${project.id}/environment`, {
      source: DEFINITION,
      secretSets: [{ name: 'backend', connectionId: doppler, project: 'backend', config: 'dev' }],
    })
    const { orgId } = await harness.deps.db('projects').where({ id: project.id }).first()
    ;[{ id: issueId }] = await harness.deps
      .db('issues')
      .insert({ orgId, projectId: project.id, trackerIssueId: 't-1', identifier: 'ABC-1', title: 'Preview me', branchName: branch })
      .returning('id')
  })

  afterAll(async () => {
    await worker?.close()
    const slug = harness ? (await row())?.slug : undefined
    if (slug) {
      await harness.deps.sandbox?.stopEnvironment(slug).catch(() => undefined)
      await harness.deps.sandbox?.removeEnvironmentVolumes(slug, { source: true }).catch(() => undefined)
    }
    if (harness) await removeOwnSandboxes(harness, docker)
    await harness?.destroy()
    for (const id of containers)
      await docker
        .getContainer(id)
        .remove({ force: true })
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

  it('starts the issue branch, signs in with a ticket, and routes by path', async () => {
    await member.ok('POST', `/api/issues/${issueId}/preview/start`)
    const ready = await until('ready')
    expect(ready.services.map((service: { state: string }) => service.state)).toEqual(['ready', 'ready', 'ready'])
    expect(ready.commits).toEqual([{ repo: 'app', ref: branch, sha: expect.stringMatching(/^[0-9a-f]{40}$/) }])

    const host = new URL(ready.url).host
    expect((await viaGateway(host, '/')).status).toBe(401)
    const cookie = await signIn(host)

    expect((await viaGateway(host, '/', cookie)).body).toBe('web / hi branch-one')
    expect((await viaGateway(host, '/api/users?page=2', cookie)).body).toBe('api /users?page=2 undefined ')
    expect((await viaGateway(host, '/cache', cookie)).body).toBe('+PONG')
  })

  it('follows the project network policy through the egress proxy', async () => {
    const host = new URL((await preview()).url).host
    const cookie = await signIn(host)
    const subscriber = harness.deps.redis.duplicate()
    const denials: string[] = []
    subscriber.on('message', (_channel, message) => denials.push(JSON.parse(message).host))
    await subscriber.subscribe(previewKeys.proxyChannel((await row()).slug))
    try {
      const out = JSON.parse((await viaGateway(host, '/out', cookie)).body)
      expect(out).toEqual({ allowed: expect.stringMatching(/^200/), denied: 'failed' })
      await waitFor(async () => denials.includes('denied.example'), 'the denial on the preview channel', 5000)
    } finally {
      subscriber.disconnect()
    }
  })

  it('masks secret values in the logs it keeps', async () => {
    const logs = await waitFor(async () => {
      const lines = (await harness.deps.redis.lrange(previewKeys.logs((await row()).slug), 0, -1)).join('\n')
      return lines.includes('web starting with') && lines
    }, 'the web log line')
    expect(logs).toContain('web starting with ••••••')
    expect(logs).not.toContain('super-secret-token-value')
  })

  it('picks up a new push on refresh', async () => {
    await git(`
      git clone -q -b ${branch} /remote/app.git /tmp/work
      cd /tmp/work
      git config user.name seed
      git config user.email seed@example.com
      echo branch-two > version.txt
      git commit -qam two
      git push -q origin ${branch}
    `)
    await member.ok('POST', `/api/issues/${issueId}/preview/refresh`)
    const ready = await until('ready')
    const host = new URL(ready.url).host
    const cookie = await signIn(host)
    expect((await viaGateway(host, '/', cookie)).body).toBe('web / hi branch-two')
  })

  it('stops completely, and the address says so', async () => {
    const { slug } = await row()
    const host = new URL((await preview()).url).host
    const cookie = await signIn(host)
    await member.ok('POST', `/api/issues/${issueId}/preview/stop`)
    await until('stopped', 60_000)
    expect(await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`factorix.env=${slug}`] }) })).toEqual([])
    expect((await docker.listNetworks({ filters: JSON.stringify({ name: [`fx-env-${slug}`] }) })).length).toBe(0)
    expect((await viaGateway(host, '/', cookie)).status).toBe(404)
  })
})
