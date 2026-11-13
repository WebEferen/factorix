import { randomUUID } from 'node:crypto'
import { AsyncQueue, type RuntimeId, type RuntimeModelCatalog, type TunnelFrame } from '@factorix/runtime'
import type {
  AgentHandle,
  Environment,
  LogLine,
  ManagedContainer,
  ManagedVolume,
  SandboxProvider,
  ServiceSpec,
  ServiceState,
  StartAgentOptions,
  StepRequest,
  StepResult,
  Workspace,
} from './provider'

/** What travels between a worker and a runner on another machine. `exp` lets the carrier drop a call nobody waits for any more. */
export type RunnerFrame =
  | { t: 'call'; id: string; method: string; args: Record<string, unknown>; exp: number }
  | { t: 'abort'; id: string }
  | { t: 'agent.send'; stream: string; line: string }
  | { t: 'agent.detach'; stream: string }
  | { t: 'result'; id: string; ok: true; value: unknown }
  | { t: 'result'; id: string; ok: false; error: string }
  | { t: 'agent.line'; stream: string; line: string }
  | { t: 'agent.stderr'; stream: string; line: string }
  | { t: 'agent.end'; stream: string }
  | { t: 'log'; id: string; line: LogLine }
  | TunnelFrame

export interface FrameTransport {
  send(frame: RunnerFrame): void
  /** Returns a function that stops listening. */
  onFrame(listener: (frame: RunnerFrame) => void): () => void
}

const CONTAINER_TAG = /^rn-([0-9a-f-]{36}):(.+)$/

/** The runner a container id from a remote provider belongs to, or null for a local one. */
export function runnerOfContainer(containerId: string): string | null {
  return CONTAINER_TAG.exec(containerId)?.[1] ?? null
}

const SECOND = 1000
const DEFAULT_TIMEOUT_MS = 120 * SECOND
/** Starting something can pull an image first. */
const START_TIMEOUT_MS = 20 * 60 * SECOND
/** Waiting on a container or following its logs lasts as long as the container does. */
const OPEN_ENDED_MS = 26 * 3600 * SECOND
const PRESENCE_CHECK_MS = 15 * SECOND

export interface RemoteSandboxOptions {
  runnerId: string
  /** For messages a person reads. */
  name: string
  /** Checked before each call and while anything is pending, so a runner that went away fails calls instead of hanging them. */
  online?: () => Promise<boolean>
  /** Everything the runner lists is reported under this stack, which is how the worker's cleanup knows it may touch it. */
  stack?: string
  presenceCheckMs?: number
  timeoutMs?: number
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

class RemoteAgentHandle implements AgentHandle {
  readonly queue = new AsyncQueue<string>()
  readonly stderrListeners = new Set<(line: string) => void>()
  containerId = ''

  constructor(
    private readonly stream: string,
    private readonly owner: RemoteSandboxProvider,
  ) {}

  get lines(): AsyncIterable<string> {
    return this.queue
  }

  send(line: string): void {
    this.owner.transport.send({ t: 'agent.send', stream: this.stream, line })
  }

  onStderr(listener: (line: string) => void): void {
    this.stderrListeners.add(listener)
  }

  wait(): Promise<{ exitCode: number }> {
    return this.owner.call<{ exitCode: number }>('agent.wait', { stream: this.stream }, OPEN_ENDED_MS)
  }

  detach(): void {
    this.queue.close()
    this.owner.release(this.stream)
    this.owner.transport.send({ t: 'agent.detach', stream: this.stream })
  }
}

/** A SandboxProvider whose containers run on another machine, reached through whatever carries the frames. */
export class RemoteSandboxProvider implements SandboxProvider {
  private readonly pending = new Map<string, Pending>()
  private readonly streams = new Map<string, RemoteAgentHandle>()
  private readonly logs = new Map<string, (line: LogLine) => void>()
  private readonly stopListening: () => void
  private presenceTimer: NodeJS.Timeout | undefined

