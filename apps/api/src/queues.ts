import { Queue, type QueueOptions } from 'bullmq'
import type { Redis } from 'ioredis'

export const QUEUE_NAMES = {
  runsExecute: 'runs-execute',
  pipelineAdvance: 'pipeline-advance',
  trackerInbound: 'tracker-inbound',
  scmInbound: 'scm-inbound',
  trackerOutbound: 'tracker-outbound',
  scmAction: 'scm-action',
  maintenance: 'maintenance',
  projectSync: 'project-sync',
  workflows: 'workflows',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

export interface Queues {
  runsExecute: Queue
  pipelineAdvance: Queue
  trackerInbound: Queue
  scmInbound: Queue
  trackerOutbound: Queue
  scmAction: Queue
  maintenance: Queue
  projectSync: Queue
  workflows: Queue
  close(): Promise<void>
}

export function createQueues(connection: Redis, prefix?: string): Queues {
  const options: QueueOptions = {
    connection,
    prefix,
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    },
  }
  const make = (name: QueueName) => new Queue(name, options)
  const queues = {
    runsExecute: new Queue(QUEUE_NAMES.runsExecute, {
      ...options,
      defaultJobOptions: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 }, attempts: 1 },
    }),
    pipelineAdvance: make(QUEUE_NAMES.pipelineAdvance),
    trackerInbound: make(QUEUE_NAMES.trackerInbound),
    scmInbound: make(QUEUE_NAMES.scmInbound),
    trackerOutbound: make(QUEUE_NAMES.trackerOutbound),
    scmAction: make(QUEUE_NAMES.scmAction),
    maintenance: make(QUEUE_NAMES.maintenance),
    projectSync: make(QUEUE_NAMES.projectSync),
    workflows: make(QUEUE_NAMES.workflows),
  }
  return {
    ...queues,
    async close() {
      await Promise.all(Object.values(queues).map((queue) => queue.close()))
    },
  }
}
