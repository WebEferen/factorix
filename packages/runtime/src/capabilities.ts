import type { RuntimeId } from './spec'

export interface RuntimeCapabilities {
  toolApproval: 'per_call' | 'none'
  /** `enforced` means deny rules are applied by the harness, `advisory` means they only steer the prompt. */
  toolPolicy: 'enforced' | 'advisory'
  planMode: 'emulated'
  midRunMessages: boolean
  costReporting: 'usd' | 'tokens'
  fileChangeEvents: 'native' | 'derived'
  partialStreaming: boolean
  sessionResume: boolean
  structuredOutput: boolean
  subagents: boolean
  questionsToHuman: boolean
  budgetLimit: 'native' | 'emulated'
  maxTurns: 'native' | 'emulated'
  mcp: { stdio: boolean; http: boolean }
}

export const RUNTIME_CAPABILITIES: Record<RuntimeId, RuntimeCapabilities> = {
  claude: {
    toolApproval: 'per_call',
    toolPolicy: 'enforced',
    planMode: 'emulated',
    midRunMessages: true,
    costReporting: 'usd',
    fileChangeEvents: 'derived',
    partialStreaming: true,
    sessionResume: true,
    structuredOutput: true,
    subagents: true,
    questionsToHuman: true,
    budgetLimit: 'native',
    maxTurns: 'native',
    mcp: { stdio: true, http: true },
  },
  codex: {
    toolApproval: 'none',
    toolPolicy: 'advisory',
    planMode: 'emulated',
    midRunMessages: false,
    costReporting: 'tokens',
    fileChangeEvents: 'native',
    partialStreaming: false,
    sessionResume: true,
    structuredOutput: true,
    subagents: false,
    questionsToHuman: false,
    budgetLimit: 'emulated',
    maxTurns: 'emulated',
    mcp: { stdio: true, http: true },
  },
  scripted: {
    toolApproval: 'per_call',
    toolPolicy: 'advisory',
    planMode: 'emulated',
    midRunMessages: true,
    costReporting: 'usd',
    fileChangeEvents: 'native',
    partialStreaming: false,
    sessionResume: true,
    structuredOutput: true,
    subagents: false,
    questionsToHuman: true,
    budgetLimit: 'emulated',
    maxTurns: 'emulated',
    mcp: { stdio: false, http: false },
  },
}
