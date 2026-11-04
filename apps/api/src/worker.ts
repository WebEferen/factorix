import { gitlabWebhookCodec, linearWebhookCodec } from '@factorix/connectors'
import type { PipelineEvent, TrackerStateKey } from '@factorix/core'
import { createDb } from '@factorix/db'
import { DockerSandboxProvider } from '@factorix/sandbox'
import { type Job, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { type AppDeps, realConnectors } from './deps'
import { loadEnv } from './env'
import { createSecretBox } from './lib/crypto'
import { createQueues, QUEUE_NAMES } from './queues'
import { abandonActiveRuns, executeRun, newWorkerId, releaseActiveRuns } from './services/executor'
import { reapSandboxes, recoverRuns, resumeStaleImports, syncAllProjects } from './services/maintenance'
import { advanceIssue } from './services/pipeline'
import { relayDomainEvents } from './services/relay'
import { refreshRuntimeModels } from './services/runtime-models'
import { checkCi, handleScmEvent, mergeIssue, settleCi } from './services/scm-inbound'
import { handleTrackerEvent, importProject, postTrackerComment, setTrackerState } from './services/tracker-sync'
import { advanceWorkflowRun, executeWorkflowStep, handleWorkflowEvent, sweepWorkflows } from './services/workflows'

const RELAY_INTERVAL_MS = 500
const RECOVERY_INTERVAL_MS = 30_000
const WORKFLOW_SWEEP_INTERVAL_MS = 15_000
const REAP_INTERVAL_MS = 15 * 60_000

export interface WorkerHandle {
  close(): Promise<void>
  /** Test hook that imitates a crash: stops everything without releasing leases or detaching cleanly. */
  crash(): Promise<void>
}

export function startWorkers(
  deps: AppDeps & { sandbox: NonNullable<AppDeps['sandbox']> },
  options: { prefix?: string; log?: (message: string) => void } = {},
): WorkerHandle {
  const log = options.log ?? ((message: string) => console.error(`[worker] ${message}`))
  const owner = newWorkerId()
  const blocking = deps.redis.duplicate({ maxRetriesPerRequest: null })
  const subscriber = deps.redis.duplicate({ maxRetriesPerRequest: null })
  subscriber.setMaxListeners(0)
  const base = { connection: blocking, prefix: options.prefix }

  const fail = (name: string) => (job: Job | undefined, error: Error) => log(`${name} job ${job?.id} failed: ${error.message}`)

  const workers = [
    new Worker(QUEUE_NAMES.runsExecute, async (job) => executeRun({ ...deps, sandbox: deps.sandbox, owner, subscriber }, job.data.runId), {
      ...base,
      concurrency: deps.env.FACTORIX_RUN_CONCURRENCY,
      lockDuration: 60_000,
      maxStalledCount: 0,
    }),
    new Worker(
      QUEUE_NAMES.pipelineAdvance,
      async (job) => {
        await advanceIssue(deps.db, job.data.issueId, job.data.event as PipelineEvent)
      },
      { ...base, concurrency: 5 },
    ),
    new Worker(
      QUEUE_NAMES.trackerInbound,
      async (job) => {
        const status = await handleTrackerEvent(deps, job.data.connectionId, linearWebhookCodec.parse(job.data.payload))
        if (job.data.deliveryId)
          await deps.db('webhook_deliveries').where({ id: job.data.deliveryId }).update({ status, processedAt: deps.db.fn.now() })
      },
      { ...base, concurrency: 5 },
    ),
    new Worker(
      QUEUE_NAMES.scmInbound,
      async (job) => {
        const status = await handleScmEvent(deps, job.data.connectionId, gitlabWebhookCodec.parse(job.data.headers, job.data.payload))
        if (job.data.deliveryId)
          await deps.db('webhook_deliveries').where({ id: job.data.deliveryId }).update({ status, processedAt: deps.db.fn.now() })
      },
      { ...base, concurrency: 5 },
    ),
    new Worker(
      QUEUE_NAMES.trackerOutbound,
      async (job) => {
        if (job.name === 'set-state') await setTrackerState(deps, job.data as { issueId: string; key: TrackerStateKey })
        else await postTrackerComment(deps, job.data)
      },
      { ...base, concurrency: 2 },
    ),
    new Worker(
      QUEUE_NAMES.scmAction,
      async (job) => {
        if (job.name === 'ci-check') await checkCi(deps, job.data.issueId)
        else if (job.name === 'ci-timeout') await settleCi(deps, job.data.issueId)
        else if (job.name === 'merge') await mergeIssue(deps, job.data.issueId)
      },
      { ...base, concurrency: 2 },
    ),
    new Worker(
      QUEUE_NAMES.projectSync,
      async (job) => {
        await importProject(deps, job.data.projectId, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) })
      },
      { ...base, concurrency: 2 },
    ),
    new Worker(
      QUEUE_NAMES.workflows,
      async (job) => {
        if (job.name === 'event') await handleWorkflowEvent(deps, job.data)
        else if (job.name === 'advance') await advanceWorkflowRun(deps.db, job.data.runId)
        else if (job.name === 'step') await executeWorkflowStep(deps, job.data.runId, job.data.nodeId)
      },
      { ...base, concurrency: 5 },
    ),
    new Worker(
      QUEUE_NAMES.maintenance,
      async (job) => {
        if (job.name === 'sync') await syncAllProjects(deps, log)
        else if (job.name === 'reap') await reapSandboxes(deps)
      },
      { ...base, concurrency: 1 },
    ),
  ]
  for (const worker of workers) worker.on('failed', fail(worker.name))

  let relaying = false
  const relayTimer = setInterval(() => {
    if (relaying) return
    relaying = true
    relayDomainEvents(deps)
      .catch((error: Error) => log(`relay failed: ${error.message}`))
      .finally(() => {
        relaying = false
      })
  }, RELAY_INTERVAL_MS)
  const recoveryTimer = setInterval(
    () => void recoverRuns(deps).catch((error: Error) => log(`recovery failed: ${error.message}`)),
    deps.timings?.recoveryMs ?? RECOVERY_INTERVAL_MS,
  )
  void recoverRuns(deps).catch((error: Error) => log(`recovery failed: ${error.message}`))
  void resumeStaleImports(deps).catch((error: Error) => log(`import recovery failed: ${error.message}`))
  void refreshRuntimeModels(deps).catch((error: Error) => log(`could not list runtime models: ${error.message}`))
  const syncTimer = setInterval(
    () => void deps.queues.maintenance.add('sync', {}, { jobId: `sync-${Math.floor(Date.now() / 60_000)}` }),
    deps.env.FACTORIX_SYNC_INTERVAL_SECONDS * 1000,
  )
  const reapTimer = setInterval(
    () => void deps.queues.maintenance.add('reap', {}, { jobId: `reap-${Math.floor(Date.now() / 60_000)}` }),
    REAP_INTERVAL_MS,
  )

  const workflowTimer = setInterval(
    () => void sweepWorkflows(deps).catch((error: Error) => log(`workflow sweep failed: ${error.message}`)),
    deps.timings?.workflowSweepMs ?? WORKFLOW_SWEEP_INTERVAL_MS,
  )

  const stopTimers = () => {
    clearInterval(workflowTimer)
    clearInterval(relayTimer)
    clearInterval(recoveryTimer)
    clearInterval(syncTimer)
    clearInterval(reapTimer)
  }
  return {
    async close() {
      stopTimers()
      await releaseActiveRuns()
      await Promise.all(workers.map((worker) => worker.close()))
      subscriber.disconnect()
      blocking.disconnect()
    },
    async crash() {
      stopTimers()
      await abandonActiveRuns()
      await Promise.all(workers.map((worker) => worker.close(true)))
      subscriber.disconnect()
      blocking.disconnect()
    },
  }
}

async function main(): Promise<void> {
  const env = loadEnv()
  const db = createDb(env.DATABASE_URL, { max: 20 })
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  const queues = createQueues(redis)
  const sandbox = new DockerSandboxProvider({
    image: env.FACTORIX_SANDBOX_IMAGE,
    stepNetwork: env.FACTORIX_STEP_NETWORK,
    agentNetwork: env.FACTORIX_AGENT_NETWORK,
  })
  const deps = { db, redis, env, secrets: createSecretBox(env.FACTORIX_SECRET_KEY), connectors: realConnectors, queues, sandbox }
  const handle = startWorkers(deps)
  console.error('[worker] started')
  if (!env.FACTORIX_PROXY_URL)
    console.error(
      '[worker] FACTORIX_PROXY_URL is not set: agent containers get real model keys and unrestricted egress. Use this for local development only.',
    )
  const shutdown = async () => {
    await handle.close()
    await queues.close()
    await db.destroy()
    redis.disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

if (import.meta.url === `file://${process.argv[1]}`) void main()
