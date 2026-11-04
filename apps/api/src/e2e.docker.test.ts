import { randomUUID } from 'node:crypto'
import type { TrackerIssue } from '@factorix/connectors'
import type { RunRow } from '@factorix/db'
import type { ScriptedPlan } from '@factorix/runtime'
import { DockerSandboxProvider, dockerClientFromEnv } from '@factorix/sandbox'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { AppDeps } from './deps'
import { STATES, TEAM_ID } from './testing/fakes'
import {
  ApiClient,
  createHarness,
  type Harness,
  issuePayload,
  removeOwnSandboxes,
  sendGitlabWebhook,
  sendLinearWebhook,
  waitFor,
} from './testing/harness'
import { startWorkers, type WorkerHandle } from './worker'

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
    redisUrl: string
  }
}

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const suffix = randomUUID().slice(0, 8)
const remoteVolume = `fx-test-remote-${suffix}`

async function inRemote(script: string): Promise<string> {
  const container = await docker.createContainer({
    Image: image,
    User: '0',
    Cmd: ['bash', '-c', script],
    Env: ['HOME=/tmp'],
    HostConfig: { Mounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] },
  })
  await container.start()
  const { StatusCode } = (await container.wait()) as { StatusCode: number }
  const logs = await container.logs({ stdout: true, stderr: true })
  await container.remove({ force: true })
  const output = demux(logs)
  if (StatusCode !== 0) throw new Error(`remote script failed: ${output}`)
  return output
}

function demux(buffer: Buffer): string {
  let offset = 0
  let text = ''
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4)
    text += buffer.toString('utf8', offset + 8, offset + 8 + size)
    offset += 8 + size
  }
  return text
}

const remoteGit = (args: string) => inRemote(`git -c safe.directory='*' -C /remote/repo.git ${args}`)