  constructor(
    readonly transport: FrameTransport,
    private readonly options: RemoteSandboxOptions,
  ) {
    this.stopListening = transport.onFrame((frame) => this.receive(frame))
  }

  close(): void {
    this.stopListening()
    this.fail(new Error(`The link to runner ${this.options.name} was closed.`))
  }

  private tag(containerId: string): string {
    return `rn-${this.options.runnerId}:${containerId}`
  }

  private untag(containerId: string): string {
    return CONTAINER_TAG.exec(containerId)?.[2] ?? containerId
  }

  private receive(frame: RunnerFrame): void {
    if (frame.t === 'result') {
      const waiting = this.pending.get(frame.id)
      if (!waiting) return
      this.pending.delete(frame.id)
      clearTimeout(waiting.timer)
      if (frame.ok) waiting.resolve(frame.value)
      else waiting.reject(new Error(frame.error))
    } else if (frame.t === 'agent.line') {
      this.streams.get(frame.stream)?.queue.push(frame.line)
    } else if (frame.t === 'agent.stderr') {
      for (const listener of this.streams.get(frame.stream)?.stderrListeners ?? []) listener(frame.line)
    } else if (frame.t === 'agent.end') {
      this.streams.get(frame.stream)?.queue.close()
    } else if (frame.t === 'log') {
      this.logs.get(frame.id)?.(frame.line)
    }
  }

