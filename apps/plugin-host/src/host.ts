import { type ChildProcess, spawn } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { connect, createServer as createNetServer } from 'node:net'
import { createInterface } from 'node:readline'
import { PAGE_POLICY, PAGE_REQUEST_DROPS, PAGE_RESPONSE_DROPS } from '@factorix/connectors'
import type { BundledPlugin } from './plugins'
import { LIST_PATH, routeOf } from './routing'

export { LIST_PATH, PAGE_POLICY }

export interface HostOptions {
  plugins: BundledPlugin[]
  /** A plugin's environment for one start. It may prepare things first, such as the plugin's database, and a throw counts as a failed start. */
  env(plugin: BundledPlugin, port: number): Promise<Record<string, string>>
  command?: (plugin: BundledPlugin) => { file: string; args: string[] }
  log?: (message: string) => void
  backoff?: { initialMs: number; maxMs: number; resetAfterMs: number }
  readyTimeoutMs?: number
}

export interface PluginHost {
  server: Server
  start(): void
  stop(): Promise<void>
  states(): { name: string; running: boolean }[]
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 30_000, resetAfterMs: 60_000 }
const STOP_GRACE_MS = 5000

const tsxCli = () => createRequire(import.meta.url).resolve('tsx/cli')
const defaultCommand = (plugin: BundledPlugin) => ({ file: process.execPath, args: [tsxCli(), plugin.main] })

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No port'))))
    })
  })
}

const accepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class PluginProcess {
  running = false
  port = 0
  private child: ChildProcess | undefined
  private stopping = false
  private delay: number
  private timer: NodeJS.Timeout | undefined

  constructor(
    readonly plugin: BundledPlugin,
    private readonly options: Required<Pick<HostOptions, 'env' | 'command' | 'log' | 'backoff' | 'readyTimeoutMs'>>,
  ) {
    this.delay = options.backoff.initialMs
  }

  private log(message: string) {
    this.options.log(`[${this.plugin.name}] ${message}`)
  }

  start(): void {
    void this.launch().catch((error: Error) => {
      this.log(`could not start: ${error.message}`)
      this.child?.kill('SIGKILL')
      if (!this.child) this.retry(0)
    })
  }

  private async launch(): Promise<void> {
    if (this.stopping) return
    const port = await freePort()
    const env = await this.options.env(this.plugin, port)
    if (this.stopping) return
    const { file, args } = this.options.command(this.plugin)
    const child = spawn(file, args, { cwd: this.plugin.dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.port = port
    const startedAt = Date.now()
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', (line) => this.log(line))
    let exited = false
    const ended = (reason: string) => {
      if (exited) return
      exited = true
      this.running = false
      this.child = undefined
      if (this.stopping) return
      this.log(reason)
      this.retry(Date.now() - startedAt)
    }
    // A process that never started emits no exit, only this.
    child.once('error', (error) => (child.pid === undefined ? ended(`could not run: ${error.message}`) : this.log(error.message)))
    child.once('exit', (code, signal) => ended(`exited with ${signal ?? `code ${code}`}`))
    const deadline = Date.now() + this.options.readyTimeoutMs
    while (!exited && !this.stopping) {
      if (await accepts(port)) {
        this.running = true
        this.log(`listening on 127.0.0.1:${port}`)
        return
      }
      if (Date.now() > deadline) throw new Error(`it did not listen on its port within ${this.options.readyTimeoutMs} ms`)
      await sleep(100)
    }
  }

  private retry(ranForMs: number): void {
    if (this.stopping) return
    const { initialMs, maxMs, resetAfterMs } = this.options.backoff
    if (ranForMs >= resetAfterMs) this.delay = initialMs
    const wait = this.delay
    this.delay = Math.min(this.delay * 2, maxMs)
    this.log(`restarting in ${wait} ms`)
    this.timer = setTimeout(() => this.start(), wait)
  }

  async stop(): Promise<void> {
    this.stopping = true
    clearTimeout(this.timer)
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const killer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
    await exited
    clearTimeout(killer)
  }
}

function forwardHeaders(request: IncomingMessage, page: boolean): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !(page && PAGE_REQUEST_DROPS.includes(name))) headers[name] = value
  }
  if (!headers['x-forwarded-host'] && request.headers.host) headers['x-forwarded-host'] = request.headers.host
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http'
  const peer = request.socket.remoteAddress
  if (peer) headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${peer}` : peer
  return headers
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Runs every bundled plugin as its own process on a loopback port, and serves them all on one port. */
export function createPluginHost(options: HostOptions): PluginHost {
  const log = options.log ?? ((message: string) => console.error(`[plugin-host] ${message}`))
  const settings = {
    env: options.env,
    command: options.command ?? defaultCommand,
    log,
    backoff: options.backoff ?? DEFAULT_BACKOFF,
    readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
  }
  const processes = new Map(options.plugins.map((plugin) => [plugin.name, new PluginProcess(plugin, settings)]))
  const names = new Set(processes.keys())

  const proxy = (request: IncomingMessage, response: ServerResponse, target: PluginProcess, path: string, page: boolean) => {
    const unavailable = () => answer(response, 502, { error: { message: `The plugin ${target.plugin.name} is not running` } })
    if (!target.running) return unavailable()
    const upstream = httpRequest(
      { host: '127.0.0.1', port: target.port, method: request.method, path, headers: forwardHeaders(request, page) },
      (answered) => {
        const headers: IncomingHttpHeaders = {}
        for (const [name, value] of Object.entries(answered.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name) && !(page && PAGE_RESPONSE_DROPS.includes(name))) headers[name] = value
        }
        if (page) {
          const own = headers['content-security-policy']
          headers['content-security-policy'] = [...(own === undefined ? [] : [own].flat()), PAGE_POLICY]
          headers['referrer-policy'] = 'no-referrer'
          headers['x-content-type-options'] = 'nosniff'
        }
        response.writeHead(answered.statusCode ?? 502, headers)
        answered.pipe(response)
      },
    )
    upstream.on('error', () => (response.headersSent ? response.destroy() : unavailable()))
    request.on('aborted', () => upstream.destroy())
    request.pipe(upstream)
  }

  const states = () => [...processes.values()].map((process) => ({ name: process.plugin.name, running: process.running }))

  const server = createServer((request, response) => {
    const route = routeOf({ method: request.method ?? 'GET', url: request.url ?? '/' }, names)
    if (route.kind === 'list') return answer(response, 200, { plugins: states() })
    const target = route.kind === 'plugin' ? processes.get(route.name) : undefined
    if (!target || route.kind !== 'plugin') return answer(response, 404, { error: { message: 'Not found' } })
    proxy(request, response, target, route.path, route.page)
  })

  return {
    server,
    states,
    start() {
      for (const process of processes.values()) process.start()
    },
    async stop() {
      await Promise.all([...processes.values()].map((process) => process.stop()))
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    },
  }
}
