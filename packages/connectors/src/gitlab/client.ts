import { Gitlab } from '@gitbeaker/rest'
import type {
  CiResult,
  CiStatus,
  DiffRefs,
  MergeRequest,
  MergeRequestState,
  OpenMergeRequestInput,
  ScmConnector,
  ScmDiscussion,
  ScmNote,
  ScmRepo,
} from '../scm'

const LOG_TAIL_CHARS = 4000
const FAILED_JOB_LOG_LIMIT = 3

/* gitbeaker's generics make each schema a deep union. Everything is narrowed here at the boundary. */
// biome-ignore lint/suspicious/noExplicitAny: GitLab response bodies, read field by field
type Loose = Record<string, any>

function mapRepo(raw: Loose): ScmRepo {
  return {
    id: String(raw.id),
    path: raw.path_with_namespace,
    name: raw.name,
    cloneUrl: raw.http_url_to_repo,
    webUrl: raw.web_url,
    defaultBranch: raw.default_branch ?? null,
  }
}

function mapDiffRefs(raw: Loose | null | undefined): DiffRefs | null {
  if (!raw?.base_sha || !raw.head_sha || !raw.start_sha) return null
  return { baseSha: raw.base_sha, headSha: raw.head_sha, startSha: raw.start_sha }
}

function mapMr(raw: Loose): MergeRequest {
  return {
    id: String(raw.id),
    iid: raw.iid,
    url: raw.web_url,
    state: raw.state as MergeRequestState,
    draft: Boolean(raw.draft ?? raw.work_in_progress),
    title: raw.title,
    description: raw.description ?? null,
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    sha: raw.sha ?? null,
    hasConflicts: Boolean(raw.has_conflicts),
    diffRefs: mapDiffRefs(raw.diff_refs),
  }
}

export function mapNote(raw: Loose): ScmNote {
  const position = raw.position as Loose | undefined
  return {
    id: String(raw.id),
    body: raw.body ?? raw.note ?? '',
    author: raw.author?.username ?? 'unknown',
    system: Boolean(raw.system),
    path: position?.new_path ?? position?.old_path ?? null,
    line: position?.new_line ?? position?.old_line ?? null,
    createdAt: raw.created_at,
    resolvable: Boolean(raw.resolvable),
    resolved: Boolean(raw.resolved),
  }
}

export function mapCiStatus(status: string | undefined | null): CiStatus {
  switch (status) {
    case 'success':
    case 'failed':
    case 'canceled':
    case 'skipped':
    case 'manual':
    case 'running':
      return status
    case 'canceling':
      return 'canceled'
    case 'created':
    case 'pending':
    case 'preparing':
    case 'scheduled':
    case 'waiting_for_resource':
    case 'waiting_for_callback':
      return 'pending'
    default:
      return 'none'
  }
}

export class GitlabConnector implements ScmConnector {
  readonly kind = 'gitlab' as const
  private readonly api: InstanceType<typeof Gitlab<false>>
  private readonly token: string

  constructor(options: { token: string; host?: string }) {
    this.token = options.token
    this.api = new Gitlab({ token: options.token, host: options.host ?? 'https://gitlab.com' })
  }

  gitAuth(): { token: string; username: string } {
    return { token: this.token, username: 'oauth2' }
  }

  async viewer(): Promise<{ id: string; username: string; name: string }> {
    const user = (await this.api.Users.showCurrentUser()) as Loose
    return { id: String(user.id), username: user.username, name: user.name }
  }

  async listRepos(search?: string): Promise<ScmRepo[]> {
    const projects = (await this.api.Projects.all({
      membership: true,
      search,
      orderBy: 'last_activity_at',
      sort: 'desc',
      perPage: 50,
      maxPages: 1,
      pagination: 'offset',
    })) as unknown as Loose[]
    return projects.map(mapRepo)
  }

  async getRepo(id: string): Promise<ScmRepo> {
    return mapRepo((await this.api.Projects.show(id)) as Loose)
  }

  async findOpenMergeRequest(repoId: string, sourceBranch: string): Promise<MergeRequest | null> {
    const list = (await this.api.MergeRequests.all({
      projectId: repoId,
      sourceBranch,
      state: 'opened',
      perPage: 1,
      maxPages: 1,
    })) as unknown as Loose[]
    return list[0] ? this.getMergeRequest(repoId, list[0].iid) : null
  }

  async openMergeRequest(input: OpenMergeRequestInput): Promise<MergeRequest> {
    const created = (await this.api.MergeRequests.create(input.repoId, input.sourceBranch, input.targetBranch, input.title, {
      description: input.description,
      removeSourceBranch: input.removeSourceBranch ?? true,
    })) as Loose
    return mapMr(created)
  }

