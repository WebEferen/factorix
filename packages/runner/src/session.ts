import { randomUUID } from 'node:crypto'
import {
  type AgentRuntime,
  type ApprovalDecision,
  type ApprovalRequest,
  AsyncQueue,
  type BridgeOp,
  EMPTY_USAGE,
  type RunCommand,
  type RunControl,
  type RunEvent,
  type RunEventBody,
  type RunnerIO,
  type RunSpec,
} from '@factorix/runtime'

export interface SessionOptions {
  spec: RunSpec
  runtime: AgentRuntime
  io: RunnerIO
  emit: (event: RunEvent) => void
  now?: () => string
  onForceExit?: () => void
}

/** A worker that restarts loses the question, so the caller hears back instead of waiting forever. */
const REQUEST_TIMEOUT_MS = 90_000

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Owns everything between the wire protocol and an adapter: sequencing, approvals, cancellation, and the single-`done` guarantee. */
export class RunnerSession {
  private seq: number
  private readonly abort = new AbortController()
  private readonly messages = new AsyncQueue<Extract<RunCommand, { type: 'message' }>>()
  private readonly pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>()
  /** Decisions can arrive before the request on a replay, or twice after a worker restart. */
  private readonly earlyDecisions = new Map<string, ApprovalDecision>()
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private doneEmitted = false
  private forceExitTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: SessionOptions) {
    this.seq = options.spec.startSeq
  }

  private write(body: RunEventBody): void {
    if (this.doneEmitted) return
    if (body.type === 'done') this.doneEmitted = true
    const partial = body.type === 'message' && body.partial === true
    const now = this.options.now?.() ?? new Date().toISOString()
    this.options.emit({ ...body, seq: partial ? 0 : ++this.seq, ts: now, runId: this.options.spec.runId })
  }

  handleCommand(command: RunCommand): void {
    switch (command.type) {
      case 'approval.decide': {
        const decision: ApprovalDecision = { decision: command.decision, updatedInput: command.updatedInput, message: command.message }
        const resolve = this.pendingApprovals.get(command.approvalId)
        if (resolve) {
          this.pendingApprovals.delete(command.approvalId)
          resolve(decision)
        } else {
          this.earlyDecisions.set(command.approvalId, decision)
        }
        return
      }
      case 'message':
        this.messages.push(command)
        return
      case 'cancel':
        this.cancel(command.graceSeconds)
        return
      case 'ping':
        return
      case 'response': {
        const pending = this.pendingRequests.get(command.requestId)
        if (!pending) return
        this.pendingRequests.delete(command.requestId)
        clearTimeout(pending.timer)
        if (command.ok) pending.resolve(command.result)
        else pending.reject(new Error(command.error ?? 'Factorix could not do that.'))
        return
      }
    }
  }

  /** Asks the worker for something only Factorix can do. It answers with a `response` command. */
  request(op: BridgeOp, input: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.abort.signal.aborted || this.doneEmitted) return Promise.reject(new Error('The run is ending.'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('Factorix did not answer in time. Try again in a moment.'))
      }, timeoutMs)
      timer.unref?.()
      this.pendingRequests.set(requestId, { resolve, reject, timer })
      this.write({ type: 'request', requestId, op, input })
    })
  }

  private cancel(graceSeconds: number): void {
    if (this.abort.signal.aborted) return
    this.write({ type: 'status', state: 'cancelling' })
    this.abort.abort()
    for (const [id, resolve] of this.pendingApprovals) {
      this.pendingApprovals.delete(id)
      resolve({ decision: 'reject', message: 'The run was cancelled.' })
    }
    this.messages.close()
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new Error('The run was cancelled.'))
    }
    this.forceExitTimer = setTimeout(() => {
      this.write({ type: 'done', outcome: 'cancelled', finalText: '', sessionRef: this.options.spec.resume?.sessionRef ?? '', usage: EMPTY_USAGE })
      this.options.onForceExit?.()
    }, graceSeconds * 1000)
    this.forceExitTimer.unref?.()
  }

  private control(): RunControl {
    return {
      signal: this.abort.signal,
      messages: this.messages,
      requestApproval: (request: ApprovalRequest) => this.requestApproval(request),
    }
  }

  private requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.abort.signal.aborted) return Promise.resolve({ decision: 'reject', message: 'The run was cancelled.' })
    const approvalId = randomUUID()
    this.write({ type: 'approval.requested', approvalId, ...request })
    this.write({ type: 'status', state: 'waiting_approval' })
    return new Promise((resolve) => {
      const finish = (decision: ApprovalDecision) => {
        this.write({ type: 'approval.resolved', approvalId, decision: decision.decision, by: 'human' })
        this.write({ type: 'status', state: 'running' })
        resolve(decision)
      }
      const early = this.earlyDecisions.get(approvalId)
      if (early) {
        this.earlyDecisions.delete(approvalId)
        finish(early)
      } else {
        this.pendingApprovals.set(approvalId, finish)
      }
    })
  }

  async run(): Promise<void> {
    const { spec, runtime, io } = this.options
    try {
      await runtime.prepare(spec, io)
      this.write({ type: 'status', state: 'running' })
      for await (const event of runtime.run(spec, this.control(), io)) this.write(event)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.write({ type: 'error', code: 'runtime_crash', message, fatal: true })
    } finally {
      if (this.forceExitTimer) clearTimeout(this.forceExitTimer)
      this.messages.close()
    }
    if (!this.doneEmitted) {
      this.write({
        type: 'done',
        outcome: this.abort.signal.aborted ? 'cancelled' : 'failed',
        finalText: '',
        sessionRef: spec.resume?.sessionRef ?? '',
        usage: EMPTY_USAGE,
      })
    }
  }
}