describe('factory end to end', () => {
  let harness: Harness
  let admin: ApiClient
  let worker: WorkerHandle
  let script: (phase: string, attempt: number) => ScriptedPlan | undefined = () => undefined
  let linear: { id: string; webhookSecret: string }
  let gitlab: { id: string; webhookSecret: string }
  let projectId: string
  let agentLabels: Record<string, string>

  const startWorker = () =>
    startWorkers(harness.deps as AppDeps & { sandbox: NonNullable<AppDeps['sandbox']> }, { prefix: harness.prefix, log: () => undefined })

  const setAutonomy = (autonomy: string) => admin.ok('PUT', `/api/projects/${projectId}`, { autonomy })

  async function labelledIssue(title: string): Promise<{ tracker: TrackerIssue; issueId: string }> {
    const handle = 'engineer-1'
    const labelId = agentLabels[handle] as string
    const tracker = harness.world.addIssue({ title, labels: [{ id: labelId, name: handle, parentId: null, isGroup: false }] })
    const response = await sendLinearWebhook(harness.app, linear.id, linear.webhookSecret, issuePayload(tracker, 'create'))
    expect(response.statusCode).toBe(200)
    const row = await waitFor(() => harness.deps.db('issues').where({ trackerIssueId: tracker.id }).first(), 'the issue mirror row')
    return { tracker, issueId: row.id }
  }

  const issueOf = (id: string) => harness.deps.db('issues').where({ id }).first()
  const firstMrIid = async (issueId: string): Promise<number> => (await harness.deps.db('issue_merge_requests').where({ issueId }).first()).mrIid
  const runsOf = (issueId: string): Promise<RunRow[]> => harness.deps.db<RunRow>('runs').where({ issueId }).orderBy('created_at')
  const untilStep = (issueId: string, step: string, timeout = 120_000) =>
    waitFor(
      async () => {
        const issue = await issueOf(issueId)
        return issue?.cursor?.step === step ? issue : null
      },
      `the issue to reach ${step}`,
      timeout,
    )
  const untilState = (issueId: string, state: string, timeout = 120_000) =>
    waitFor(
      async () => {
        const issue = await issueOf(issueId)
        return issue?.factoryState === state ? issue : null
      },
      `the issue to become ${state}`,
      timeout,
    )
  const untilEvent = (runId: string, predicate: (payload: any) => boolean) =>
    waitFor(
      async () => {
        const rows = await harness.deps.db('run_events').where({ runId })
        return rows.some((row) => predicate(row.payload)) ? rows : null
      },
      'a run event',
      90_000,
    )

  const noteHook = (iid: number, discussionId: string, noteId: string, body: string) => ({
    object_kind: 'note',
    project_id: 42,
    user: { username: 'sam' },
    merge_request: { iid },
    object_attributes: {
      id: noteId,
      note: body,
      noteable_type: 'MergeRequest',
      discussion_id: discussionId,
      system: false,
      created_at: new Date().toISOString(),
    },
  })
  const mergeHook = (iid: number) => ({ object_kind: 'merge_request', project: { id: 42 }, object_attributes: { action: 'merge', iid } })

  beforeAll(async () => {
    await docker.createVolume({ Name: remoteVolume })
    await inRemote(`
      set -e
      git init -q -b main --bare /remote/repo.git
      git init -q -b main /tmp/seed && cd /tmp/seed
      git config user.name seed && git config user.email seed@example.com
      echo '# Project rules' > AGENTS.md && echo base > base.txt
      git add -A && git commit -qm init
      git push -q /remote/repo.git main
      git -C /remote/repo.git symbolic-ref HEAD refs/heads/main
      git init -q -b main --bare /remote/second.git
      git init -q -b main /tmp/second && cd /tmp/second
      git config user.name seed && git config user.email seed@example.com
      echo other > other.txt && git add -A && git commit -qm init
      git push -q /remote/second.git main
      git -C /remote/second.git symbolic-ref HEAD refs/heads/main
      chown -R 1000:1000 /remote
    `)
    harness = await createHarness(
      { databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') },
      {
        sandbox: new DockerSandboxProvider({ image, extraStepMounts: [{ Type: 'volume', Source: remoteVolume, Target: '/remote' }] }, docker),
        scriptFor: (phase, attempt) => script(phase, attempt),
        timings: { heartbeatMs: 500, leaseSeconds: 3, recoveryMs: 500, noteDebounceMs: 300 },
      },
    )
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
    linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'lin_api_x' })).connection
    gitlab = (
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
      autonomy: 'plan_first',
      stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
    })
    projectId = project.id
    worker = startWorker()
    const imported = await waitFor(async () => {
      const current = (await admin.ok('GET', `/api/projects/${projectId}`)).project
      return current.syncState === 'idle' && current
    }, 'the project import')
    agentLabels = imported.agentLabels
  })

  afterAll(async () => {
    await worker?.close()
    await removeOwnSandboxes(harness, docker)
    await harness?.destroy()
    await docker
      .getVolume(remoteVolume)
      .remove({ force: true })
      .catch(() => undefined)
  })

  it('takes a labelled Linear issue through plan, approval, implement, review, address, and merge', async () => {
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
          comments: [{ path: 'FACTORIX_DEMO.md', line: 1, side: 'new', severity: 'major', body: 'Add a heading.' }],
        },
      }
    }
    const { tracker, issueId } = await labelledIssue('Add a demo marker')

    await untilState(issueId, 'waiting_human')
    const { approvals } = await admin.ok('GET', '/api/approvals?status=pending')
    const approval = approvals.find((candidate: { issueId: string }) => candidate.issueId === issueId)
    expect(approval.kind).toBe('plan')
    expect(approval.payload.plan.summary).toContain('marker')
    await waitFor(async () => harness.world.comments.some((comment) => comment.issueId === tracker.id), 'a plan comment on the tracker')

    await admin.ok('POST', `/api/approvals/${approval.id}/decide`, { decision: 'approved', message: 'Ship it' })

    const merged = await untilStep(issueId, 'await_merge', 180_000)
    expect(merged.factoryState).toBe('awaiting_merge')
    const iid = await firstMrIid(issueId)
    expect(iid).toBeTruthy()
    const mr = harness.world.mrs.get(iid)
    expect(mr?.title).toBe(`${tracker.identifier}: Add a demo marker`)
    expect(mr?.description).toContain('factorix:run=')
    expect(harness.world.mrs.size).toBe(1)

    expect(await remoteGit(`log --format='%an|%ae|%cn|%ce' ${merged.branchName} -n 1`)).toContain('Acme Bot|bot@acme.dev|Acme Bot|bot@acme.dev')
    const log = await remoteGit(`log --format=%B ${merged.branchName} -n 5`)
    expect(log).toContain('Factorix-Agent: engineer-1')
    expect(log).toContain('Factorix-Run:')
    expect(log).toContain('docs: address review')
    const file = await remoteGit(`show ${merged.branchName}:FACTORIX_DEMO.md`)
    expect(file).toContain('Updated by the scripted runtime')
    expect(await remoteGit('rev-parse --verify -q refs/heads/main')).toBeTruthy()
    expect(await remoteGit(`log --format=%s main`)).not.toContain('docs:')

    const threads = harness.world.discussions.get(iid) ?? []
    expect(threads[0]?.notes[0]?.body).toContain('Add a heading.')
    expect(threads[0]?.notes[0]?.path).toBe('FACTORIX_DEMO.md')
    expect(harness.world.approvals).toContain(iid)

    const runs = await runsOf(issueId)
    const phases = runs.map((run) => `${run.phase}:${run.state}`)
    expect(phases, JSON.stringify(runs.map((run) => run.error))).toEqual([
      'plan:succeeded',
      'implement:succeeded',
      'review:succeeded',
      'address_review:succeeded',
      'review:succeeded',
    ])

    const { discussionId, noteId } = harness.world.addHumanNote(iid, 'Please say hello too.', 'FACTORIX_DEMO.md', 1)
    expect(
      (
        await sendGitlabWebhook(
          harness.app,
          gitlab.id,
          gitlab.webhookSecret,
          'Note Hook',
          noteHook(iid, discussionId, noteId, 'Please say hello too.'),
        )
      ).statusCode,
    ).toBe(200)
    await waitFor(
      async () => {
        const issue = await issueOf(issueId)
        const count = (await runsOf(issueId)).filter((run) => run.phase === 'address_review').length
        return issue?.cursor?.step === 'await_merge' && count === 2 ? issue : null
      },
      'the human note to be addressed',
      180_000,
    )
    const addressRun = (await runsOf(issueId)).filter((run) => run.phase === 'address_review').at(-1) as RunRow
    expect(addressRun.state).toBe('succeeded')
    expect((await harness.deps.db('mr_discussions').where({ issueId, origin: 'human' })).map((row) => row.body)).toContain('Please say hello too.')

    harness.world.mrs.set(iid, {
      ...(harness.world.mrs.get(iid) as NonNullable<ReturnType<typeof harness.world.mrs.get>>),
      state: 'merged',
    })
    await sendGitlabWebhook(harness.app, gitlab.id, gitlab.webhookSecret, 'Merge Request Hook', mergeHook(iid))
    await untilState(issueId, 'done')
    expect((await harness.deps.db('issue_merge_requests').where({ issueId }).first()).mrState).toBe('merged')

    await waitFor(async () => harness.world.issues.get(tracker.id)?.stateName === 'Done', 'the tracker to reach Done')
    const names = harness.world.stateWrites
      .filter((write) => write.issueId === tracker.id)
      .map((write) => STATES.find((state) => state.id === write.stateId)?.name)
    expect(names[0]).toBe('In Progress')
    expect(names).toContain('In Review')
    expect(names.at(-1)).toBe('Done')

    const comments = harness.world.comments.filter((comment) => comment.issueId === tracker.id).map((comment) => comment.body)
    expect(comments.length).toBeGreaterThan(0)
    expect(comments.every((body) => body.startsWith('**[Factorix'))).toBe(true)

    const issueDetail = (await admin.ok('GET', `/api/issues/${issueId}`)).issue
    expect(issueDetail.timeline.length).toBeGreaterThan(5)
    const { entries } = await admin.ok('GET', '/api/audit?action=run.finished')
    expect(entries.some((entry: { actorKind: string; actorName: string }) => entry.actorKind === 'agent' && entry.actorName.length > 0)).toBe(true)
  })

  it('does not repeat itself when the tracker echoes a factory write back', async () => {
    await setAutonomy('human_merge')
    script = () => undefined
    const { tracker, issueId } = await labelledIssue('Echo check')
    await untilStep(issueId, 'await_merge', 180_000)
    const before = (await runsOf(issueId)).length
    const latest = harness.world.issues.get(tracker.id) as TrackerIssue
    await sendLinearWebhook(harness.app, linear.id, linear.webhookSecret, issuePayload(latest))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await runsOf(issueId)).length).toBe(before)
    expect((await issueOf(issueId)).cursor.step).toBe('await_merge')
  })

  it('merges by itself under full_auto once CI turns green', async () => {
    await setAutonomy('full_auto')
    harness.world.ci = { status: 'running', failedJobs: [] }
    script = () => undefined
    const { issueId } = await labelledIssue('Full auto')
    const waiting = await waitFor(
      async () => {
        const issue = await issueOf(issueId)
        return issue?.cursor?.waitingFor === 'ci' ? issue : null
      },
      'the review step to wait for CI',
      180_000,
    )
    expect((await runsOf(issueId)).filter((run) => run.phase === 'review')).toHaveLength(0)

    harness.world.ci = { status: 'success', failedJobs: [] }
    await sendGitlabWebhook(harness.app, gitlab.id, gitlab.webhookSecret, 'Pipeline Hook', {
      object_kind: 'pipeline',
      project: { id: 42 },
      merge_request: { iid: await firstMrIid(issueId) },
      object_attributes: { id: 9, status: 'success', ref: waiting.branchName, sha: 'abc' },
    })
    await untilState(issueId, 'done', 180_000)
    expect(harness.world.merges).toContain(await firstMrIid(issueId))
    harness.world.ci = { status: 'none', failedJobs: [] }
  })

  it('cancels a running agent, pushes its work as wip, and leaves the base branch alone', async () => {
    await setAutonomy('human_merge')
    script = (phase) =>
      phase === 'implement'
        ? { steps: [{ writeFile: { path: 'partial.txt', content: 'half done\n' } }, { say: 'partway there' }, { sleepMs: 120_000 }] }
        : undefined
    const { issueId } = await labelledIssue('Cancel me')
    const run = await waitFor(async () => (await runsOf(issueId)).find((candidate) => candidate.phase === 'implement'), 'the implement run')
    await untilEvent(run.id, (payload) => payload.type === 'message' && payload.text === 'partway there')
    await admin.ok('POST', `/api/runs/${run.id}/cancel`, {})
    const cancelled = await untilState(issueId, 'cancelled')
    const final = await waitFor(async () => {
      const row = (await runsOf(issueId)).find((candidate) => candidate.id === run.id)
      return row?.state === 'cancelled' ? row : null
    }, 'the run to be cancelled')
    expect(final.outcome).toBe('cancelled')
    const log = await remoteGit(`log --format=%s ${cancelled.branchName} -n 2`)
    expect(log).toContain('wip:')
    expect(await remoteGit(`show ${cancelled.branchName}:partial.txt`)).toContain('half done')
  })

  it('retries a failed run once, then blocks the issue, and a human retry recovers it', async () => {
    await setAutonomy('human_merge')
    script = (phase) =>
      phase === 'implement' ? { steps: [{ say: 'about to fail' }], fail: { code: 'rate_limit', message: 'Slow down' } } : undefined
    const { tracker, issueId } = await labelledIssue('Fails at first')
    const failed = await untilState(issueId, 'failed', 180_000)
    expect(failed.cursor.step).toBe('fail')
    const attempts = (await runsOf(issueId)).filter((run) => run.phase === 'implement')
    expect(attempts.map((run) => run.attempt)).toEqual([1, 2])
    expect(attempts.every((run) => run.state === 'failed')).toBe(true)
    expect(attempts[1]?.parentRunId).toBe(attempts[0]?.id)
    await waitFor(async () => harness.world.issues.get(tracker.id)?.stateName === 'Blocked', 'the tracker to show Blocked')

    script = () => undefined
    await admin.ok('POST', `/api/issues/${issueId}/retry`)
    await untilStep(issueId, 'await_merge', 180_000)
  })

  it('survives a worker crash: reattaches, loses and repeats nothing', async () => {
    await setAutonomy('human_merge')
    const steps = Array.from({ length: 12 }, (_, index) => [{ say: `tick ${index}` }, { sleepMs: 500 }]).flat()
    script = (phase) =>
      phase === 'implement'
        ? {
            steps: [
              ...steps,
              { writeFile: { path: 'crash.txt', content: 'survived\n' } },
              { exec: 'git add crash.txt && git commit -qm "feat: survive a crash"' },
            ],
            structuredOutput: { summary: 'Done.', approach: 'Slowly.', testing: 'None.', notes: '' },
          }
        : undefined
    const { issueId } = await labelledIssue('Crash the worker')
    const run = await waitFor(async () => (await runsOf(issueId)).find((candidate) => candidate.phase === 'implement'), 'the implement run')
    await untilEvent(run.id, (payload) => payload.type === 'message' && payload.text === 'tick 2')

    await worker.crash()
    const { containerId } = (await harness.deps.db('runs').where({ id: run.id }).first()) as RunRow
    expect(containerId).toBeTruthy()
    expect((await docker.getContainer(containerId as string).inspect()).State.Running).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    worker = startWorker()

    await untilStep(issueId, 'await_merge', 180_000)
    const finished = (await harness.deps.db('runs').where({ id: run.id }).first()) as RunRow
    expect(finished.state).toBe('succeeded')
    const events = await harness.deps.db('run_events').where({ runId: run.id }).orderBy('seq')
    const seqs = events.map((row) => Number(row.seq))
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1))
    const ticks = events.filter((row) => row.payload.type === 'message' && String(row.payload.text).startsWith('tick')).map((row) => row.payload.text)
    expect(ticks).toEqual(Array.from({ length: 12 }, (_, index) => `tick ${index}`))
    expect(events.some((row) => row.payload.type === 'log' && String(row.payload.message).includes('reattached'))).toBe(true)
    expect(events.filter((row) => row.payload.type === 'done')).toHaveLength(1)
  })

  it('streams an ad-hoc run over SSE, replays after a reconnect, and shows the diff', async () => {
    script = () => undefined
    const address = await harness.app.listen({ port: 0, host: '127.0.0.1' })
    const { agents } = await admin.ok('GET', '/api/agents')
    const engineer = agents.find((agent: { handle: string }) => agent.handle === 'engineer-1')
    const { run } = await admin.ok('POST', '/api/runs', { agentId: engineer.id, prompt: 'Add a file', gitUrl: 'file:///remote/repo.git' })

    const read = async (query: string, until: (data: any) => boolean) => {
      const controller = new AbortController()
      const response = await fetch(`${address}/api/runs/${run.id}/events${query}`, { headers: { cookie: admin.cookie }, signal: controller.signal })
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const received: any[] = []
      let buffer = ''
      const decoder = new TextDecoder()
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        let finished = false
        for (const frame of frames) {
          const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '))
          if (!line) continue
          const data = JSON.parse(line.slice(6))
          received.push(data)
          if (until(data)) finished = true
        }
        if (finished) break
      }
      controller.abort()
      return received
    }

    const live = await read('', (data) => data.event?.type === 'done')
    const liveEvents = live.filter((data) => data.kind === 'event').map((data) => data.event)
    expect(liveEvents.some((event) => event.type === 'run.started')).toBe(true)
    const doneSeq = liveEvents.find((event) => event.type === 'done').seq

    const replayed = await read(`?after=${doneSeq - 2}`, (data) => data.event?.type === 'done')
    const replayedEvents = replayed.filter((data) => data.kind === 'event').map((data) => data.event)
    expect(replayedEvents.every((event) => event.seq > doneSeq - 2)).toBe(true)
    expect(replayedEvents.at(-1).type).toBe('done')

    await waitFor(async () => {
      const row = await harness.deps.db('runs').where({ id: run.id }).first()
      return row?.state === 'succeeded' ? row : null
    }, 'the ad-hoc run to succeed')
    const { diff } = await admin.ok('GET', `/api/runs/${run.id}/diff`)
    expect(diff).toContain('ADHOC.md')
  })

  describe('with several repositories', () => {
    const FIRST = { scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'file:///remote/repo.git', defaultBranch: 'main' }
    const SECOND = { scmRepoId: '43', scmRepoPath: 'g/s', scmCloneUrl: 'file:///remote/second.git', defaultBranch: 'main' }
    const mergeRequests = (issueId: string) => harness.deps.db('issue_merge_requests').where({ issueId }).orderBy('mr_iid')
    const secondGit = (args: string) => inRemote(`git -c safe.directory='*' -C /remote/second.git ${args}`)

    beforeAll(async () => {
      await admin.ok('PUT', `/api/projects/${projectId}`, {
        repos: [
          { ...FIRST, setupCommands: ['touch .git/setup-ran'] },
          { ...SECOND, setupCommands: ['touch .git/setup-ran'] },
        ],
      })
    })
    afterAll(async () => {
      await admin.ok('PUT', `/api/projects/${projectId}`, { repos: [FIRST] })
    })

    it('opens one merge request per repository, reviews them together, and merges in order', async () => {
      await setAutonomy('full_auto')
      harness.world.merges = []
      script = () => undefined
      const { issueId } = await labelledIssue('Change both')
      const done = await untilState(issueId, 'done', 240_000)

      const rows = await mergeRequests(issueId)
      expect(rows.map((row) => [row.repoPath, row.mrState])).toEqual([
        ['g/r', 'merged'],
        ['g/s', 'merged'],
      ])
      expect(rows.map((row) => harness.world.mrRepos.get(row.mrIid))).toEqual(['42', '43'])
      expect(harness.world.merges).toEqual(rows.map((row) => row.mrIid))
      expect(rows[1].mrUrl).toContain('/g/s/')

      expect(await remoteGit(`log --format=%s ${done.branchName}`)).toContain('docs: add factorix demo marker')
      expect(await secondGit(`log --format=%s ${done.branchName}`)).toContain('docs: add factorix demo marker')
      expect(await secondGit(`log --format=%s main`)).not.toContain('docs: add factorix demo marker')

      const implement = (await runsOf(issueId)).find((run) => run.phase === 'implement') as RunRow
      const { diff } = await admin.ok('GET', `/api/runs/${implement.id}/diff`)
      expect(diff).toContain('+++ b/r/FACTORIX_DEMO.md')
      expect(diff).toContain('+++ b/s/FACTORIX_DEMO.md')

      for (const row of rows) {
        const notes = harness.world.notes.filter((note) => note.iid === row.mrIid).map((note) => note.body)
        expect(notes.some((body) => body.includes('spans 2 repositories') && rows.every((other) => body.includes(other.mrUrl)))).toBe(true)
        expect(notes.some((body) => body.includes('Review verdict: approve'))).toBe(true)
      }
      const comments = harness.world.comments.filter((comment) => comment.body.includes('/-/merge_requests/'))
      expect(comments.some((comment) => comment.body.includes(rows[1].mrUrl))).toBe(true)
    })

    it('leaves a repository the agent did not change alone', async () => {
      await setAutonomy('human_merge')
      script = (phase) =>
        phase === 'implement'
          ? {
              steps: [
                { exec: 'test -e r/.git/setup-ran || test -e s/.git/setup-ran || echo setup-left-to-agent' },
                { writeFile: { path: 's/ONLY.md', content: 'second only\n' } },
                { exec: 'git -C s add -A && git -C s commit -qm "docs: second only"' },
                {
                  exec: 'git init -q -b main outside && cd outside && git -c user.name=a -c user.email=a@b.c commit -q --allow-empty -m "out of scope"',
                },
              ],
              structuredOutput: { summary: 'One repository.', approach: 'Wrote a file.', testing: 'None.', notes: '' },
            }
          : undefined
      const { issueId } = await labelledIssue('Change one')
      const waiting = await untilStep(issueId, 'await_merge', 240_000)
      const rows = await mergeRequests(issueId)
      expect(rows.map((row) => row.repoPath)).toEqual(['g/s'])
      const implement = (await runsOf(issueId)).find((run) => run.phase === 'implement') as RunRow
      const events = await harness.deps.db('run_events').where({ runId: implement.id, type: 'tool.result' }).orderBy('seq')
      expect(events[0].payload.output).toContain('setup-left-to-agent')
      expect(await inRemote('ls /remote')).not.toContain('outside')
      expect(await remoteGit('branch --list')).not.toContain(waiting.branchName)
      expect(harness.world.notes.filter((note) => note.iid === rows[0].mrIid).some((note) => note.body.includes('spans'))).toBe(false)

      harness.world.mrs.set(rows[0].mrIid, {
        ...(harness.world.mrs.get(rows[0].mrIid) as NonNullable<ReturnType<typeof harness.world.mrs.get>>),
        state: 'merged',
      })
      const hook = mergeHook(rows[0].mrIid)
      await sendGitlabWebhook(harness.app, gitlab.id, gitlab.webhookSecret, 'Merge Request Hook', { ...hook, project: { id: 43 } })
      await untilState(issueId, 'done')
    })

    it('merges in the order the agent chose, ignoring folders it could not have changed', async () => {
      await setAutonomy('full_auto')
      harness.world.merges = []
      script = (phase) =>
        phase === 'implement'
          ? {
              steps: [
                { writeFile: { path: 'r/ORDER.md', content: 'first\n' } },
                { exec: 'git -C r add -A && git -C r commit -qm "docs: order"' },
                { writeFile: { path: 's/ORDER.md', content: 'second\n' } },
                { exec: 'git -C s add -A && git -C s commit -qm "docs: order"' },
              ],
              structuredOutput: { summary: 'Both.', approach: 'Files.', testing: 'None.', notes: '', mergeOrder: ['nope', 's', 'r'] },
            }
          : undefined
      const { issueId } = await labelledIssue('Second merges first')
      await untilState(issueId, 'done', 240_000)
      const rows = await harness.deps.db('issue_merge_requests').where({ issueId })
      const iidOf = (path: string) => rows.find((row) => row.repoPath === path)?.mrIid as number
      expect(harness.world.merges).toEqual([iidOf('g/s'), iidOf('g/r')])
      const note = harness.world.notes.find((candidate) => candidate.iid === iidOf('g/r') && candidate.body.includes('Merge in this order')) as {
        body: string
      }
      expect(note.body.indexOf(`merge_requests/${iidOf('g/s')}`)).toBeLessThan(note.body.indexOf(`merge_requests/${iidOf('g/r')}`))
    })

    it('leaves setup to checkout when the project has one repository', async () => {
      await admin.ok('PUT', `/api/projects/${projectId}`, {
        repos: [{ ...FIRST, setupCommands: ['touch .git/setup-ran', 'touch .git/setup-second'] }],
      })
      await setAutonomy('human_merge')
      script = (phase) =>
        phase === 'implement'
          ? {
              steps: [{ exec: 'test -e .git/setup-ran && test -e .git/setup-second && echo setup-at-checkout' }],
              structuredOutput: { summary: 'Checked.', approach: 'None.', testing: 'None.', notes: '' },
            }
          : undefined
      const { issueId } = await labelledIssue('Single repository setup')
      const run = await waitFor(
        async () => {
          const row = (await runsOf(issueId)).find((candidate) => candidate.phase === 'implement')
          return row && ['succeeded', 'failed'].includes(row.state) ? row : null
        },
        'the implement run to finish',
        240_000,
      )
      const events = await harness.deps.db('run_events').where({ runId: run.id, type: 'tool.result' }).orderBy('seq')
      expect(events[0].payload.output).toContain('setup-at-checkout')
      await admin.ok('PUT', `/api/projects/${projectId}`, { repos: [FIRST, SECOND] })
    })

    it('reports no changes when the agent changed nothing anywhere', async () => {
      await setAutonomy('human_merge')
      script = (phase) =>
        phase === 'implement'
          ? { steps: [{ say: 'Nothing to do.' }], structuredOutput: { summary: 'Nothing.', approach: 'None.', testing: 'None.', notes: '' } }
          : undefined
      const { issueId } = await labelledIssue('Change nothing')
      await waitFor(
        async () => {
          const runs = await runsOf(issueId)
          return runs.some((run) => run.phase === 'implement' && ['succeeded', 'failed'].includes(run.state)) ? runs : null
        },
        'the implement run to finish',
        240_000,
      )
      expect(await mergeRequests(issueId)).toEqual([])
    })
  })

  it('hands a ticket to an agent from a workflow and continues when the real run finishes', async () => {
    await setAutonomy('human_merge')
    script = () => undefined
    const { connection: slack } = await admin.ok('POST', '/api/connections', { kind: 'slack', name: 'Slack', secret: 'xoxb-secret' })
    const { agents } = await admin.ok('GET', '/api/agents')
    const engineer = agents.find((agent: { handle: string }) => agent.handle === 'engineer-1')
    const position = { x: 0, y: 0 }
    const { workflow } = await admin.ok('POST', '/api/workflows', {
      name: 'Build it, then tell the team',
      definition: {
        nodes: [
          { id: 'start', type: 'trigger.manual', position, config: {} },
          { id: 'build', type: 'agent.run', position, config: { agentId: engineer.id } },
          {
            id: 'tell',
            type: 'notify.send',
            position,
            config: { connectionId: slack.id, channel: 'C1', message: '{{issue.identifier}}: {{steps.build.result}}' },
          },
          { id: 'failed', type: 'notify.send', position, config: { connectionId: slack.id, channel: 'C2', message: 'It failed' } },
        ],
        edges: [
          { id: 'a', source: 'start', sourceHandle: 'next', target: 'build' },
          { id: 'b', source: 'build', sourceHandle: 'next', target: 'tell' },
          { id: 'c', source: 'build', sourceHandle: 'failed', target: 'failed' },
        ],
      },
    })
    await admin.ok('POST', `/api/workflows/${workflow.id}/publish`)
    const tracker = harness.world.addIssue({ title: 'Built by a workflow' })
    await sendLinearWebhook(harness.app, linear.id, linear.webhookSecret, issuePayload(tracker, 'create'))
    const row = await waitFor(() => harness.deps.db('issues').where({ trackerIssueId: tracker.id }).first(), 'the issue mirror row')

    const { started } = await admin.ok('POST', `/api/workflows/${workflow.id}/runs`, { issueIds: [row.id] })
    const steps = async () => (await admin.ok('GET', `/api/workflow-runs/${started[0]}`)).run
    await waitFor(
      async () => (await steps()).steps.find((step: { nodeId: string }) => step.nodeId === 'build').status === 'waiting',
      'the agent block to wait',
    )
    const finished = await waitFor(
      async () => {
        const run = await steps()
        return run.status === 'running' ? null : run
      },
      'the workflow run to finish',
      180_000,
    )

    expect(finished.status).toBe('succeeded')
    expect(finished.steps.find((step: { nodeId: string }) => step.nodeId === 'failed').status).toBe('skipped')
    expect(harness.world.notifications.at(-1)).toMatchObject({ channelId: 'C1', markdown: `${row.identifier}: succeeded` })
    expect((await issueOf(row.id)).factoryState).toBe('awaiting_merge')
    expect(await firstMrIid(row.id)).toBeGreaterThan(0)
  })

  it('lets a researcher report on a ticket with read-only repositories, then hands it to an engineer', async () => {
    await setAutonomy('human_merge')
    const { archetype } = await admin.ok('POST', '/api/archetypes', { name: 'Researcher', role: 'other', systemPrompt: 'Dig into the ticket.' })
    const { agent } = await admin.ok('POST', '/api/agents', {
      handle: 'researcher-1',
      displayName: 'Researcher One',
      archetypeId: archetype.id,
      runtime: 'scripted',
      policy: { mode: 'full' },
    })
    script = (phase) =>
      phase === 'task'
        ? {
            steps: [{ say: 'Reading the repository.' }, { exec: 'touch NOT_ALLOWED 2>&1; echo "touch exited $?"' }],
            structuredOutput: { summary: 'The report for this ticket.' },
          }
        : undefined
    const tracker = harness.world.addIssue({ title: 'Research this' })
    await sendLinearWebhook(harness.app, linear.id, linear.webhookSecret, issuePayload(tracker, 'create'))
    const row = await waitFor(() => harness.deps.db('issues').where({ trackerIssueId: tracker.id }).first(), 'the issue mirror row')
    const stateBefore = harness.world.issues.get(tracker.id)?.stateId
    const branchesBefore = await remoteGit('branch --list')

    await admin.ok('POST', `/api/issues/${row.id}/assign`, { agentId: agent.id })
    await waitFor(async () => ((await issueOf(row.id)).factoryState === 'done' ? true : null), 'the task to finish', 180_000)

    const run = await harness.deps.db('runs').where({ issueId: row.id }).first()
    expect(run).toMatchObject({ phase: 'task', state: 'succeeded', summary: 'The report for this ticket.' })
    const events = await harness.deps.db('run_events').where({ runId: run.id, type: 'tool.result' })
    const output = events.map((event: { payload: { output?: string } }) => event.payload.output).join('\n')
    expect(output).toContain('Read-only file system')
    expect(output).toContain('touch exited 1')
    const report = await waitFor(
      async () => harness.world.comments.find((comment) => comment.issueId === tracker.id && comment.body.includes('The report for this ticket.')),
      'the report on the ticket',
    )
    expect(report?.body.startsWith('**[Factorix')).toBe(true)
    expect(await remoteGit('branch --list')).toBe(branchesBefore)
    expect(await harness.deps.db('issue_merge_requests').where({ issueId: row.id })).toEqual([])
    expect(harness.world.issues.get(tracker.id)?.stateId).toBe(stateBefore)

    script = () => undefined
    const { agents } = await admin.ok('GET', '/api/agents')
    const engineer = agents.find((item: { handle: string }) => item.handle === 'engineer-1')
    await admin.ok('POST', `/api/issues/${row.id}/assign`, { agentId: engineer.id })
    await waitFor(
      async () => ((await issueOf(row.id)).factoryState === 'awaiting_merge' ? true : null),
      'the engineer to open a merge request',
      180_000,
    )
    expect(await firstMrIid(row.id)).toBeGreaterThan(0)
  })

  it('keeps the git token out of run events and stored run data', async () => {
    const events = await harness.deps.db('run_events').select('payload')
    expect(JSON.stringify(events.map((row) => row.payload))).not.toContain('glpat-supersecret')
    const specs = await harness.deps.db('runs').select('agent_snapshot', 'structured_output', 'error')
    expect(JSON.stringify(specs)).not.toContain('glpat-supersecret')
  })
})
