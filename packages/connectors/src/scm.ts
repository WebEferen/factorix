import type { Headers } from './tracker'

export interface ScmRepo {
  id: string
  path: string
  name: string
  cloneUrl: string
  webUrl: string
  defaultBranch: string | null
}

export interface DiffRefs {
  baseSha: string
  headSha: string
  startSha: string
}

export type MergeRequestState = 'opened' | 'merged' | 'closed' | 'locked'

export interface MergeRequest {
  id: string
  iid: number
  url: string
  state: MergeRequestState
  draft: boolean
  title: string
  description: string | null
  sourceBranch: string
  targetBranch: string
  sha: string | null
  hasConflicts: boolean
  /** Why the server would refuse this merge right now, in words. Null when it would accept, or is still working it out. */
  mergeBlocker: string | null
  diffRefs: DiffRefs | null
}

export type CiStatus = 'none' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual'

export interface CiResult {
  status: CiStatus
  pipelineId?: string
  webUrl?: string
  failedJobs: { name: string; stage: string; webUrl: string; logTail?: string }[]
}

export interface ScmNote {
  id: string
  body: string
  author: string
  system: boolean
  path: string | null
  line: number | null
  createdAt: string
  resolvable: boolean
  resolved: boolean
}

export interface ScmDiscussion {
  id: string
  notes: ScmNote[]
}

export type ScmWebhookEvent =
  | {
      kind: 'mr.opened' | 'mr.updated' | 'mr.merged' | 'mr.closed' | 'mr.approved'
      repoId: string
      iid: number
      url: string | null
      sourceBranch: string | null
      sha: string | null
    }
  | { kind: 'mr.note'; repoId: string; iid: number; note: ScmNote; discussionId: string }
  | { kind: 'pipeline'; repoId: string; iid: number | null; ref: string | null; sha: string | null; status: CiStatus; pipelineId: string }
  | { kind: 'ignored'; reason: string }

export interface OpenMergeRequestInput {
  repoId: string
  sourceBranch: string
  targetBranch: string
  title: string
  description: string
  removeSourceBranch?: boolean
}

export interface ScmConnector {
  readonly kind: 'gitlab'
  viewer(): Promise<{ id: string; username: string; name: string }>
  listRepos(search?: string): Promise<ScmRepo[]>
  getRepo(id: string): Promise<ScmRepo>
  /** What a token-holding step container needs. Never pass this to an agent container. */
  gitAuth(): { token: string; username: string }
  findOpenMergeRequest(repoId: string, sourceBranch: string): Promise<MergeRequest | null>
  openMergeRequest(input: OpenMergeRequestInput): Promise<MergeRequest>
  updateMergeRequest(repoId: string, iid: number, change: { title?: string; description?: string }): Promise<MergeRequest>
  getMergeRequest(repoId: string, iid: number): Promise<MergeRequest>
  listDiscussions(repoId: string, iid: number): Promise<ScmDiscussion[]>
  postDiffDiscussion(
    repoId: string,
    iid: number,
    input: { path: string; line: number; side: 'new' | 'old'; body: string; diffRefs: DiffRefs },
  ): Promise<{ discussionId: string }>
  replyDiscussion(repoId: string, iid: number, discussionId: string, body: string): Promise<void>
  resolveDiscussion(repoId: string, iid: number, discussionId: string, resolved: boolean): Promise<void>
  postNote(repoId: string, iid: number, body: string): Promise<{ noteId: string }>
  /** Resolves to false when the server refuses, which happens when the bot authored the MR. */
  approve(repoId: string, iid: number): Promise<boolean>
  getCiStatus(repoId: string, iid: number): Promise<CiResult>
  merge(
    repoId: string,
    iid: number,
    input: { sha?: string | null; squash?: boolean; removeSourceBranch?: boolean },
  ): Promise<{ merged: boolean; reason?: string }>
  closeMergeRequest(repoId: string, iid: number): Promise<void>
  /** Opens a merge request that undoes a merged one. Reverting can conflict, and that comes back as a reason, not an error. */
  revertMergeRequest(
    repoId: string,
    iid: number,
    input: { branch: string; title: string; description: string },
  ): Promise<{ reverted: true; mergeRequest: MergeRequest } | { reverted: false; reason: string }>
  registerWebhook(repoId: string, input: { url: string; secret: string }): Promise<{ id: string }>
}

export interface ScmWebhookCodec {
  deliveryId(headers: Headers, rawBody: Buffer): string
  verify(rawBody: Buffer, headers: Headers, secret: string): boolean
  parse(headers: Headers, payload: unknown): ScmWebhookEvent
}
