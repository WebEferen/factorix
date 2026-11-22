import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledPluginSecret } from '@factorix/connectors'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPluginHost, type PluginHost } from './host'
import { childEnv, discoverPlugins } from './plugins'

const ECHO = `import { createServer } from 'node:http'
createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    res.writeHead(201, { 'content-type': 'application/json', 'x-plugin': 'echo' })
    res.end(JSON.stringify({
      pid: process.pid,
      method: req.method,
      url: req.url,
      host: req.headers.host,
      forwardedHost: req.headers['x-forwarded-host'],
      body: Buffer.concat(chunks).toString(),
      secret: process.env.PLUGIN_SECRET,
      key: process.env.FACTORIX_PLUGINS_KEY ?? null,
    }))
  })
}).listen(Number(process.env.PORT), process.env.HOST)
`

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  json: Record<string, unknown>
}

function send(port: number, method: string, host: string, path: string, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, method, path, headers: { host } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, json: JSON.parse(Buffer.concat(chunks).toString()) }),
      )
    })
    sent.on('error', reject)
    sent.end(body)
  })
}

async function until<T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

describe('plugin host', () => {
  const key = 'the-installation-plugins-key'
  let dir: string
  let host: PluginHost
  let port: number
  const running = async (name: string) =>
    ((await send(port, 'GET', `127.0.0.1:${port}`, '/__plugins')).json.plugins as { name: string; running: boolean }[]).find(
      (plugin) => plugin.name === name,
    )?.running

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fx-plugin-host-'))
    for (const [name, code] of [
      ['echo', ECHO],
      ['broken', 'process.exit(1)\n'],
    ] as const) {
      await mkdir(join(dir, name))
      await writeFile(join(dir, name, 'package.json'), JSON.stringify({ factorix: { main: 'server.mjs' } }))
      await writeFile(join(dir, name, 'server.mjs'), code)
    }
    const plugins = await discoverPlugins(dir, () => undefined)
    host = createPluginHost({
      plugins,
      publicUrl: 'http://plugins.test',
      log: () => undefined,
      backoff: { initialMs: 50, maxMs: 200, resetAfterMs: 60_000 },
      env: async (plugin, childPort) =>
        childEnv(plugin, {
          key,
          port: childPort,
          factorixUrl: 'http://api.test',
          publicUrl: 'http://plugins.test',
          names: plugins.map((item) => item.name),
          hostEnv: { ...process.env, FACTORIX_PLUGINS_KEY: key },
        }),
    })
    await new Promise<void>((resolve) => host.server.listen(0, '127.0.0.1', resolve))
    port = (host.server.address() as AddressInfo).port
    host.start()
    await until(() => running('echo'), 'the echo plugin to listen')
  }, 30_000)

  afterAll(async () => {
    await host?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('serves a page from the plugin subdomain with the request unchanged', async () => {
    const answer = await send(port, 'POST', 'echo.plugins.test', '/factorix/pages/board?factorix=t', 'a=1')
    expect(answer.status).toBe(201)
    expect(answer.headers['x-plugin']).toBe('echo')
    expect(answer.json).toMatchObject({
      method: 'POST',
      url: '/factorix/pages/board?factorix=t',
      host: 'echo.plugins.test',
      forwardedHost: 'echo.plugins.test',
      body: 'a=1',
      secret: bundledPluginSecret(key, 'echo'),
      key: null,
    })
  })

  it('takes signed calls by path and refuses pages that way', async () => {
    const answer = await send(port, 'POST', 'plugins:4110', '/echo/factorix', '{"method":"manifest"}')
    expect(answer.json).toMatchObject({ url: '/factorix', body: '{"method":"manifest"}' })
    expect((await send(port, 'GET', 'plugins:4110', '/echo/factorix/pages/board')).status).toBe(404)
    expect((await send(port, 'GET', 'nobody.plugins.test', '/')).status).toBe(404)
  })

  it('keeps serving one plugin while another keeps failing', async () => {
    expect(await running('broken')).toBe(false)
    const answer = await send(port, 'POST', 'plugins:4110', '/broken/factorix', '{}')
    expect(answer).toMatchObject({ status: 502, json: { error: { message: 'The plugin broken is not running' } } })
    expect((await send(port, 'POST', 'plugins:4110', '/echo/factorix', '{}')).status).toBe(201)
  })

  it('starts a plugin again after it dies', async () => {
    const before = (await send(port, 'POST', 'plugins:4110', '/echo/factorix', '{}')).json.pid as number
    process.kill(before, 'SIGKILL')
    await until(async () => (await running('echo')) === false, 'the host to see the plugin die')
    const after = await until(async () => {
      if (!(await running('echo'))) return null
      return (await send(port, 'POST', 'plugins:4110', '/echo/factorix', '{}')).json.pid as number
    }, 'the plugin to come back')
    expect(after).not.toBe(before)
  })
})
