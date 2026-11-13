import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { RunRow } from '@factorix/db'
import type { ScriptedPlan } from '@factorix/runtime'
import { DockerSandboxProvider, dockerClientFromEnv, RoutingSandboxProvider, type SandboxProvider, serveSandbox } from '@factorix/sandbox'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { connectRunner, type RunnerLink } from '../../remote-runner/src/link'
import type { AppDeps } from './deps'
import { RunnerLinks } from './services/runner-link'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness, issuePayload, removeOwnSandboxes, sendLinearWebhook, waitFor } from './testing/harness'
import { startWorkers, type WorkerHandle } from './worker'

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const remoteVolume = `fx-test-runner-${randomUUID().slice(0, 8)}`

/** Runs a script against the stand-in for the code host and returns its exit code. */
async function inRemote(script: string): Promise<number> {
  const container = await docker.createContainer({
    Image: image,
    User: '0',
    Cmd: ['bash', '-c', script],
    HostConfig: { Mounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] },
  })
  await container.start()
  const { StatusCode } = (await container.wait()) as { StatusCode: number }
  await container.remove({ force: true })
  return StatusCode
}

/** Stands in for the Docker beside the worker: it holds nothing, and any work sent to it is recorded. */
function idleMachine(): { provider: SandboxProvider; used: string[] } {
  const used: string[] = []
  const provider = new Proxy(
    { listManaged: async () => ({ containers: [], volumes: [] }), listRuntimeModels: async () => ({}) },
    {
      get: (target, method: string) =>
        method in target || method === 'then'
          ? target[method as keyof typeof target]
          : async () => {
              used.push(method)
              throw new Error(`${method} ran on the worker's machine`)
            },
    },
  ) as unknown as SandboxProvider
  return { provider, used }
}

