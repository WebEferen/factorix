import type { RuntimeId, RuntimeModelCatalog } from '@factorix/runtime'
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
import { runnerOfContainer } from './remote'

export interface SandboxRoutes {
  /** The runner that holds a workspace, or null for this machine. A workspace stays where it was first made. */
  runnerOfWorkspace(key: string): Promise<string | null>
  /** The same for an environment, or undefined when nothing is known about the key. */
  runnerOfEnvironment(key: string): Promise<string | null | undefined>
  provider(runnerId: string): Promise<SandboxProvider>
  /** Runners to include when listing what exists. */
  onlineRunners(): Promise<string[]>
  workspaceDestroyed?(key: string): Promise<void>
}

/**
 * One provider for the worker that sends each call to the machine holding what it names: a workspace and an environment by their keys,
 * a container by the runner its id carries. Everything about one issue stays on one machine, because its volumes are there.
 */
export class RoutingSandboxProvider implements SandboxProvider {
  /** Where an environment was last listed, for keys the database no longer knows. */
  private readonly listedEnvironments = new Map<string, string | null>()

  constructor(
    private readonly local: SandboxProvider,
    private readonly routes: SandboxRoutes,
  ) {}

  private async of(runnerId: string | null): Promise<SandboxProvider> {
    return runnerId ? this.routes.provider(runnerId) : this.local
  }

  private async byWorkspace(key: string): Promise<SandboxProvider> {
    return this.of(await this.routes.runnerOfWorkspace(key))
  }

  private async byEnvironment(key: string): Promise<SandboxProvider> {
    const known = await this.routes.runnerOfEnvironment(key)
    return this.of(known === undefined ? (this.listedEnvironments.get(key) ?? null) : known)
  }

  private byContainer(containerId: string): Promise<SandboxProvider> {
    return this.of(runnerOfContainer(containerId))
  }

  listRuntimeModels(): Promise<Partial<Record<RuntimeId, RuntimeModelCatalog>>> {
    return this.local.listRuntimeModels()
  }

  async ensureWorkspace(key: string): Promise<Workspace> {
    return (await this.byWorkspace(key)).ensureWorkspace(key)
  }

  async runStep(workspace: Workspace, request: StepRequest): Promise<StepResult> {
    return (await this.byWorkspace(workspace.key)).runStep(workspace, request)
  }

  async startAgent(workspace: Workspace, options: StartAgentOptions): Promise<AgentHandle> {
    return (await this.byWorkspace(workspace.key)).startAgent(workspace, options)
  }

  async reattach(containerId: string): Promise<AgentHandle | null> {
    return (await this.byContainer(containerId)).reattach(containerId)
  }

  async isRunning(containerId: string): Promise<boolean> {
    return (await this.byContainer(containerId)).isRunning(containerId)
  }

  async stop(containerId: string, graceSeconds: number): Promise<void> {
    return (await this.byContainer(containerId)).stop(containerId, graceSeconds)
  }

  async remove(containerId: string): Promise<void> {
    return (await this.byContainer(containerId)).remove(containerId)
  }

  async destroyWorkspace(key: string): Promise<void> {
    await (await this.byWorkspace(key)).destroyWorkspace(key)
    await this.routes.workspaceDestroyed?.(key)
  }

  /** A runner that cannot be reached is left out, so cleanup of the others goes on. */
  async listManaged(): Promise<{ containers: ManagedContainer[]; volumes: ManagedVolume[] }> {
    const all = await this.local.listManaged()
    const note = (items: { envKey?: string }[], runnerId: string | null) => {
      for (const item of items) if (item.envKey) this.listedEnvironments.set(item.envKey, runnerId)
    }
    this.listedEnvironments.clear()
    note([...all.containers, ...all.volumes], null)
    for (const runnerId of await this.routes.onlineRunners()) {
      try {
        const managed = await (await this.routes.provider(runnerId)).listManaged()
        note([...managed.containers, ...managed.volumes], runnerId)
        all.containers.push(...managed.containers)
        all.volumes.push(...managed.volumes)
      } catch {}
    }
    return all
  }

  async ensureEnvironment(key: string, options: { internal: boolean; labels: Record<string, string>; sourceVolume?: string }): Promise<Environment> {
    return (await this.byEnvironment(key)).ensureEnvironment(key, options)
  }

  async startService(environment: Environment, spec: ServiceSpec): Promise<string> {
    return (await this.byEnvironment(environment.key)).startService(environment, spec)
  }

  async serviceState(containerId: string): Promise<{ state: ServiceState; exitCode?: number }> {
    return (await this.byContainer(containerId)).serviceState(containerId)
  }

  async joinEnvironment(environment: Environment, role: 'gateway' | 'egress', alias: string): Promise<boolean> {
    return (await this.byEnvironment(environment.key)).joinEnvironment(environment, role, alias)
  }

  async attachToEnvironment(key: string, containerId: string): Promise<boolean> {
    return (await this.byContainer(containerId)).attachToEnvironment(key, containerId)
  }

  async followLogs(containerId: string, options: { since?: number; signal: AbortSignal }, onLine: (line: LogLine) => void): Promise<void> {
    return (await this.byContainer(containerId)).followLogs(containerId, options, onLine)
  }

  async stopEnvironment(key: string, services?: string[]): Promise<void> {
    return (await this.byEnvironment(key)).stopEnvironment(key, services)
  }

  async removeEnvironmentVolumes(key: string, options: { source: boolean }): Promise<void> {
    return (await this.byEnvironment(key)).removeEnvironmentVolumes(key, options)
  }
}
