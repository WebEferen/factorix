import { randomUUID } from 'node:crypto'
import type {
  CiResult,
  CreateIssueInput,
  MergeRequest,
  NotificationChannel,
  NotificationConnector,
  NotificationMessage,
  OpenMergeRequestInput,
  Page,
  ScmConnector,
  ScmDiscussion,
  ScmRepo,
  SecretSourceConnector,
  TrackerComment,
  TrackerConnector,
  TrackerIssue,
  TrackerLabel,
  TrackerProject,
  TrackerResource,
  TrackerState,
  TrackerTeam,
} from '@factorix/connectors'
import { type ConnectorFactory, storedSecrets } from '../deps'

export const TEAM_ID = 'team-1'

export const STATES: TrackerState[] = [
  { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'st-progress', name: 'In Progress', type: 'started', position: 2 },
  { id: 'st-review', name: 'In Review', type: 'started', position: 3 },
  { id: 'st-blocked', name: 'Blocked', type: 'started', position: 4 },
  { id: 'st-done', name: 'Done', type: 'completed', position: 5 },
  { id: 'st-canceled', name: 'Canceled', type: 'canceled', position: 6 },
]

export function stateById(id: string): TrackerState {
  const state = STATES.find((candidate) => candidate.id === id)
  if (!state) throw new Error(`unknown state ${id}`)
  return state
}

export const REPOS: ScmRepo[] = [
  { id: '42', path: 'g/r', name: 'r', cloneUrl: 'file:///remote/repo.git', webUrl: 'https://gitlab.example/g/r', defaultBranch: 'main' },
  { id: '43', path: 'g/s', name: 's', cloneUrl: 'file:///remote/second.git', webUrl: 'https://gitlab.example/g/s', defaultBranch: 'main' },
]

export class FakeWorld {
  issues = new Map<string, TrackerIssue>()
  labels: TrackerLabel[] = []
  comments: TrackerComment[] = []
  resources = new Map<string, TrackerResource[]>()
  failResources: string | null = null
  /** The token behind each comment and each git operation, to prove which account did the work. */
  commentTokens: (string | undefined)[] = []
  resourceTokens: (string | undefined)[] = []
  gitTokens: string[] = []
  stateWrites: { issueId: string; stateId: string }[] = []
  nextNumber = 1

  mrs = new Map<number, MergeRequest>()
  mrRepos = new Map<number, string>()
  discussions = new Map<number, ScmDiscussion[]>()
  notes: { iid: number; body: string }[] = []
  approvals: number[] = []
  merges: number[] = []
  webhooksRegistered: string[] = []
  refuseClose = new Set<number>()
  refuseRevert = new Set<number>()
  /** Which merge request each revert undoes. */
  revertOf = new Map<number, number>()
  ci: CiResult = { status: 'none', failedJobs: [] }
  ciByIid = new Map<number, CiResult>()
  refuseMerge = new Set<number>()
  media = new Map<string, { contentType: string; body: string }>()
  issuePagesRead = 0
  lastListQuery: { closedSince?: string; updatedAfter?: string } | null = null
  failIssueListing: string | null = null
  nextIid = 1

  addIssue(partial: Partial<TrackerIssue> & { title: string }): TrackerIssue {
    const number = this.nextNumber++
    const issue: TrackerIssue = {
      id: `issue-${randomUUID().slice(0, 8)}`,
      identifier: `ABC-${number}`,
      description: 'Do the thing.',
      url: `https://linear.example/ABC-${number}`,
      priority: 0,
      teamId: TEAM_ID,
      projectId: null,
      stateId: 'st-todo',
      stateName: 'Todo',
      stateType: 'unstarted',
      assigneeId: null,
      assigneeName: null,
      creatorId: 'user-1',
      creatorName: 'Sam Reporter',
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      ...partial,
    }
    this.issues.set(issue.id, issue)
    return issue
  }

  touch(issue: TrackerIssue, change: Partial<TrackerIssue>): TrackerIssue {
    const next = { ...issue, ...change, updatedAt: new Date(Date.now() + 1000).toISOString() }
    this.issues.set(next.id, next)
    return next
  }

  addHumanNote(iid: number, body: string, path?: string, line?: number): { discussionId: string; noteId: string } {
    const discussionId = `d-${randomUUID().slice(0, 8)}`
    const noteId = `n-${randomUUID().slice(0, 8)}`
    const list = this.discussions.get(iid) ?? []
    list.push({
      id: discussionId,
      notes: [
        {
          id: noteId,
          body,
          author: 'sam',
          system: false,
          path: path ?? null,
          line: line ?? null,
          createdAt: new Date().toISOString(),
          resolvable: true,
          resolved: false,
        },
      ],
    })
    this.discussions.set(iid, list)
    return { discussionId, noteId }
  }

