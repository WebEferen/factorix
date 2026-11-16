import type { AgentRuntime, RunnerIO, RunnerOp, RunSpec } from '@factorix/runtime'

export const MAX_HELPER_TASK_LENGTH = 20_000

/**
 * Answers the delegate tool for a runtime whose SDK has no helpers of its own. A runtime with native helpers gets an
 * empty list here, so the tool is never offered twice.
 */
export function createHelperDesk(spec: RunSpec, runtime: AgentRuntime, io: RunnerIO, signal: AbortSignal) {
  const helpers = runtime.capabilities().helpers === 'delegate' && runtime.runHelper ? (spec.helpers ?? []) : []
  return async (op: RunnerOp, input: unknown): Promise<unknown> => {
    if (op === 'helper.list') return helpers.map(({ name, description }) => ({ name, description }))
    const { helper: name, task } = (input ?? {}) as { helper?: unknown; task?: unknown }
    const helper = helpers.find((candidate) => candidate.name === name)
    if (!helper || !runtime.runHelper) {
      throw new Error(`There is no helper called ${String(name)}. Choose one of: ${helpers.map((candidate) => candidate.name).join(', ') || 'none'}.`)
    }
    if (typeof task !== 'string' || !task.trim()) throw new Error('Say what the helper should do in task.')
    if (signal.aborted) throw new Error('The run is ending.')
    return runtime.runHelper(spec, helper, task.slice(0, MAX_HELPER_TASK_LENGTH), signal, io)
  }
}