  /** Ends everything that waits on the runner. Agent streams close, which the executor treats as a lost container and recovers from. */
  private fail(error: Error): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
    }
    this.pending.clear()
    for (const handle of this.streams.values()) handle.queue.close()
    this.streams.clear()
    this.watchPresence()
  }

  private watchPresence(): void {
    const busy = this.pending.size > 0 || this.streams.size > 0
    if (!busy || !this.options.online) {
      clearInterval(this.presenceTimer)
      this.presenceTimer = undefined
      return
    }
    if (this.presenceTimer) return
    this.presenceTimer = setInterval(() => {
      void this.options.online?.().then(
        (online) => {
          if (!online) this.fail(new Error(`Runner ${this.options.name} went offline.`))
        },
        () => undefined,
      )
    }, this.options.presenceCheckMs ?? PRESENCE_CHECK_MS)
    this.presenceTimer.unref?.()
  }

  release(stream: string): void {
    this.streams.delete(stream)
    this.watchPresence()
  }

  async call<T>(method: string, args: Record<string, unknown>, timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.options.online && !(await this.options.online())) throw new Error(`Runner ${this.options.name} is offline.`)
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.watchPresence()
        reject(new Error(`Runner ${this.options.name} did not answer ${method} in time.`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (value) => {
          this.watchPresence()
          resolve(value as T)
        },
        reject: (error) => {
          this.watchPresence()
          reject(error)
        },
        timer,
      })
      this.watchPresence()
      this.transport.send({ t: 'call', id, method, args, exp: Date.now() + timeoutMs })
    })
  }

  listRuntimeModels(): Promise<Partial<Record<RuntimeId, RuntimeModelCatalog>>> {
    return this.call('listRuntimeModels', {}, START_TIMEOUT_MS)
  }

  ensureWorkspace(key: string): Promise<Workspace> {
    return this.call('ensureWorkspace', { key })
  }

  runStep(workspace: Workspace, request: StepRequest): Promise<StepResult> {
    return this.call('runStep', { workspace, request }, ((request.timeoutSeconds ?? 600) + 120) * SECOND)
  }

  private async openAgent(method: 'startAgent' | 'reattach', args: Record<string, unknown>): Promise<AgentHandle | null> {
    const stream = randomUUID()
    const handle = new RemoteAgentHandle(stream, this)
    // Registered before the call, so lines that arrive ahead of its answer are kept.
    this.streams.set(stream, handle)
    try {
      const opened = await this.call<{ containerId: string } | null>(method, { ...args, stream }, START_TIMEOUT_MS)
      if (!opened) {
        this.release(stream)
        return null
      }
      handle.containerId = this.tag(opened.containerId)
      return handle
    } catch (error) {
      this.release(stream)
      throw error
    }
  }

  async startAgent(workspace: Workspace, options: StartAgentOptions): Promise<AgentHandle> {
    return (await this.openAgent('startAgent', { workspace, options })) as AgentHandle
  }

  reattach(containerId: string): Promise<AgentHandle | null> {
    return this.openAgent('reattach', { containerId: this.untag(containerId) })
  }

  isRunning(containerId: string): Promise<boolean> {
    return this.call('isRunning', { containerId: this.untag(containerId) })
  }

  stop(containerId: string, graceSeconds: number): Promise<void> {
    return this.call('stop', { containerId: this.untag(containerId), graceSeconds }, (graceSeconds + 120) * SECOND)
  }

  remove(containerId: string): Promise<void> {
    return this.call('remove', { containerId: this.untag(containerId) })
  }

  destroyWorkspace(key: string): Promise<void> {
    return this.call('destroyWorkspace', { key }, START_TIMEOUT_MS)
  }

  async listManaged(): Promise<{ containers: ManagedContainer[]; volumes: ManagedVolume[] }> {
    const managed = await this.call<{ containers: (Omit<ManagedContainer, 'createdAt'> & { createdAt: string })[]; volumes: ManagedVolume[] }>(
      'listManaged',
      {},
    )
    return {
      containers: managed.containers.map((container) => ({
        ...container,
        id: this.tag(container.id),
        createdAt: new Date(container.createdAt),
        stack: this.options.stack,
      })),
      volumes: managed.volumes.map((volume) => ({ ...volume, stack: this.options.stack })),
    }
  }

  async ensureEnvironment(key: string, options: { internal: boolean; labels: Record<string, string>; sourceVolume?: string }): Promise<Environment> {
    return { ...(await this.call<Environment>('ensureEnvironment', { key, options })), runner: this.options.runnerId }
  }

  async startService(environment: Environment, spec: ServiceSpec): Promise<string> {
    return this.tag(await this.call<string>('startService', { environment, spec }, START_TIMEOUT_MS))
  }

  serviceState(containerId: string): Promise<{ state: ServiceState; exitCode?: number }> {
    return this.call('serviceState', { containerId: this.untag(containerId) })
  }

  joinEnvironment(environment: Environment, role: 'gateway' | 'egress', alias: string): Promise<boolean> {
    return this.call('joinEnvironment', { environment, role, alias })
  }

  attachToEnvironment(key: string, containerId: string): Promise<boolean> {
    return this.call('attachToEnvironment', { key, containerId: this.untag(containerId) })
  }

  async followLogs(containerId: string, options: { since?: number; signal: AbortSignal }, onLine: (line: LogLine) => void): Promise<void> {
    if (options.signal.aborted) return
    const id = randomUUID()
    const abort = () => this.transport.send({ t: 'abort', id })
    this.logs.set(id, onLine)
    options.signal.addEventListener('abort', abort, { once: true })
    try {
      await this.call('followLogs', { containerId: this.untag(containerId), since: options.since, id }, OPEN_ENDED_MS)
    } finally {
      options.signal.removeEventListener('abort', abort)
      this.logs.delete(id)
    }
  }

  stopEnvironment(key: string, services?: string[]): Promise<void> {
    return this.call('stopEnvironment', { key, services }, START_TIMEOUT_MS)
  }

  removeEnvironmentVolumes(key: string, options: { source: boolean }): Promise<void> {
    return this.call('removeEnvironmentVolumes', { key, options }, START_TIMEOUT_MS)
  }
}

export interface ServeSandboxOptions {
  /** The runner's own stack. Only what carries it is listed, so a worker never cleans up another install on the same Docker host. */
  stack?: string
  log?: (message: string) => void
}

// biome-ignore lint/suspicious/noExplicitAny: arguments arrive as JSON and each handler names the ones it reads
type Args = any