  async updateMergeRequest(repoId: string, iid: number, change: { title?: string; description?: string }): Promise<MergeRequest> {
    return mapMr((await this.api.MergeRequests.edit(repoId, iid, change)) as Loose)
  }

  async getMergeRequest(repoId: string, iid: number): Promise<MergeRequest> {
    return mapMr((await this.api.MergeRequests.show(repoId, iid)) as Loose)
  }

  async listDiscussions(repoId: string, iid: number): Promise<ScmDiscussion[]> {
    const discussions = (await this.api.MergeRequestDiscussions.all(repoId, iid, { perPage: 100, maxPages: 5 })) as unknown as Loose[]
    return discussions.map((discussion) => ({ id: discussion.id, notes: ((discussion.notes as Loose[]) ?? []).map(mapNote) }))
  }

  async postDiffDiscussion(
    repoId: string,
    iid: number,
    input: { path: string; line: number; side: 'new' | 'old'; body: string; diffRefs: DiffRefs },
  ): Promise<{ discussionId: string }> {
    const position = {
      positionType: 'text',
      baseSha: input.diffRefs.baseSha,
      headSha: input.diffRefs.headSha,
      startSha: input.diffRefs.startSha,
      newPath: input.path,
      oldPath: input.path,
      ...(input.side === 'new' ? { newLine: input.line } : { oldLine: input.line }),
    }
    const discussion = (await this.api.MergeRequestDiscussions.create(repoId, iid, input.body, { position } as never)) as Loose
    return { discussionId: discussion.id }
  }

  async replyDiscussion(repoId: string, iid: number, discussionId: string, body: string): Promise<void> {
    await this.api.MergeRequestDiscussions.addNote(repoId, iid, discussionId, body)
  }

  async resolveDiscussion(repoId: string, iid: number, discussionId: string, resolved: boolean): Promise<void> {
    await this.api.MergeRequestDiscussions.resolve(repoId, iid, discussionId, resolved)
  }

  async postNote(repoId: string, iid: number, body: string): Promise<{ noteId: string }> {
    const note = (await this.api.MergeRequestNotes.create(repoId, iid, body)) as Loose
    return { noteId: String(note.id) }
  }

  async approve(repoId: string, iid: number): Promise<boolean> {
    try {
      await this.api.MergeRequestApprovals.approve(repoId, iid)
      return true
    } catch (error) {
      const status = (error as { cause?: { response?: { status?: number } } }).cause?.response?.status
      if (status === 401 || status === 403 || status === 404 || status === 405) return false
      throw error
    }
  }

  async getCiStatus(repoId: string, iid: number): Promise<CiResult> {
    const pipelines = (await this.api.MergeRequests.allPipelines(repoId, iid)) as unknown as Loose[]
    const latest = pipelines[0]
    if (!latest) return { status: 'none', failedJobs: [] }
    const status = mapCiStatus(latest.status)
    const result: CiResult = { status, pipelineId: String(latest.id), webUrl: latest.web_url, failedJobs: [] }
    if (status !== 'failed') return result

    const jobs = (await this.api.Jobs.all(repoId, {
      pipelineId: latest.id,
      scope: 'failed',
      perPage: 20,
      maxPages: 1,
    } as never)) as unknown as Loose[]
    result.failedJobs = await Promise.all(
      jobs.map(async (job, index) => {
        let logTail: string | undefined
        if (index < FAILED_JOB_LOG_LIMIT) {
          const log = await this.api.Jobs.showLog(repoId, job.id).catch(() => undefined)
          if (typeof log === 'string') logTail = log.slice(-LOG_TAIL_CHARS)
        }
        return { name: job.name, stage: job.stage, webUrl: job.web_url, logTail }
      }),
    )
    return result
  }

  async merge(
    repoId: string,
    iid: number,
    input: { sha?: string | null; squash?: boolean; removeSourceBranch?: boolean },
  ): Promise<{ merged: boolean; reason?: string }> {
    try {
      const merged = (await this.api.MergeRequests.merge(repoId, iid, {
        sha: input.sha ?? undefined,
        squash: input.squash,
        shouldRemoveSourceBranch: input.removeSourceBranch ?? true,
      })) as Loose
      return { merged: merged.state === 'merged', reason: merged.state === 'merged' ? undefined : `merge request is ${merged.state}` }
    } catch (error) {
      const description = (error as { cause?: { description?: string } }).cause?.description
      return { merged: false, reason: description ?? (error as Error).message }
    }
  }

  async registerWebhook(repoId: string, input: { url: string; secret: string }): Promise<{ id: string }> {
    const hook = (await this.api.ProjectHooks.add(repoId, input.url, {
      mergeRequestsEvents: true,
      noteEvents: true,
      pipelineEvents: true,
      pushEvents: false,
      token: input.secret,
      enableSslVerification: true,
    } as never)) as Loose
    return { id: String(hook.id) }
  }
}