describe('a project on a runner, end to end', () => {
  let harness: Harness
  let admin: ApiClient
  let worker: WorkerHandle
  let links: RunnerLinks
  let link: RunnerLink
  let stopServing: () => void
  let runnerId: string
  let linear: { id: string; webhookSecret: string }
  let agentLabels: Record<string, string>
  let script: (phase: string) => ScriptedPlan | undefined = () => undefined
  const local = idleMachine()

  beforeAll(async () => {
    await docker.createVolume({ Name: remoteVolume })
    expect(
      await inRemote(`set -e
        git init -q -b main --bare /remote/repo.git
        git init -q -b main /tmp/seed && cd /tmp/seed
        git config user.name seed && git config user.email seed@example.com
        echo base > base.txt && git add -A && git commit -qm init
        git push -q /remote/repo.git main
        git -C /remote/repo.git symbolic-ref HEAD refs/heads/main
        chown -R 1000:1000 /remote`),
    ).toBe(0)

    harness = await createHarness(
      { databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') },
      {
        scriptFor: (phase) => script(phase),
        timings: { heartbeatMs: 500, leaseSeconds: 3, recoveryMs: 500, noteDebounceMs: 300 },
      },
    )
    links = new RunnerLinks({ db: harness.deps.db, redis: harness.deps.redis, stack: 'factorix' })
    harness.deps.sandbox = new RoutingSandboxProvider(local.provider, links.routes())

    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    const { agents } = await admin.ok('GET', '/api/agents')
    for (const agent of agents) {
      await admin.ok('PUT', `/api/agents/${agent.id}`, {
        handle: agent.handle,
        displayName: agent.displayName,
        archetypeId: agent.archetype.id,
        runtime: 'scripted',
        policy: { mode: agent.policy.mode },
      })
    }

    const created = await admin.ok('POST', '/api/runners', { name: 'big-box' })
    runnerId = created.runner.id
    await harness.app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(harness.app.server.address() as AddressInfo).port}`
    link = connectRunner({ url, token: created.secret, retryMs: 50 })
    const onRunner = new DockerSandboxProvider({ image, extraStepMounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] }, docker)
    stopServing = serveSandbox(onRunner, link, { stack: 'factorix' })
    await waitFor(async () => (await admin.ok('GET', '/api/runners')).runners[0].online, 'the runner to connect')

    linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'lin_api_x' })).connection
    const gitlab = (
      await admin.ok('POST', '/api/connections', {
        kind: 'gitlab',
        name: 'GitLab',
        secret: 'glpat-supersecret',
        config: { host: 'https://gitlab.com', botName: 'Acme Bot', botEmail: 'bot@acme.dev' },
      })
    ).connection
    const { project } = await admin.ok('POST', '/api/projects', {
      name: 'Web app',
      trackerConnectionId: linear.id,
      trackerTeamId: TEAM_ID,
      scmConnectionId: gitlab.id,
      repos: [{ scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'file:///remote/repo.git', defaultBranch: 'main' }],
      autonomy: 'human_merge',
      stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
      runnerId,
      reviewComments: 'summary',
    })
    worker = startWorkers(harness.deps as AppDeps & { sandbox: NonNullable<AppDeps['sandbox']> }, { prefix: harness.prefix, log: () => undefined })
    const imported = await waitFor(async () => {
      const current = (await admin.ok('GET', `/api/projects/${project.id}`)).project
      return current.syncState === 'idle' && current
    }, 'the project import')
    agentLabels = imported.agentLabels
  })

  afterAll(async () => {
    await worker?.close()
    if (harness) await removeOwnSandboxes(harness, docker)
    stopServing?.()
    link?.close()
    links?.close()
    await harness?.destroy()
    await docker
      .getVolume(remoteVolume)
      .remove({ force: true })
      .catch(() => undefined)
  })

  it('implements, reviews, and addresses the review on the runner, leaving one summary note', async () => {
    let reviews = 0
    script = (phase) => {
      if (phase !== 'review') return undefined
      reviews += 1
      if (reviews > 1) return undefined
      return {
        steps: [{ say: 'Looks like the heading is missing.' }],
        structuredOutput: {
          verdict: 'request_changes',
          summary: 'Needs a heading.',
          comments: [
            { path: 'FACTORIX_DEMO.md', line: 1, side: 'new', severity: 'minor', body: 'Say why.' },
            { path: 'FACTORIX_DEMO.md', line: 1, side: 'new', severity: 'major', body: 'Add a heading.' },
          ],
        },
      }
    }
    const labelId = agentLabels['engineer-1'] as string
    const tracker = harness.world.addIssue({
      title: 'Add a demo marker',
      labels: [{ id: labelId, name: 'engineer-1', parentId: null, isGroup: false }],
    })
    expect((await sendLinearWebhook(harness.app, linear.id, linear.webhookSecret, issuePayload(tracker, 'create'))).statusCode).toBe(200)
    const issue = await waitFor(() => harness.deps.db('issues').where({ trackerIssueId: tracker.id }).first(), 'the issue mirror row')

    await waitFor(
      async () => {
        const current = await harness.deps.db('issues').where({ id: issue.id }).first()
        return current?.cursor?.step === 'await_merge' ? current : null
      },
      'the issue to reach await_merge',
      240_000,
    )

    const runs: RunRow[] = await harness.deps.db<RunRow>('runs').where({ issueId: issue.id }).orderBy('created_at')
    expect(
      runs.map((run) => `${run.phase}:${run.state}`),
      JSON.stringify(runs.map((run) => run.error)),
    ).toEqual(['implement:succeeded', 'review:succeeded', 'address_review:succeeded', 'review:succeeded'])
    for (const run of runs) expect(run.containerId).toMatch(new RegExp(`^rn-${runnerId}:[0-9a-f]{64}$`))
    expect(local.used).toEqual([])
    expect((await harness.deps.db('workspace_runners').where({ workspaceKey: issue.id }).first()).runnerId).toBe(runnerId)

    const { mrIid } = await harness.deps.db('issue_merge_requests').where({ issueId: issue.id }).first()
    expect(harness.world.discussions.get(mrIid) ?? []).toEqual([])
    const reviewNotes = harness.world.notes.filter((note) => note.iid === mrIid && note.body.includes('Review verdict'))
    expect(reviewNotes).toHaveLength(2)
    expect(reviewNotes[0]?.body).toContain('**Review verdict: changes requested**')
    expect(reviewNotes[0]?.body).toMatch(
      /\*\*Findings\*\*\n\n- \*\*major\*\* `FACTORIX_DEMO.md:1`: Add a heading\.\n- \*\*minor\*\* `FACTORIX_DEMO.md:1`: Say why\./,
    )
    expect(reviewNotes[1]?.body).toContain('**Review verdict: approve**')
    expect(reviewNotes[1]?.body).not.toContain('Findings')
  }, 300_000)
})
