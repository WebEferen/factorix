import type { RuntimeId, RuntimeModelCatalog } from '@factorix/runtime'

export type StepOp = 'mirror-fetch' | 'checkout' | 'bundle' | 'push' | 'diff' | 'docs'

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
}

export interface ManagedVolume {
  name: string
  workspaceKey: string
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
}
