import { type Db, json } from '@factorix/db'
import type { RunEvent, RunEventBody } from '@factorix/runtime'
import type { Redis } from 'ioredis'
import { runChannel } from '../lib/channels'

const FLUSH_INTERVAL_MS = 250
const FLUSH_SIZE = 50

/**
 * The single writer of a run's event log. Sequence numbers are assigned here, not by the runner, so
 * worker-origin events (step output, proxy denials) share one ordering with what the agent did.
 * Events reach Redis only after the database flush, so a live viewer never sees a row a replay would miss.
 */
export class EventBuffer {
  private pending: RunEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private flushing: Promise<void> = Promise.resolve()
  private seq: number
  private runnerSeq: number

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly runId: string,
    startSeq: number,
    startRunnerSeq: number,
  ) {
    this.seq = startSeq
    this.runnerSeq = startRunnerSeq
  }

  get lastRunnerSeq(): number {
    return this.runnerSeq
  }

  /** Returns false when this runner event was already recorded, which happens on every reattach replay. */
  acceptRunnerSeq(seq: number): boolean {
    if (seq <= this.runnerSeq) return false
    this.runnerSeq = seq
    return true
  }

  append(body: RunEventBody): RunEvent {
    const event = { ...body, seq: ++this.seq, ts: new Date().toISOString(), runId: this.runId } as RunEvent
    this.pending.push(event)
    if (this.pending.length >= FLUSH_SIZE) void this.flush()
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS)
    return event
  }

  publishPartial(event: RunEvent): void {
    void this.redis.publish(runChannel(this.runId), JSON.stringify({ kind: 'event', event }))
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flushing = this.flushing.then(() => this.write())
    return this.flushing
  }

  private async write(): Promise<void> {
    const batch = this.pending
    const runnerSeq = this.runnerSeq
    if (batch.length === 0) {
      await this.db('runs').where({ id: this.runId }).andWhere('last_runner_seq', '<', runnerSeq).update({ lastRunnerSeq: runnerSeq })
      return
    }
    this.pending = []
    const rows = batch.map((event) => {
      const { seq, ts, runId, ...payload } = event
      return { runId, seq, type: event.type, ts, payload: json(payload) }
    })
    await this.db.transaction(async (trx) => {
      await trx('run_events').insert(rows).onConflict(['run_id', 'seq']).ignore()
      await trx('runs')
        .where({ id: this.runId })
        .update({ lastSeq: batch.at(-1)?.seq, lastRunnerSeq: runnerSeq, updatedAt: trx.fn.now() })
    })
    const pipeline = this.redis.pipeline()
    for (const event of batch) pipeline.publish(runChannel(this.runId), JSON.stringify({ kind: 'event', event }))
    await pipeline.exec()
  }
}