  tracker(token?: string): TrackerConnector {
    return {
      kind: 'linear',
      viewer: async () => ({ id: 'u1', name: 'Bot', email: null }),
      listTeams: async (): Promise<TrackerTeam[]> => [{ id: TEAM_ID, key: 'ABC', name: 'Acme' }],
      listProjects: async (): Promise<TrackerProject[]> => [],
      listWorkflowStates: async () => STATES,
      listLabels: async () => this.labels,
      listIssues: async (query): Promise<Page<TrackerIssue>> => {
        if (this.failIssueListing) throw new Error(this.failIssueListing)
        this.issuePagesRead += 1
        this.lastListQuery = query
        const all = [...this.issues.values()].filter(
          (issue) => !query.closedSince || !['completed', 'canceled'].includes(issue.stateType) || issue.updatedAt > (query.closedSince as string),
        )
        const offset = Number(query.cursor ?? 0)
        const limit = query.limit ?? 50
        return { nodes: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null }
      },
      fetchMedia: async (url, options) => {
        const file = this.media.get(url)
        if (!file) return null
        return {
          status: options?.range ? 206 : 200,
          contentType: file.contentType,
          contentLength: String(file.body.length),
          contentRange: options?.range ? `bytes 0-${file.body.length - 1}/${file.body.length}` : null,
          body: new Blob([file.body]).stream(),
        }
      },
      getIssue: async (id) => this.issues.get(id) ?? null,
      listComments: async (issueId) => this.comments.filter((comment) => comment.issueId === issueId),
      listResources: async (issueId) => {
        if (this.failResources) throw new Error(this.failResources)
        this.resourceTokens.push(token)
        return this.resources.get(issueId) ?? []
      },
      createIssue: async (input: CreateIssueInput) =>
        this.addIssue({
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? 0,
          labels: this.labels.filter((label) => input.labelIds?.includes(label.id)),
        }),
      updateIssueState: async (issueId, stateId) => {
        this.stateWrites.push({ issueId, stateId })
        const issue = this.issues.get(issueId)
        const state = stateById(stateId)
        if (issue) this.touch(issue, { stateId, stateName: state.name, stateType: state.type })
      },
      updateIssueLabels: async (issueId, change) => {
        const issue = this.issues.get(issueId)
        if (!issue) return
        const kept = issue.labels.filter((label) => !change.remove?.includes(label.id))
        const added = this.labels.filter((label) => change.add?.includes(label.id))
        this.touch(issue, { labels: [...kept, ...added] })
      },
      createLabel: async (input) => {
        const label: TrackerLabel = { id: `label-${input.name}`, name: input.name, parentId: input.parentId ?? null, isGroup: input.isGroup }
        this.labels.push(label)
        return label
      },
      comment: async (issueId, body) => {
        const comment = { id: `c-${randomUUID().slice(0, 8)}`, issueId, body, authorId: 'u1', authorName: 'Bot', createdAt: new Date().toISOString() }
        this.comments.push(comment)
        this.commentTokens.push(token)
        return { id: comment.id }
      },
      updateComment: async () => {},
      registerWebhook: async (input) => {
        this.webhooksRegistered.push(input.url)
        return { id: 'w1' }
      },
    }
  }

