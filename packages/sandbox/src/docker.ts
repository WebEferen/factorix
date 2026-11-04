import { existsSync } from 'node:fs'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { AsyncQueue, LineSplitter, type RuntimeId, type RuntimeModelCatalog } from '@factorix/runtime'
import Docker, { type ContainerCreateOptions } from 'dockerode'
import { agentContainerConfig, type ContainerDefaults, catalogContainerConfig, parseStepValues, stepContainerConfig } from './profiles'
import type { AgentHandle, ManagedContainer, SandboxProvider, StartAgentOptions, StepRequest, StepResult, Workspace } from './provider'

const STEP_OUTPUT_LIMIT = 16 * 1024 * 1024
const DEFAULT_STEP_TIMEOUT_SECONDS = 600

export function dockerClientFromEnv(): Docker {
  if (process.env.DOCKER_HOST) return new Docker()
  const candidates = [process.env.DOCKER_SOCKET_PATH, '/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock')]
  const socketPath = candidates.find((path): path is string => Boolean(path) && existsSync(path as string))
  return socketPath ? new Docker({ socketPath }) : new Docker()
}

class CappedBuffer {
  private chunks: Buffer[] = []
  private size = 0

  append(chunk: Buffer): void {
    if (this.size >= STEP_OUTPUT_LIMIT) return
    const slice = chunk.subarray(0, STEP_OUTPUT_LIMIT - this.size)
    this.chunks.push(slice)
    this.size += slice.length
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

class DockerAgentHandle implements AgentHandle {
  private readonly queue = new AsyncQueue<string>()
  private readonly stderrListeners = new Set<(line: string) => void>()
  private readonly stderrSplitter = new LineSplitter()
  private readonly stdoutSplitter = new LineSplitter()
  private detached = false

  constructor(
    private readonly container: Docker.Container,
    private readonly stream: NodeJS.ReadWriteStream,
    modem: Docker['modem'],
  ) {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    modem.demuxStream(stream, stdout, stderr)
    stdout.on('data', (chunk: Buffer) => {
      for (const line of this.stdoutSplitter.push(chunk.toString('utf8'))) this.queue.push(line)
    })
    stderr.on('data', (chunk: Buffer) => {
      for (const line of this.stderrSplitter.push(chunk.toString('utf8'))) for (const listener of this.stderrListeners) listener(line)
    })
    const finish = () => {
      const rest = this.stdoutSplitter.flush()
      if (rest) this.queue.push(rest)
      this.queue.close()
    }
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', finish)
  }

  get containerId(): string {
    return this.container.id
  }

  get lines(): AsyncIterable<string> {
    return this.queue
  }

  send(line: string): void {
    if (!this.detached) this.stream.write(line.endsWith('\n') ? line : `${line}\n`)
  }

  onStderr(listener: (line: string) => void): void {
    this.stderrListeners.add(listener)
  }

  async wait(): Promise<{ exitCode: number }> {
    const result = (await this.container.wait()) as { StatusCode: number }
    return { exitCode: result.StatusCode }
  }

  detach(): void {
    this.detached = true
    this.queue.close()
    ;(this.stream as unknown as { destroy?: () => void }).destroy?.()
  }
}

class ExitedAgentHandle implements AgentHandle {
  private readonly queue = new AsyncQueue<string>()
  private readonly stdoutSplitter = new LineSplitter()

  constructor(
    private readonly container: Docker.Container,
    stream: NodeJS.ReadableStream,
    modem: Docker['modem'],
  ) {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    modem.demuxStream(stream, stdout, stderr)
    stdout.on('data', (chunk: Buffer) => {
      for (const line of this.stdoutSplitter.push(chunk.toString('utf8'))) this.queue.push(line)
    })
    stream.on('end', () => {
      const rest = this.stdoutSplitter.flush()
      if (rest) this.queue.push(rest)
      this.queue.close()
    })
  }

  get containerId(): string {
    return this.container.id
  }

  get lines(): AsyncIterable<string> {
    return this.queue
  }

  send(): void {}

  onStderr(): void {}

  async wait(): Promise<{ exitCode: number }> {
    const info = await this.container.inspect()
    return { exitCode: info.State.ExitCode }
  }

  detach(): void {
    this.queue.close()
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 404
}

/**
 * Not container.attach(): docker-modem sends POST options as a JSON body, and on a hijacked attach that
 * body can race the upgrade and land on the container's stdin ahead of the run spec.
 */
async function attachWithStdin(docker: Docker, containerId: string, query: Record<string, string>): Promise<NodeJS.ReadWriteStream> {
  const modem = docker.modem as unknown as {
    socketPath?: string | (() => string | Promise<string>)
    host?: string
    port?: number | string
    protocol?: string
    ca?: string
    cert?: string
    key?: string
  }
  const socketPath = typeof modem.socketPath === 'function' ? await modem.socketPath() : modem.socketPath
  const transport = modem.protocol === 'https' ? httpsRequest : httpRequest
  const options: RequestOptions & Pick<HttpsRequestOptions, 'ca' | 'cert' | 'key'> = {
    method: 'POST',
    path: `/containers/${encodeURIComponent(containerId)}/attach?${new URLSearchParams({ stream: '1', stdin: '1', stdout: '1', stderr: '1', ...query })}`,
    headers: { Connection: 'Upgrade', Upgrade: 'tcp', 'Content-Length': '0' },
    ...(socketPath ? { socketPath } : { host: modem.host, port: modem.port, ca: modem.ca, cert: modem.cert, key: modem.key }),
  }
  return new Promise((resolve, reject) => {
    const request = transport(options)
    request.on('upgrade', (_response, socket, head) => {
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    request.on('response', (response) => {
      response.resume()
      reject(new Error(`Attaching to container ${containerId} returned ${response.statusCode}`))
    })
    request.on('error', reject)
    request.end()
  })
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly docker: Docker

  constructor(
    private readonly defaults: ContainerDefaults,
    docker?: Docker,
  ) {
    this.docker = docker ?? dockerClientFromEnv()
  }

  async ensureWorkspace(key: string): Promise<Workspace> {
    const workspace: Workspace = { key, volume: `fx-ws-${key}`, mirrorVolume: `fx-mirror-${key}` }
    const Labels = { 'factorix.managed': 'true', 'factorix.workspace': key }
    await this.docker.createVolume({ Name: workspace.volume, Labels })
    await this.docker.createVolume({ Name: workspace.mirrorVolume, Labels })
    return workspace
  }

  async runStep(workspace: Workspace, request: StepRequest): Promise<StepResult> {
    const startedAt = Date.now()
    const result = await this.runToExit(
      stepContainerConfig(workspace, request, this.defaults),
      request.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS,
    )
    return {
      op: request.op,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      values: request.op === 'diff' || request.op === 'docs' ? {} : parseStepValues(result.stdout),
      timedOut: result.timedOut,
      durationMs: Date.now() - startedAt,
    }
  }

  async listRuntimeModels(): Promise<Partial<Record<RuntimeId, RuntimeModelCatalog>>> {
    const result = await this.runToExit(catalogContainerConfig(this.defaults), 120)
    if (result.exitCode !== 0) throw new Error(`Listing models exited with ${result.exitCode}: ${result.stderr.slice(-500)}`)
    return JSON.parse(result.stdout) as Partial<Record<RuntimeId, RuntimeModelCatalog>>
  }

  private async runToExit(config: ContainerCreateOptions, timeoutSeconds: number) {
    const container = await this.docker.createContainer(config)
    const stdoutBuffer = new CappedBuffer()
    const stderrBuffer = new CappedBuffer()
    const stream = await container.attach({ stream: true, stdout: true, stderr: true })
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    this.docker.modem.demuxStream(stream, stdout, stderr)
    stdout.on('data', (chunk: Buffer) => stdoutBuffer.append(chunk))
    stderr.on('data', (chunk: Buffer) => stderrBuffer.append(chunk))
    const drained = new Promise<void>((resolve) => {
      stream.on('end', () => resolve())
      stream.on('close', () => resolve())
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      container.kill().catch(() => {})
    }, timeoutSeconds * 1000)
    try {
      await container.start()
      const { StatusCode } = (await container.wait()) as { StatusCode: number }
      await drained
      return { exitCode: StatusCode, stdout: stdoutBuffer.toString(), stderr: stderrBuffer.toString(), timedOut }
    } finally {
      clearTimeout(timer)
      await container.remove({ force: true }).catch(() => {})
    }
  }

  async startAgent(workspace: Workspace, options: StartAgentOptions): Promise<AgentHandle> {
    const container = await this.docker.createContainer(agentContainerConfig(workspace, options, this.defaults))
    const stream = await attachWithStdin(this.docker, container.id, {})
    const handle = new DockerAgentHandle(container, stream, this.docker.modem)
    await container.start()
    return handle
  }

  async reattach(containerId: string): Promise<AgentHandle | null> {
    const container = this.docker.getContainer(containerId)
    try {
      const info = await container.inspect()
      if (info.State.Running) {
        const stream = await attachWithStdin(this.docker, containerId, { logs: '1' })
        return new DockerAgentHandle(container, stream, this.docker.modem)
      }
      const stream = (await container.logs({ follow: true, stdout: true, stderr: true })) as unknown as NodeJS.ReadableStream
      return new ExitedAgentHandle(container, stream, this.docker.modem)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async isRunning(containerId: string): Promise<boolean> {
    try {
      return (await this.docker.getContainer(containerId).inspect()).State.Running
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  async stop(containerId: string, graceSeconds: number): Promise<void> {
    await this.docker
      .getContainer(containerId)
      .stop({ t: graceSeconds })
      .catch((error: { statusCode?: number }) => {
        if (error.statusCode !== 304 && error.statusCode !== 404) throw error
      })
  }

  async remove(containerId: string): Promise<void> {
    await this.docker
      .getContainer(containerId)
      .remove({ force: true })
      .catch((error) => {
        if (!isNotFound(error)) throw error
      })
  }

  async destroyWorkspace(key: string): Promise<void> {
    for (const name of [`fx-ws-${key}`, `fx-mirror-${key}`]) {
      await this.docker
        .getVolume(name)
        .remove({ force: true })
        .catch((error) => {
          if (!isNotFound(error)) throw error
        })
    }
  }

  async listManaged(): Promise<{ containers: ManagedContainer[]; volumes: { name: string; workspaceKey: string }[] }> {
    const filters = JSON.stringify({ label: ['factorix.managed=true'] })
    const [containers, volumes] = await Promise.all([this.docker.listContainers({ all: true, filters }), this.docker.listVolumes({ filters })])
    return {
      containers: containers.map((container) => ({
        id: container.Id,
        kind: container.Labels['factorix.kind'] ?? 'unknown',
        running: container.State === 'running',
        createdAt: new Date(container.Created * 1000),
        runId: container.Labels['factorix.run'],
        issueKey: container.Labels['factorix.issue'],
      })),
      volumes: (volumes.Volumes ?? []).map((volume) => ({ name: volume.Name, workspaceKey: volume.Labels?.['factorix.workspace'] ?? '' })),
    }
  }
}
