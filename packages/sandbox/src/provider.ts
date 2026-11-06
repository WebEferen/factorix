import type { RuntimeId, RuntimeModelCatalog } from '@factorix/runtime'

export type StepOp = 'mirror-fetch' | 'checkout' | 'bundle' | 'push' | 'diff' | 'docs' | 'clear-cache' | 'export'

export interface Workspace {
  key: string
  volume: string
  mirrorVolume: string
}

export interface StepRequest {
  op: StepOp
  env?: Record<string, string>
  /** Only token-holding ops may receive this. The provider throws otherwise. */
  gitToken?: string
  timeoutSeconds?: number
  labels?: Record<string, string>
  /** Mounted read-only at /source for ops whose profile allows it. The provider throws otherwise. */
  sourceVolume?: string
}

export interface StepResult {
  op: StepOp
  exitCode: number
  stdout: string
  stderr: string
  values: Record<string, string>
  timedOut: boolean
  durationMs: number
}

export interface ResourceLimits {
  memoryBytes: number
  cpus: number
  pids: number
}

export interface StartAgentOptions {
  runId: string
  issueKey: string
  readOnlyRepo: boolean
  env?: Record<string, string>
  image?: string
  limits?: Partial<ResourceLimits>
  /** Joined before the agent starts, such as the network of the services its run gets. */
  networks?: string[]
}

export interface AgentHandle {
  readonly containerId: string
  /** Complete stdout lines. Ends when the container's stdout closes. */
  readonly lines: AsyncIterable<string>
  send(line: string): void
  onStderr(listener: (line: string) => void): void
  wait(): Promise<{ exitCode: number }>
  /** Stops listening without touching the container, so another worker can reattach. */
  detach(): void
}

export interface ManagedContainer {
  id: string
  kind: string
  running: boolean
  createdAt: Date
  runId?: string
  issueKey?: string
  envKey?: string
  stack?: string
}

export interface ManagedVolume {
  name: string
  workspaceKey: string
  envKey?: string
  stack?: string
}

/** A preview's private network and the volume its repository services run from. Data volumes are per service. */
export interface Environment {
  key: string
  network: string
  sourceVolume: string
}

export interface ServiceMount {
  volume: string
  target: string
  readOnly: boolean
  /** A folder inside the volume, which must exist. */
  subpath?: string
}

export interface ServiceSpec {
  service: string
  /** Defaults to the sandbox image. */
  image?: string
  /** Repository code runs as uid 1000 with no capabilities. An image keeps its own user and gets the few it needs to start. */
  repoCode: boolean
  /** A shell script. Without one the image's own command runs. */
  script?: string
  workdir?: string
  env: Record<string, string>
  mounts: ServiceMount[]
  /** A shell command that exits 0 once the service is ready. */
  healthcheck?: string
  limits?: Partial<ResourceLimits>
  labels?: Record<string, string>
  /** More names the service answers to on its network, besides its own. */
  aliases?: string[]
}

export type ServiceState = 'starting' | 'healthy' | 'unhealthy' | 'running' | 'exited' | 'missing'

export interface LogLine {
  ts: number
  stream: 'stdout' | 'stderr'
  text: string
}

export interface SandboxProvider {
  listRuntimeModels(): Promise<Partial<Record<RuntimeId, RuntimeModelCatalog>>>
  ensureWorkspace(key: string): Promise<Workspace>
  runStep(workspace: Workspace, request: StepRequest): Promise<StepResult>
  startAgent(workspace: Workspace, options: StartAgentOptions): Promise<AgentHandle>
  /** Returns null when the container no longer exists. */
  reattach(containerId: string): Promise<AgentHandle | null>
  isRunning(containerId: string): Promise<boolean>
  stop(containerId: string, graceSeconds: number): Promise<void>
  remove(containerId: string): Promise<void>
  destroyWorkspace(key: string): Promise<void>
  listManaged(): Promise<{ containers: ManagedContainer[]; volumes: ManagedVolume[] }>
  /**
   * Creates the network and source volume if they are missing. `internal` cuts the network off from everything but the egress proxy.
   * `sourceVolume` uses an existing volume instead, such as a run's workspace, which the environment then never removes.
   */
  ensureEnvironment(key: string, options: { internal: boolean; labels: Record<string, string>; sourceVolume?: string }): Promise<Environment>
  /** Replaces any container left from an earlier start of the same service. */
  startService(environment: Environment, spec: ServiceSpec): Promise<string>
  serviceState(containerId: string): Promise<{ state: ServiceState; exitCode?: number }>
  /** Connects a running platform container, found by its `factorix.role` label, under `alias`. False when there is none. */
  joinEnvironment(environment: Environment, role: 'gateway' | 'egress', alias: string): Promise<boolean>
  /** Connects a running agent's container to an environment's network. False when the network is gone. */
  attachToEnvironment(key: string, containerId: string): Promise<boolean>
  /** Follows a container's output until it stops or `signal` aborts. */
  followLogs(containerId: string, options: { since?: number; signal: AbortSignal }, onLine: (line: LogLine) => void): Promise<void>
  /** Removes the services and the network. Volumes stay for the next start. */
  stopEnvironment(key: string, services?: string[]): Promise<void>
  /** Deletes data volumes, and with `source` the source volume too. Stop the environment first. */
  removeEnvironmentVolumes(key: string, options: { source: boolean }): Promise<void>
}