  scm(token: string): ScmConnector {
    const mustGet = (iid: number): MergeRequest => {
      const mr = this.mrs.get(iid)
      if (!mr) throw new Error(`no merge request ${iid}`)
      return mr
    }
    const repoOf = (id: string): ScmRepo => REPOS.find((repo) => repo.id === id) ?? (REPOS[0] as ScmRepo)
    return {
      kind: 'gitlab',
      viewer: async () => ({ id: '1', username: 'bot', name: 'Bot' }),
      listRepos: async () => REPOS,
      getRepo: async (id) => repoOf(id),
      gitAuth: () => {
        this.gitTokens.push(token)
        return { token, username: 'oauth2' }
      },
      findOpenMergeRequest: async (repoId, sourceBranch) =>
        [...this.mrs.values()].find((mr) => mr.sourceBranch === sourceBranch && mr.state === 'opened' && this.mrRepos.get(mr.iid) === repoId) ?? null,
      openMergeRequest: async (input: OpenMergeRequestInput) => {
        const iid = this.nextIid++
        const mr: MergeRequest = {
          id: String(1000 + iid),
          iid,
          url: `${repoOf(input.repoId).webUrl}/-/merge_requests/${iid}`,
          state: 'opened',
          draft: false,
          title: input.title,
          description: input.description,
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
          sha: 'head-sha',
          hasConflicts: false,
          mergeBlocker: null,
          diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' },
        }
        this.mrs.set(iid, mr)
        this.mrRepos.set(iid, input.repoId)
        return mr
      },
      updateMergeRequest: async (_repoId, iid) => mustGet(iid),
      getMergeRequest: async (_repoId, iid) => mustGet(iid),
      listDiscussions: async (_repoId, iid) => this.discussions.get(iid) ?? [],
      postDiffDiscussion: async (_repoId, iid, input) => {
        const discussionId = `d-${randomUUID().slice(0, 8)}`
        const list = this.discussions.get(iid) ?? []
        list.push({
          id: discussionId,
          notes: [
            {
              id: `n-${randomUUID().slice(0, 8)}`,
              body: input.body,
              author: 'bot',
              system: false,
              path: input.path,
              line: input.line,
              createdAt: new Date().toISOString(),
              resolvable: true,
              resolved: false,
            },
          ],
        })
        this.discussions.set(iid, list)
        return { discussionId }
      },
      replyDiscussion: async (_repoId, iid, discussionId, body) => {
        const discussion = this.discussions.get(iid)?.find((candidate) => candidate.id === discussionId)
        discussion?.notes.push({
          id: `n-${randomUUID().slice(0, 8)}`,
          body,
          author: 'bot',
          system: false,
          path: null,
          line: null,
          createdAt: new Date().toISOString(),
          resolvable: true,
          resolved: false,
        })
      },
      resolveDiscussion: async (_repoId, iid, discussionId, resolved) => {
        const discussion = this.discussions.get(iid)?.find((candidate) => candidate.id === discussionId)
        for (const note of discussion?.notes ?? []) note.resolved = resolved
      },
      postNote: async (_repoId, iid, body) => {
        this.notes.push({ iid, body })
        return { noteId: `n-${randomUUID().slice(0, 8)}` }
      },
      approve: async (_repoId, iid) => {
        this.approvals.push(iid)
        return false
      },
      getCiStatus: async (_repoId, iid) => this.ciByIid.get(iid) ?? this.ci,
      merge: async (_repoId, iid) => {
        if (this.refuseMerge.has(iid)) return { merged: false, reason: 'conflicts' }
        const mr = mustGet(iid)
        this.mrs.set(iid, { ...mr, state: 'merged' })
        this.merges.push(iid)
        return { merged: true }
      },
      closeMergeRequest: async (_repoId, iid) => {
        if (this.refuseClose.has(iid)) throw new Error('close refused')
        this.mrs.set(iid, { ...mustGet(iid), state: 'closed' })
      },
      revertMergeRequest: async (repoId, iid, input) => {
        if (this.refuseRevert.has(iid)) return { reverted: false, reason: 'revert conflicts' }
        const target = mustGet(iid).targetBranch
        const mergeRequest = await this.scm(token).openMergeRequest({ ...input, repoId, sourceBranch: input.branch, targetBranch: target })
        this.revertOf.set(mergeRequest.iid, iid)
        return { reverted: true, mergeRequest }
      },
      registerWebhook: async (_repoId, input) => {
        this.webhooksRegistered.push(input.url)
        return { id: 'h1' }
      },
    }
  }

  /** What the fake Slack received, and a switch to make it fail. */
  notifications: NotificationMessage[] = []
  notifyError: Error | null = null
  channels: NotificationChannel[] = [
    { id: 'C1', name: 'engineering', private: false },
    { id: 'C2', name: 'alerts', private: true },
  ]

  notifier(): NotificationConnector {
    return {
      kind: 'slack',
      viewer: async () => ({ name: 'factorix in Acme' }),
      listChannels: async () => this.channels,
      send: async (message) => {
        if (this.notifyError) {
          const error = this.notifyError
          this.notifyError = null
          throw error
        }
        this.notifications.push(message)
        return { id: `m${this.notifications.length}`, url: `https://slack.test/m${this.notifications.length}` }
      },
    }
  }

  /** Doppler configs by `project/config`, the tokens it saw, and a switch to make it fail. */
  dopplerConfigs = new Map<string, Record<string, string>>()
  dopplerTokens: string[] = []
  dopplerError: Error | null = null

  doppler(token: string): SecretSourceConnector {
    this.dopplerTokens.push(token)
    const fail = () => {
      if (this.dopplerError) throw this.dopplerError
    }
    const projects = () => [...new Set([...this.dopplerConfigs.keys()].map((key) => key.split('/')[0] as string))]
    return {
      kind: 'doppler',
      viewer: async () => {
        fail()
        return { name: 'previews in Acme' }
      },
      listProjects: async () => {
        fail()
        return projects().map((id) => ({ id, name: id }))
      },
      listConfigs: async (project) => {
        fail()
        return [...this.dopplerConfigs.keys()]
          .filter((key) => key.startsWith(`${project}/`))
          .map((key) => ({ name: key.split('/')[1] as string, environment: null }))
      },
      fetch: async ({ project, config }) => {
        fail()
        const values = this.dopplerConfigs.get(`${project}/${config}`)
        if (!values) throw new Error('Doppler has no such project or config.')
        return { ...values }
      },
    }
  }

  factory(): ConnectorFactory {
    return {
      tracker: (_connection, secret) => this.tracker(secret),
      scm: (_connection, secret) => this.scm(secret),
      notifier: () => this.notifier(),
      secrets: (connection, secret) => (connection.kind === 'generic' ? storedSecrets(secret) : this.doppler(secret)),
    }
  }
}
