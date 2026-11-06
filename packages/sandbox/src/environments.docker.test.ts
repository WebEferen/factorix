import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerSandboxProvider, dockerClientFromEnv } from './docker'
import { environmentDataVolume, environmentSourceVolume, IMAGE_SERVICE_CAPS, serviceContainerName } from './profiles'
import type { Environment, LogLine, ServiceSpec, Workspace } from './provider'

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const suffix = randomUUID().slice(0, 8)
const remoteVolume = `fx-test-envremote-${suffix}`
const issueKey = `test-env-${suffix}`
const keyA = `ta${suffix}`
const keyB = `tb${suffix}`
const repoEnv = { FX_REPO_NAME: 'app', FX_REPO_URL: '/remote/app.git', FX_BRANCH: 'factorix/abc-1', FX_BASE_BRANCH: 'main' }

const SERVER = `
const http = require('http')
const net = require('net')
http.createServer((request, response) => {
  if (request.url === '/cache') {
    const socket = net.connect(6379, 'cache', () => socket.write('PING\\r\\n'))
    socket.on('data', (data) => { response.end('cache says ' + data.toString().trim()); socket.end() })
    socket.on('error', (error) => { response.statusCode = 500; response.end(error.message) })
    return
  }
  response.end('hello from ' + process.env.GREETING)
}).listen(3000, '0.0.0.0', () => console.log('listening on 3000'))
`