/** The runner's side: answers frames by calling a real provider. Returns a function that detaches everything it holds. */
export function serveSandbox(provider: SandboxProvider, transport: FrameTransport, options: ServeSandboxOptions = {}): () => void {
  const streams = new Map<string, AgentHandle>()
  const aborts = new Map<string, AbortController>()

  const open = async (stream: string, handle: AgentHandle | null): Promise<{ containerId: string } | null> => {
    if (!handle) return null
    streams.set(stream, handle)
    handle.onStderr((line) => transport.send({ t: 'agent.stderr', stream, line }))
    void (async () => {
      try {
        for await (const line of handle.lines) transport.send({ t: 'agent.line', stream, line })
      } catch (error) {
        options.log?.(`agent stream ${stream} failed: ${(error as Error).message}`)
      }
      transport.send({ t: 'agent.end', stream })
    })()
    return { containerId: handle.containerId }
  }

  const stream = (id: string): AgentHandle => {
    const handle = streams.get(id)
    if (!handle) throw new Error('That agent stream is not open on this runner.')
    return handle
  }

  const handlers: Record<string, (args: Args) => Promise<unknown>> = {
    listRuntimeModels: () => provider.listRuntimeModels(),
    ensureWorkspace: ({ key }) => provider.ensureWorkspace(key),
    runStep: ({ workspace, request }) => provider.runStep(workspace, request),
    startAgent: async (args) => open(args.stream, await provider.startAgent(args.workspace, args.options)),
    reattach: async (args) => open(args.stream, await provider.reattach(args.containerId)),
    'agent.wait': (args) => stream(args.stream).wait(),
    isRunning: ({ containerId }) => provider.isRunning(containerId),
    stop: ({ containerId, graceSeconds }) => provider.stop(containerId, graceSeconds),
    remove: ({ containerId }) => provider.remove(containerId),
    destroyWorkspace: ({ key }) => provider.destroyWorkspace(key),
    listManaged: async () => {
      const managed = await provider.listManaged()
      return {
        containers: managed.containers.filter((container) => container.stack === options.stack),
        volumes: managed.volumes.filter((volume) => volume.stack === options.stack),
      }
    },
    ensureEnvironment: (args) => provider.ensureEnvironment(args.key, args.options),
    startService: ({ environment, spec }) => provider.startService(environment, spec),
    serviceState: ({ containerId }) => provider.serviceState(containerId),
    joinEnvironment: ({ environment, role, alias }) => provider.joinEnvironment(environment, role, alias),
    attachToEnvironment: ({ key, containerId }) => provider.attachToEnvironment(key, containerId),
    followLogs: async ({ containerId, since, id }) => {
      const controller = new AbortController()
      aborts.set(id, controller)
      try {
        await provider.followLogs(containerId, { since, signal: controller.signal }, (line) => transport.send({ t: 'log', id, line }))
      } finally {
        aborts.delete(id)
      }
    },
    stopEnvironment: ({ key, services }) => provider.stopEnvironment(key, services),
    removeEnvironmentVolumes: (args) => provider.removeEnvironmentVolumes(args.key, args.options),
  }

  const stopListening = transport.onFrame((frame) => {
    if (frame.t === 'call') {
      const handler = handlers[frame.method]
      const { id } = frame
      if (!handler) {
        transport.send({ t: 'result', id, ok: false, error: `This runner does not know ${frame.method}. Update it.` })
        return
      }
      Promise.resolve()
        .then(() => handler(frame.args))
        .then(
          (value) => transport.send({ t: 'result', id, ok: true, value: value ?? null }),
          (error: unknown) => transport.send({ t: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
    } else if (frame.t === 'agent.send') {
      streams.get(frame.stream)?.send(frame.line)
    } else if (frame.t === 'agent.detach') {
      streams.get(frame.stream)?.detach()
      streams.delete(frame.stream)
    } else if (frame.t === 'abort') {
      aborts.get(frame.id)?.abort()
    }
  })

  return () => {
    stopListening()
    for (const handle of streams.values()) handle.detach()
    streams.clear()
    for (const controller of aborts.values()) controller.abort()
    aborts.clear()
  }
}
