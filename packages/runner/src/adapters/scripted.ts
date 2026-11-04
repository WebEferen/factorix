import { exec } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  type AgentRuntime,
  EMPTY_USAGE,
  RUNTIME_CAPABILITIES,
  type RunControl,
  type RunEventBody,
  type RunnerIO,
  type RunSpec,
  type UsageSnapshot,
} from '@factorix/runtime'
import { truncateOutput } from '../truncate'

const execAsync = promisify(exec)

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done()
    const timer = setTimeout(done, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        done()
      },
      { once: true },
    )
  })
}

/** Deterministic stand-in for a model, so the sandbox, pipeline, and UI can run without an API key. */
export class ScriptedRuntime implements AgentRuntime {
  readonly id = 'scripted' as const

  async listModels() {
    return { defaultModel: null, models: [] }
  }

  capabilities() {
    return RUNTIME_CAPABILITIES.scripted
  }

  async prepare(): Promise<void> {}

  async *run(spec: RunSpec, control: RunControl, _io: RunnerIO): AsyncIterable<RunEventBody> {
    const sessionRef = spec.resume?.sessionRef ?? spec.runId
    const plan = spec.scripted ?? { steps: [{ say: 'No script was provided.' }] }
    const usage: UsageSnapshot = { ...EMPTY_USAGE, inputTokens: 100, outputTokens: 50, turns: 1, costUsd: 0 }
    yield { type: 'run.started', sessionRef, runtime: 'scripted', model: spec.model.name ?? 'scripted', tools: ['Bash', 'Write'], mcpServers: [] }

    const nudges: string[] = []
    const forward = (async () => {
      for await (const message of control.messages) nudges.push(message.text)
    })()

    let index = 0
    for (const step of plan.steps) {
      if (control.signal.aborted) break
      index += 1
      if (step.sleepMs) await sleep(step.sleepMs, control.signal)
      if (control.signal.aborted) break
      while (nudges.length > 0) yield { type: 'message', role: 'user', text: nudges.shift() as string, messageId: `nudge-${index}` }
      if (step.say) yield { type: 'message', role: 'assistant', text: step.say, messageId: `m-${index}` }
      if (step.writeFile) {
        const path = resolve(spec.cwd, step.writeFile.path)
        const callId = `write-${index}`
        yield { type: 'tool.call', callId, tool: 'Write', category: 'edit', input: { file_path: path }, summary: `Write ${step.writeFile.path}` }
        try {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, step.writeFile.content)
          yield { type: 'tool.result', callId, output: 'ok', isError: false }
          yield { type: 'file.change', path, kind: 'add', callId }
        } catch (error) {
          yield { type: 'tool.result', callId, output: String(error), isError: true }
        }
      }
      if (step.exec) {
        const callId = `exec-${index}`
        yield { type: 'tool.call', callId, tool: 'Bash', category: 'exec', input: { command: step.exec }, summary: `Bash ${step.exec}`.slice(0, 200) }
        try {
          const { stdout, stderr } = await execAsync(step.exec, { cwd: spec.cwd, env: process.env, signal: control.signal })
          yield { type: 'tool.result', callId, isError: false, exitCode: 0, ...truncateOutput(stdout + stderr) }
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string }
          yield {
            type: 'tool.result',
            callId,
            isError: true,
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            ...truncateOutput(`${failure.stdout ?? ''}${failure.stderr ?? failure.message ?? ''}`),
          }
        }
      }
      if (step.askApproval) {
        const decision = await control.requestApproval({ kind: 'tool', tool: step.askApproval.tool, summary: step.askApproval.summary, input: {} })
        yield { type: 'message', role: 'assistant', text: `Approval was ${decision.decision}d`, messageId: `a-${index}` }
      }
    }
    void forward

    if (control.signal.aborted) {
      yield { type: 'done', outcome: 'cancelled', finalText: '', sessionRef, usage }
      return
    }
    yield { type: 'usage', cumulative: true, ...usage }
    if (plan.fail) {
      yield { type: 'error', code: plan.fail.code, message: plan.fail.message, fatal: true }
      yield { type: 'done', outcome: 'failed', finalText: plan.fail.message, sessionRef, usage }
      return
    }
    yield {
      type: 'done',
      outcome: 'completed',
      finalText: `Scripted ${spec.phase} run finished.`,
      structuredOutput: plan.structuredOutput,
      sessionRef,
      usage,
    }
  }
}