/** Without a TTY, Docker frames output: an 8-byte header, with the payload size in its last four bytes. */
function demux(raw: Buffer): string {
  const parts: Buffer[] = []
  for (let offset = 0; offset + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(offset + 4)
    parts.push(raw.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size
  }
  return Buffer.concat(parts).toString('utf8')
}

async function asRoot(script: string, mounts: { Source: string; Target: string }[] = [{ Source: remoteVolume, Target: '/remote' }]): Promise<string> {
  const container = await docker.createContainer({
    Image: image,
    User: '0',
    Cmd: ['bash', '-c', script],
    HostConfig: { Mounts: mounts.map((mount) => ({ Type: 'volume' as const, ...mount })) },
  })
  await container.start()
  const { StatusCode } = (await container.wait()) as { StatusCode: number }
  const logs = demux(await container.logs({ stdout: true, stderr: true }))
  await container.remove({ force: true })
  if (StatusCode !== 0) throw new Error(`setup failed: ${logs}`)
  return logs
}

/** Runs node inside a preview's network, the way another service there would. */
async function probe(network: string, code: string): Promise<string> {
  const container = await docker.createContainer({
    Image: image,
    Cmd: ['node', '-e', code],
    Labels: { 'factorix.managed': 'true', 'factorix.kind': 'step' },
    HostConfig: { NetworkMode: network },
  })
  await container.start()
  await container.wait()
  const raw = await container.logs({ stdout: true, stderr: true })
  await container.remove({ force: true })
  return demux(raw).trim()
}

const fetchCode = (url: string) =>
  `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).then(console.log, (e) => console.log('failed: ' + (e.cause?.code ?? e.message)))`

async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

describe('preview environments', () => {
  let provider: DockerSandboxProvider
  let workspace: Workspace
  let environment: Environment
  let source: Workspace

  const web = (greeting: string): ServiceSpec => ({
    service: 'web',
    repoCode: true,
    script: [
      'set -e',
      'cd /workspace/repos/app',
      'mkdir -p node_modules && date >> node_modules/installs',
      `if [ ! -e /workspace/.factorix/setup/web-1 ]; then echo seeded >> node_modules/setups; mkdir -p /workspace/.factorix/setup; touch /workspace/.factorix/setup/web-1; fi`,
      "exec sh -c 'node server.js'",
    ].join('\n'),
    workdir: '/workspace/repos/app',
    env: { GREETING: greeting, HOME: '/workspace/.home' },
    mounts: [{ volume: environmentSourceVolume(keyA), target: '/workspace', readOnly: false }],
    healthcheck: `node -e "fetch('http://127.0.0.1:3000/').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"`,
  })
  const cache: ServiceSpec = {
    service: 'cache',
    image: 'redis:7',
    repoCode: false,
    env: {},
    mounts: [{ volume: environmentDataVolume(keyA, 'cache'), target: '/data', readOnly: false }],
    healthcheck: 'redis-cli ping',
  }
  const waitHealthy = (id: string) => waitUntil(async () => (await provider.serviceState(id)).state === 'healthy', `${id} to be healthy`)

  beforeAll(async () => {
    await docker.createVolume({ Name: remoteVolume })
    await asRoot(`
      set -e
      git init -q -b main --bare /remote/app.git
      git init -q -b main /tmp/seed && cd /tmp/seed
      git config user.name seed && git config user.email seed@example.com
      echo 'node_modules/' > .gitignore
      cat > server.js <<'JS'
${SERVER}
JS
      git add -A && git commit -qm init && git push -q /remote/app.git main
      git checkout -qb factorix/abc-1 && echo change > change.txt && git add -A && git commit -qm change
      git push -q /remote/app.git factorix/abc-1
      chown -R 1000:1000 /remote
    `)
    provider = new DockerSandboxProvider({ image, extraStepMounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] }, docker)
    workspace = await provider.ensureWorkspace(issueKey)
    environment = await provider.ensureEnvironment(keyA, { internal: true, labels: { 'factorix.issue': issueKey } })
    source = { key: issueKey, volume: environment.sourceVolume, mirrorVolume: workspace.mirrorVolume }
  })

  afterAll(async () => {
    for (const key of [keyA, keyB]) {
      await provider.stopEnvironment(key).catch(() => undefined)
      await provider.removeEnvironmentVolumes(key, { source: true }).catch(() => undefined)
    }
    await provider.destroyWorkspace(issueKey).catch(() => undefined)
    await docker
      .getVolume(remoteVolume)
      .remove({ force: true })
      .catch(() => undefined)
  })

  it('copies the issue branch into the preview with no token, even past git config preview code planted', async () => {
    expect((await provider.runStep(workspace, { op: 'mirror-fetch', env: repoEnv, gitToken: 'not-a-real-token' })).exitCode).toBe(0)
    await expect(provider.runStep(source, { op: 'export', env: repoEnv, gitToken: 'not-a-real-token' })).rejects.toThrow(/must not receive/)
    const first = await provider.runStep(source, { op: 'export', env: repoEnv })
    expect(first.exitCode).toBe(0)
    expect(first.values.REF).toBe('factorix/abc-1')
    expect(first.values.HEAD).toMatch(/^[0-9a-f]{40}$/)

    await asRoot(
      `
      set -e
      cd /workspace/repos/app
      printf '#!/bin/sh\\necho "[$GIT_TOKEN]" >> /workspace/leak\\nexit 1\\n' > /workspace/steal && chmod +x /workspace/steal
      git -c safe.directory='*' config core.fsmonitor /workspace/steal
      chown -R 1000:1000 /workspace
    `,
      [{ Source: environment.sourceVolume, Target: '/workspace' }],
    )
    const again = await provider.runStep(source, { op: 'export', env: { ...repoEnv, FX_BRANCH: 'no-such-branch' } })
    expect(again.exitCode).toBe(0)
    expect(again.values.REF).toBe('main')
    const leak = await asRoot('cat /workspace/leak 2>/dev/null || true', [{ Source: environment.sourceVolume, Target: '/workspace' }])
    expect(leak).not.toContain('not-a-real-token')
    await provider.runStep(source, { op: 'export', env: repoEnv })
  })

  it('runs an image and repository code on a private network, each with only its own rights', async () => {
    const cacheId = await provider.startService(environment, cache)
    await waitHealthy(cacheId)
    const webId = await provider.startService(environment, web('one'))
    await waitHealthy(webId)

    expect(await probe(environment.network, fetchCode('http://web:3000/cache'))).toBe('cache says +PONG')
    expect(await probe(environment.network, fetchCode('http://web:3000/'))).toBe('hello from one')

    const webInfo = await docker.getContainer(webId).inspect()
    expect(webInfo.Name).toBe(`/${serviceContainerName(keyA, 'web')}`)
    expect(webInfo.Config.User).toBe('1000:1000')
    expect(webInfo.HostConfig).toMatchObject({ CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Privileged: false })
    expect(webInfo.HostConfig.CapAdd ?? []).toEqual([])
    expect(webInfo.Mounts.map((mount) => mount.Name)).toEqual([environment.sourceVolume])
    expect(Object.keys(webInfo.NetworkSettings.Networks)).toEqual([environment.network])
    const cacheInfo = await docker.getContainer(cacheId).inspect()
    expect(cacheInfo.HostConfig.CapAdd).toEqual(IMAGE_SERVICE_CAPS)
    expect(cacheInfo.HostConfig.Privileged).toBe(false)
  })

  it('has no way out to the internet but the egress proxy', async () => {
    expect(await probe(environment.network, fetchCode('http://1.1.1.1/'))).toMatch(/^failed/)
  })

  it('cannot be reached from another preview', async () => {
    const other = await provider.ensureEnvironment(keyB, { internal: true, labels: {} })
    expect(await probe(other.network, fetchCode('http://web:3000/'))).toMatch(/^failed: (ENOTFOUND|EAI_AGAIN)/)
    expect(await probe(other.network, fetchCode(`http://${serviceContainerName(keyA, 'web')}:3000/`))).toMatch(/^failed: (ENOTFOUND|EAI_AGAIN)/)
  })

  it('streams service output until told to stop', async () => {
    const id = (await docker.listContainers({ filters: JSON.stringify({ name: [serviceContainerName(keyA, 'web')] }) }))[0]?.Id as string
    const lines: LogLine[] = []
    const controller = new AbortController()
    const following = provider.followLogs(id, { signal: controller.signal }, (line) => lines.push(line))
    await waitUntil(async () => lines.some((line) => line.text === 'listening on 3000'), 'the log line', 20_000)
    controller.abort()
    await following
    expect(lines.find((line) => line.text === 'listening on 3000')).toMatchObject({ stream: 'stdout', ts: expect.any(Number) })
  })

  it('restarts code on refresh, keeping installs, setup, and data', async () => {
    await provider.stopEnvironment(keyA, ['web'])
    await provider.runStep(source, { op: 'export', env: repoEnv })
    const webId = await provider.startService(environment, web('two'))
    await waitHealthy(webId)
    expect(await probe(environment.network, fetchCode('http://web:3000/'))).toBe('hello from two')
    const files = await asRoot('wc -l < /workspace/repos/app/node_modules/installs; wc -l < /workspace/repos/app/node_modules/setups', [
      { Source: environment.sourceVolume, Target: '/workspace' },
    ])
    expect(files.trim().split(/\s+/)).toEqual(['2', '1'])
  })

  it('stops everything, keeps volumes for the next start, and removes them when asked', async () => {
    await provider.stopEnvironment(keyA)
    const left = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`factorix.env=${keyA}`] }) })
    expect(left).toEqual([])
    expect((await docker.listNetworks({ filters: JSON.stringify({ name: [environment.network] }) })).length).toBe(0)
    const volumes = async () => ((await provider.listManaged()).volumes ?? []).filter((volume) => volume.envKey === keyA).map((volume) => volume.name)
    expect(await volumes()).toEqual(expect.arrayContaining([environment.sourceVolume, environmentDataVolume(keyA, 'cache')]))
    await provider.removeEnvironmentVolumes(keyA, { source: false })
    expect(await volumes()).toEqual([environment.sourceVolume])
    await provider.removeEnvironmentVolumes(keyA, { source: true })
    expect(await volumes()).toEqual([])
  })
})
