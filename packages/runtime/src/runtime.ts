import type { RuntimeCapabilities } from './capabilities'
import type { RunCommand } from './commands'
import type { RunEventBody } from './events'
import type { ReasoningEffort, RunSpec, RuntimeId } from './spec'

export interface ApprovalRequest {
  kind: 'tool' | 'plan' | 'question'
  tool?: string
  input?: unknown
  summary: string
  options?: string[]
}

export interface ApprovalDecision {
  decision: 'approve' | 'reject'
  updatedInput?: unknown
  message?: string
}

export interface RunControl {
  signal: AbortSignal
  /** Follow-up user messages, delivered in order. Ends when the run is cancelled or finished. */
  messages: AsyncIterable<Extract<RunCommand, { type: 'message' }>>
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
}

export interface RunnerIO {
  workspaceDir: string
  homeDir: string
  factorixDir: string
}

export interface RuntimeModel {
  id: string
  label: string
  description: string | null
  efforts: ReasoningEffort[]
}

export interface RuntimeModelCatalog {
  /** What runs when an agent pins no model, when the SDK says so. */
  defaultModel: string | null
  models: RuntimeModel[]
}

export interface AgentRuntime {
  readonly id: RuntimeId
  listModels(io: RunnerIO): Promise<RuntimeModelCatalog>
  capabilities(): RuntimeCapabilities
  prepare(spec: RunSpec, io: RunnerIO): Promise<void>
  run(spec: RunSpec, control: RunControl, io: RunnerIO): AsyncIterable<RunEventBody>
}
