import { createServer, request as httpRequest, type Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { AsyncQueue } from '@factorix/runtime'
import { type AgentHandle, RoutingSandboxProvider, type SandboxProvider, serveSandbox } from '@factorix/sandbox'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { COOKIE, createGateway, type PreviewRoute, signCookie } from '../../preview-gateway/src/gateway'
import { createRunnerDialer } from '../../preview-gateway/src/runners'
import { connectRunner, type RunnerLink } from '../../remote-runner/src/link'
import { createGrantStore } from '../../remote-runner/src/store'
import { serveTunnel } from '../../remote-runner/src/tunnel'
import { proxyTokenKey, runProxyChannel } from './lib/channels'
import { RunnerLinks, runnerKeys } from './services/runner-link'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }
const REPO = { scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.example/g/r.git', defaultBranch: 'main' }

/** Stands in for Docker on the runner's machine and records what reached it. */
function fakeDocker() {
  const calls: string[] = []
  const provider = {
    ensureWorkspace: async (key: string) => {
      calls.push(`ensureWorkspace ${key}`)
      return { key, volume: `fx-ws-${key}`, mirrorVolume: `fx-mirror-${key}` }
    },
    startAgent: async (): Promise<AgentHandle> => {
      const queue = new AsyncQueue<string>()
      return {
        containerId: 'abc123',
        lines: queue,
        send: (line) => {
          queue.push(`got ${line}`)
          if (line === 'stop') queue.close()
        },
        onStderr: () => undefined,
        wait: async () => ({ exitCode: 0 }),
        detach: () => queue.close(),
      }
    },
    destroyWorkspace: async (key: string) => {
      calls.push(`destroyWorkspace ${key}`)
    },
    listManaged: async () => ({ containers: [], volumes: [] }),
  } as unknown as SandboxProvider
  return { provider, calls }
}

describe('runners', () => {
  let harness: Harness
  let admin: ApiClient
  let url: string
  let links: RunnerLinks
  let link: RunnerLink | undefined
  let runnerId: string
  let secret: string
  const remote = fakeDocker()
  const local = fakeDocker()

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', SETUP)
    await harness.app.listen({ port: 0, host: '127.0.0.1' })
    url = `http://127.0.0.1:${(harness.app.server.address() as AddressInfo).port}`
    links = new RunnerLinks({ db: harness.deps.db, redis: harness.deps.redis, stack: 'factorix' })
  })
  afterAll(async () => {
    link?.close()
    links.close()
    // Connections a closed link opened and never used are not idle to the server, which would wait a minute for them.
    harness.app.server.closeAllConnections()
    await harness.destroy()
  })

  const asRunner = (path: string, body: unknown, token = secret) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('are made by admins, with a token shown once and stored as a hash', async () => {
    const created = await admin.ok('POST', '/api/runners', { name: 'big-box' })
    runnerId = created.runner.id
    secret = created.secret
    expect(secret).toMatch(/^fxr_/)
    expect(created.runner).toMatchObject({ name: 'big-box', online: false, projectCount: 0, prefix: secret.slice(0, 8) })
    expect(JSON.stringify(await admin.ok('GET', '/api/runners'))).not.toContain(secret)
    expect((await harness.deps.db('runners').where({ id: runnerId }).first()).tokenHash).not.toContain(secret)
    expect((await admin.request('POST', '/api/runners', { name: 'big-box' })).status).toBe(409)

    await admin.ok('POST', '/api/members', { name: 'Bo', email: 'bo@example.com', password: 'long enough password', role: 'member' })
    const member = new ApiClient(harness.app)
    await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
    expect((await member.request('POST', '/api/runners', { name: 'mine' })).status).toBe(403)
  })

  it('refuse a wrong token, and a runner token is no way into the rest of the API', async () => {
    expect((await asRunner('/api/runner/grant', { token: 'x' }, 'fxr_nope')).status).toBe(401)
    expect((await fetch(`${url}/api/runner/stream`, { headers: { authorization: 'Bearer fxr_nope' } })).status).toBe(401)
    expect((await fetch(`${url}/api/agents`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401)
  })

  it('refuse work while offline, then carry calls and an agent stream once connected', async () => {
    const provider = await links.provider(runnerId)
    await expect(provider.ensureWorkspace('early')).rejects.toThrow('Runner big-box is offline.')

    link = connectRunner({ url, token: secret, retryMs: 50 })
    serveSandbox(remote.provider, link, { stack: 'runner-stack' })
    await expect.poll(async () => (await admin.ok('GET', '/api/runners')).runners[0].online, { timeout: 10_000 }).toBe(true)
    expect((await admin.ok('GET', '/api/runners')).runners[0].lastSeenAt).not.toBeNull()

    expect(await provider.ensureWorkspace('k1')).toEqual({ key: 'k1', volume: 'fx-ws-k1', mirrorVolume: 'fx-mirror-k1' })
    const handle = await provider.startAgent({ key: 'k1', volume: 'v', mirrorVolume: 'm' }, { runId: 'r', issueKey: 'k1', readOnlyRepo: false })
    expect(handle.containerId).toBe(`rn-${runnerId}:abc123`)
    handle.send('spec')
    handle.send('stop')
    const lines: string[] = []
    for await (const line of handle.lines) lines.push(line)
    expect(lines).toEqual(['got spec', 'got stop'])
    expect(await handle.wait()).toEqual({ exitCode: 0 })
  })

  it('drop a call whose caller stopped waiting before the runner got it', async () => {
    const before = remote.calls.length
    await harness.deps.redis.rpush(
      runnerKeys.down(runnerId),
      JSON.stringify({ t: 'call', id: 'stale', method: 'ensureWorkspace', args: { key: 'stale' }, exp: Date.now() - 1000 }),
    )
    await (await links.provider(runnerId)).ensureWorkspace('fresh')
    expect(remote.calls.slice(before)).toEqual(['ensureWorkspace fresh'])
  })

  it('send a project to its runner, and keep an issue where its workspace already is', async () => {
    const linearId = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'x' })).connection.id
    const gitlabId = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'y', config: {} })).connection.id
    const body = { name: 'Platform', trackerConnectionId: linearId, trackerTeamId: TEAM_ID, scmConnectionId: gitlabId, repos: [REPO] }
    expect((await admin.request('POST', '/api/projects', { ...body, runnerId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404)
    const { project } = await admin.ok('POST', '/api/projects', body)
    expect(project.runnerId).toBeNull()
    const issueOf = async (title: string) => (await admin.ok('POST', `/api/projects/${project.id}/issues`, { title })).issue.id as string

    const router = new RoutingSandboxProvider(local.provider, links.routes())
    const started = await issueOf('Started before the move')
    await router.ensureWorkspace(started)
    expect(local.calls).toEqual([`ensureWorkspace ${started}`])

    expect((await admin.ok('PUT', `/api/projects/${project.id}`, { runnerId })).project.runnerId).toBe(runnerId)
    expect((await admin.ok('GET', '/api/runners')).runners[0].projectCount).toBe(1)
    const later = await issueOf('Opened after the move')
    await router.ensureWorkspace(later)
    await router.ensureWorkspace(started)
    expect(remote.calls.at(-1)).toBe(`ensureWorkspace ${later}`)
    expect(local.calls).toEqual([`ensureWorkspace ${started}`, `ensureWorkspace ${started}`])

    await router.destroyWorkspace(later)
    expect(remote.calls.at(-1)).toBe(`destroyWorkspace ${later}`)
    expect(await harness.deps.db('workspace_runners').where({ workspaceKey: later }).first()).toBeUndefined()
    expect((await router.listManaged()).containers).toEqual([])
  })

  it('tell the runner what a run token allows, and pass its refusals to the run', async () => {
    const grant = { runId: '11111111-2222-4333-8444-555555555555', allow: ['registry.npmjs.org'], anthropicKey: 'sk-real' }
    await harness.deps.redis.set(proxyTokenKey('tok-1'), JSON.stringify(grant), 'EX', 60)
    expect(await (await asRunner('/api/runner/grant', { token: 'tok-1' })).json()).toEqual({ grant })
    expect(await (await asRunner('/api/runner/grant', { token: 'unknown' })).json()).toEqual({ grant: null })

    const subscriber = harness.deps.redis.duplicate()
    const heard: string[] = []
    subscriber.on('message', (_channel, message) => heard.push(message))
    await subscriber.subscribe(runProxyChannel(grant.runId))
    await asRunner('/api/runner/denied', { token: 'tok-1', host: 'evil.example', reason: 'not on the allowlist' })
    await expect.poll(() => heard).toEqual([JSON.stringify({ host: 'evil.example', reason: 'not on the allowlist' })])
    subscriber.disconnect()
  })

  it('carry a preview from the gateway to a service on the runner, and back', async () => {
    const listen = (server: Server) =>
      new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
    const app = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const size = Number(new URL(request.url ?? '/', 'http://app').searchParams.get('size') ?? 0)
        response.writeHead(200, { 'x-got': String(Buffer.concat(chunks).length), 'x-cookie': request.headers.cookie ?? '' })
        response.end(Buffer.alloc(size, 7))
      })
    })
    app.on('upgrade', (_request, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.on('data', (chunk: Buffer) => socket.write(`echo ${chunk}`))
    })
    const appPort = Number(new URL(await listen(app)).port)

    // The runner's machine: its local server, and the tunnel container that talks to it.
    const store = createGrantStore({ link: link as RunnerLink, secret: 'store-secret' })
    const tunnelLink = connectRunner({ url: await listen(store), token: 'store-secret', retryMs: 50 })
    const dialled: string[] = []
    const stopTunnel = serveTunnel(tunnelLink, { allow: (host) => dialled.push(host) > 0 && host !== 'fx-env-other-db' })

    // Beside Factorix: the gateway, which has Redis and nothing else.
    const key = Buffer.alloc(32, 7)
    const slug = 'aaaaaaaaaa'
    const target = { host: '127.0.0.1', port: appPort, runner: runnerId }
    const route: PreviewRoute = {
      instanceId: 'i',
      state: 'ready',
      upstream: target,
      paths: [{ prefix: '/db', strip: false, host: 'fx-env-other-db', port: 5432, runner: runnerId }],
      frameAncestors: [],
      issueUrl: null,
    }
    const dialer = createRunnerDialer(harness.deps.redis)
    const gateway = createGateway({
      baseUrl: 'http://preview.localhost:4102',
      dial: dialer.dial,
      store: { route: async () => route, consumeTicket: async () => null, cookieKey: async () => key, seen: () => undefined },
    })
    const gatewayPort = Number(new URL(await listen(gateway)).port)
    const headers = {
      host: `${slug}.preview.localhost`,
      cookie: `${COOKIE}=${signCookie(key, slug, Math.floor(Date.now() / 1000) + 60)}; theme=dark`,
    }
    const ask = (path: string, body?: Buffer) =>
      new Promise<{ status: number; got: string; cookie: string; size: number }>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: gatewayPort, path, method: body ? 'POST' : 'GET', headers }, (response) => {
          let size = 0
          response.on('data', (chunk: Buffer) => (size += chunk.length))
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, got: String(response.headers['x-got']), cookie: String(response.headers['x-cookie']), size }),
          )
        })
        request.on('error', reject)
        request.end(body)
      })

    try {
      await expect.poll(async () => (await ask('/')).status, { timeout: 10_000 }).toBe(200)
      expect(await ask('/big?size=3000000')).toMatchObject({ status: 200, size: 3_000_000, cookie: 'theme=dark' })
      expect(await ask('/upload', Buffer.alloc(2_500_000, 1))).toMatchObject({ status: 200, got: '2500000' })
      expect((await ask('/db')).status).toBe(502)
      expect(dialled).toContain('fx-env-other-db')

      const upgraded = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: gatewayPort }, () => {
          socket.write(
            `GET /socket HTTP/1.1\r\nHost: ${headers.host}\r\nCookie: ${headers.cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          )
        })
        let text = ''
        socket.on('data', (chunk: Buffer) => {
          text += chunk
          if (text.includes('\r\n\r\n') && !text.includes('echo')) socket.write('hello')
          if (text.includes('echo hello')) {
            socket.destroy()
            resolve(text)
          }
        })
        socket.on('error', reject)
      })
      expect(upgraded).toMatch(/^HTTP\/1.1 101/)

      const heard: string[] = []
      const workers = harness.deps.redis.duplicate()
      workers.on('message', (_channel, message) => heard.push(message))
      await workers.subscribe(runnerKeys.up(runnerId))
      expect((await ask('/')).status).toBe(200)
      expect(heard).toEqual([])
      workers.disconnect()

      stopTunnel()
      tunnelLink.close()
      await expect.poll(async () => (await ask('/')).status, { timeout: 10_000 }).toBe(502)
    } finally {
      dialer.close()
      gateway.close()
      gateway.closeAllConnections()
      store.close()
      store.closeAllConnections()
      app.close()
      app.closeAllConnections()
    }
  })

  it('go offline when the connection closes, and removing one frees its projects', async () => {
    link?.close()
    link = undefined
    await expect.poll(async () => (await admin.ok('GET', '/api/runners')).runners[0].online, { timeout: 15_000 }).toBe(false)
    expect((await admin.request('DELETE', `/api/runners/${runnerId}`)).status).toBe(200)
    expect((await admin.ok('GET', '/api/projects')).projects[0].runnerId).toBeNull()
    expect((await asRunner('/api/runner/grant', { token: 'tok-1' })).status).toBe(401)
  })
})
