import type { CiResult, CiStatus, DiffRefs, MergeRequest, OpenMergeRequestInput, ScmConnector, ScmDiscussion, ScmNote, ScmRepo } from '../scm'

const LOG_TAIL_CHARS = 4000
const FAILED_JOB_LOG_LIMIT = 3
const FAILED_JOB_LIMIT = 20
const PAGE_SIZE = 100
const MAX_PAGES = 5

// biome-ignore lint/suspicious/noExplicitAny: GitHub response bodies, read field by field
type Loose = Record<string, any>

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** GitHub.com serves its API from another host, and GitHub Enterprise Server serves it under a path. */
export function githubEndpoints(host: string | undefined): { web: string; rest: string; graphql: string } {
  const web = new URL(host || 'https://github.com').origin
  if (web === 'https://github.com') return { web, rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql' }
  return { web, rest: `${web}/api/v3`, graphql: `${web}/api/graphql` }
}

function mapRepo(raw: Loose): ScmRepo {
  return {
    id: String(raw.id),
    path: raw.full_name,
    name: raw.name,
    cloneUrl: raw.clone_url,
    webUrl: raw.html_url,
    defaultBranch: raw.default_branch ?? null,
  }
}

const MERGE_BLOCKERS: Record<string, string> = {
  dirty: 'it has merge conflicts',
  behind: 'it is behind its target branch',
  blocked: 'branch protection blocks it, so a required review or check is missing',
  draft: 'it is a draft',
}

function mergeBlockerOf(raw: Loose): string | null {
  if (raw.state !== 'open') return null
  if (raw.draft) return MERGE_BLOCKERS.draft as string
  // Only a single pull request carries this, and it is "unknown" while GitHub works it out.
  return MERGE_BLOCKERS[raw.mergeable_state as string] ?? (raw.mergeable === false ? (MERGE_BLOCKERS.dirty as string) : null)
}

function mapPull(raw: Loose): MergeRequest {
  const merged = Boolean(raw.merged || raw.merged_at)
  return {
    id: String(raw.id),
    iid: raw.number,
    url: raw.html_url,
    state: merged ? 'merged' : raw.state === 'open' ? 'opened' : 'closed',
    draft: Boolean(raw.draft),
    title: raw.title,
    description: raw.body ?? null,
    sourceBranch: raw.head?.ref,
    targetBranch: raw.base?.ref,
    sha: raw.head?.sha ?? null,
    hasConflicts: raw.mergeable === false || raw.mergeable_state === 'dirty',
    mergeBlocker: mergeBlockerOf(raw),
    diffRefs: raw.base?.sha && raw.head?.sha ? { baseSha: raw.base.sha, headSha: raw.head.sha, startSha: raw.base.sha } : null,
  }
}

/*
 * GitHub numbers conversation comments, review comments, and reviews separately, so each id carries its kind:
 * c for a comment on the conversation, r for a review thread (named after its first comment), v for a review's own text.
 */
export function mapIssueComment(raw: Loose): ScmNote {
  return {
    id: `c${raw.id}`,
    body: raw.body ?? '',
    author: raw.user?.login ?? 'unknown',
    system: false,
    path: null,
    line: null,
    createdAt: raw.created_at,
    resolvable: false,
    resolved: false,
  }
}

export function mapReviewComment(raw: Loose, resolved = false): ScmNote {
  return {
    id: `r${raw.id ?? raw.databaseId}`,
    body: raw.body ?? '',
    author: raw.user?.login ?? raw.author?.login ?? 'unknown',
    system: false,
    path: raw.path ?? null,
    line: raw.line ?? raw.original_line ?? raw.originalLine ?? null,
    createdAt: raw.created_at ?? raw.createdAt,
    resolvable: true,
    resolved,
  }
}

export function mapReview(raw: Loose): ScmNote {
  return {
    id: `v${raw.id}`,
    body: raw.body ?? '',
    author: raw.user?.login ?? 'unknown',
    system: false,
    path: null,
    line: null,
    createdAt: raw.submitted_at ?? new Date().toISOString(),
    resolvable: false,
    resolved: false,
  }
}

export function mapCheckConclusion(conclusion: string | undefined | null): CiStatus {
  switch (conclusion) {
    case 'success':
    case 'neutral':
      return 'success'
    case 'skipped':
      return 'skipped'
    case 'cancelled':
    case 'stale':
      return 'canceled'
    case 'action_required':
      return 'manual'
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed'
    default:
      return 'none'
  }
}

function mapCheckRun(run: Loose): CiStatus {
  if (run.status === 'completed') return mapCheckConclusion(run.conclusion)
  return run.status === 'in_progress' ? 'running' : 'pending'
}

export function mapCommitState(state: string | undefined | null): CiStatus {
  if (state === 'success' || state === 'pending') return state
  return state === 'failure' || state === 'error' ? 'failed' : 'none'
}

/* A commit has many checks and no single pipeline. Unfinished ones win, so nobody reads a result that can still change. */
const CI_ORDER: CiStatus[] = ['running', 'pending', 'failed', 'manual', 'canceled', 'success', 'skipped']

const THREADS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) { nodes { databaseId body path line originalLine createdAt author { login } } }
        }
      }
    }
  }
}`

const REVERT_MUTATION = `mutation($id: ID!, $title: String!, $body: String!) {
  revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) { revertPullRequest { number } }
}`

export class GithubConnector implements ScmConnector {
  readonly kind = 'github' as const
  private readonly token: string
  private readonly endpoints: ReturnType<typeof githubEndpoints>

  constructor(options: { token: string; host?: string }) {
    this.token = options.token
    this.endpoints = githubEndpoints(options.host)
  }

  private async send(method: string, url: string, body?: unknown): Promise<Response> {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'factorix',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.ok) return response
    const failure = (await response.json().catch(() => ({}))) as Loose
    const details = Array.isArray(failure.errors)
      ? failure.errors.map((item: Loose | string) => (typeof item === 'string' ? item : item.message)).filter(Boolean)
      : []
    throw new GithubError([failure.message ?? `GitHub answered ${response.status}`, ...details].join(': '), response.status)
  }

  private async request(method: string, path: string, options: { query?: Record<string, string | number | undefined>; body?: unknown } = {}) {
    const url = new URL(`${this.endpoints.rest}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    const response = await this.send(method, url.toString(), options.body)
    return (response.status === 204 ? {} : await response.json()) as Loose
  }

  private async pages(path: string, query: Record<string, string | number | undefined> = {}, maxPages = MAX_PAGES): Promise<Loose[]> {
    const rows: Loose[] = []
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = (await this.request('GET', path, { query: { ...query, per_page: PAGE_SIZE, page } })) as unknown as Loose[]
      rows.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return rows
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<Loose> {
    const result = (await (await this.send('POST', this.endpoints.graphql, { query, variables })).json()) as Loose
    if (Array.isArray(result.errors) && result.errors.length > 0) throw new Error(result.errors.map((error: Loose) => error.message).join('; '))
    return result.data as Loose
  }

  /* A repository's id survives a rename or a transfer, and its path does not. */
  private repo(repoId: string): string {
    return `/repositories/${encodeURIComponent(repoId)}`
  }

  gitAuth(): { token: string; username: string } {
    return { token: this.token, username: 'x-access-token' }
  }

  async viewer(): Promise<{ id: string; username: string; name: string }> {
    const user = await this.request('GET', '/user')
    return { id: String(user.id), username: user.login, name: user.name ?? user.login }
  }

  async listRepos(search?: string): Promise<ScmRepo[]> {
    const term = search?.trim().toLowerCase()
    // GitHub cannot search what a token may reach, so this filters its most recently pushed repositories.
    const mine = await this.pages('/user/repos', { sort: 'pushed', direction: 'desc' }, term ? 3 : 1)
    const found = mine.filter((repo) => !term || String(repo.full_name).toLowerCase().includes(term))
    if (term && /^[\w.-]+\/[\w.-]+$/.test(term) && !found.some((repo) => String(repo.full_name).toLowerCase() === term)) {
      const exact = await this.request('GET', `/repos/${term}`).catch(() => undefined)
      if (exact) found.unshift(exact)
    }
    return found.slice(0, 50).map(mapRepo)
  }

  async getRepo(id: string): Promise<ScmRepo> {
    return mapRepo(await this.request('GET', this.repo(id)))
  }

  async findOpenMergeRequest(repoId: string, sourceBranch: string): Promise<MergeRequest | null> {
    const repo = await this.request('GET', this.repo(repoId))
    const list = (await this.request('GET', `${this.repo(repoId)}/pulls`, {
      query: { state: 'open', head: `${repo.owner?.login}:${sourceBranch}`, per_page: 1 },
    })) as unknown as Loose[]
    return list[0] ? this.getMergeRequest(repoId, list[0].number) : null
  }

  async openMergeRequest(input: OpenMergeRequestInput): Promise<MergeRequest> {
    return mapPull(
      await this.request('POST', `${this.repo(input.repoId)}/pulls`, {
        body: { title: input.title, body: input.description, head: input.sourceBranch, base: input.targetBranch },
      }),
    )
  }

  async updateMergeRequest(repoId: string, iid: number, change: { title?: string; description?: string }): Promise<MergeRequest> {
    return mapPull(await this.request('PATCH', `${this.repo(repoId)}/pulls/${iid}`, { body: { title: change.title, body: change.description } }))
  }

  async getMergeRequest(repoId: string, iid: number): Promise<MergeRequest> {
    return mapPull(await this.request('GET', `${this.repo(repoId)}/pulls/${iid}`))
  }

  private async threads(repoId: string, iid: number): Promise<Loose[]> {
    const pull = await this.request('GET', `${this.repo(repoId)}/pulls/${iid}`)
    const threads: Loose[] = []
    let after: string | null = null
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.graphql(THREADS_QUERY, { id: pull.node_id, after })
      const connection = data.node?.reviewThreads as Loose | undefined
      threads.push(...((connection?.nodes as Loose[]) ?? []))
      if (!connection?.pageInfo?.hasNextPage) break
      after = connection.pageInfo.endCursor
    }
    return threads
  }

  async listDiscussions(repoId: string, iid: number): Promise<ScmDiscussion[]> {
    const [comments, reviews, threads] = await Promise.all([
      this.pages(`${this.repo(repoId)}/issues/${iid}/comments`),
      this.pages(`${this.repo(repoId)}/pulls/${iid}/reviews`),
      this.threads(repoId, iid),
    ])
    const discussions: ScmDiscussion[] = comments.map((comment) => ({ id: `c${comment.id}`, notes: [mapIssueComment(comment)] }))
    for (const review of reviews) {
      if (review.state !== 'PENDING' && String(review.body ?? '').trim()) discussions.push({ id: `v${review.id}`, notes: [mapReview(review)] })
    }
    for (const thread of threads) {
      const notes = ((thread.comments?.nodes as Loose[]) ?? []).map((comment) => mapReviewComment(comment, Boolean(thread.isResolved)))
      if (notes[0]) discussions.push({ id: notes[0].id, notes })
    }
    return discussions
  }

  async postDiffDiscussion(
    repoId: string,
    iid: number,
    input: { path: string; line: number; side: 'new' | 'old'; body: string; diffRefs: DiffRefs },
  ): Promise<{ discussionId: string }> {
    const comment = await this.request('POST', `${this.repo(repoId)}/pulls/${iid}/comments`, {
      body: {
        body: input.body,
        commit_id: input.diffRefs.headSha,
        path: input.path,
        line: input.line,
        side: input.side === 'new' ? 'RIGHT' : 'LEFT',
      },
    })
    return { discussionId: `r${comment.id}` }
  }

  async replyDiscussion(repoId: string, iid: number, discussionId: string, body: string): Promise<void> {
    // Only review threads take replies. Anything else is answered on the conversation.
    if (discussionId.startsWith('r'))
      await this.request('POST', `${this.repo(repoId)}/pulls/${iid}/comments/${discussionId.slice(1)}/replies`, { body: { body } })
    else await this.postNote(repoId, iid, body)
  }

  async resolveDiscussion(repoId: string, iid: number, discussionId: string, resolved: boolean): Promise<void> {
    if (!discussionId.startsWith('r')) return
    const thread = (await this.threads(repoId, iid)).find((candidate) => `r${candidate.comments?.nodes?.[0]?.databaseId}` === discussionId)
    if (!thread) throw new Error(`No review thread ${discussionId} on pull request ${iid}`)
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
    await this.graphql(`mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { id } } }`, { id: thread.id })
  }

  async postNote(repoId: string, iid: number, body: string): Promise<{ noteId: string }> {
    const comment = await this.request('POST', `${this.repo(repoId)}/issues/${iid}/comments`, { body: { body } })
    return { noteId: `c${comment.id}` }
  }

  async approve(repoId: string, iid: number, receipt?: string): Promise<boolean> {
    const path = `${this.repo(repoId)}/pulls/${iid}/reviews`
    if (receipt && (await this.pages(path)).some((review) => review.state !== 'PENDING' && review.body?.trim() === receipt.trim())) return true
    try {
      await this.request('POST', path, { body: { event: 'APPROVE', body: receipt } })
      return true
    } catch (error) {
      // 422 is GitHub refusing an approval from the pull request's own author.
      if (error instanceof GithubError && [401, 403, 404, 422].includes(error.status)) return false
      throw error
    }
  }

  private async logTail(repoId: string, run: Loose): Promise<string | undefined> {
    const output = [run.output?.summary, run.output?.text].filter(Boolean).join('\n')
    if (run.app?.slug !== 'github-actions') return output ? output.slice(-LOG_TAIL_CHARS) : undefined
    // A check run from Actions shares its id with the job, and the log comes back as a redirect to plain text.
    const log = await this.send('GET', `${this.endpoints.rest}${this.repo(repoId)}/actions/jobs/${run.id}/logs`)
      .then((response) => response.text())
      .catch(() => output)
    return log ? log.slice(-LOG_TAIL_CHARS) : undefined
  }

  async getCiStatus(repoId: string, iid: number): Promise<CiResult> {
    const pull = await this.request('GET', `${this.repo(repoId)}/pulls/${iid}`)
    const sha: string = pull.head.sha
    const [checks, combined] = await Promise.all([
      this.request('GET', `${this.repo(repoId)}/commits/${sha}/check-runs`, { query: { filter: 'latest', per_page: PAGE_SIZE } }),
      this.request('GET', `${this.repo(repoId)}/commits/${sha}/status`, { query: { per_page: PAGE_SIZE } }),
    ])
    const runs = (checks.check_runs as Loose[]) ?? []
    const statuses = (combined.statuses as Loose[]) ?? []
    const seen = new Set([...runs.map(mapCheckRun), ...statuses.map((status) => mapCommitState(status.state))])
    const status = CI_ORDER.find((candidate) => seen.has(candidate)) ?? 'none'
    if (status === 'none') return { status, failedJobs: [] }
    const result: CiResult = { status, pipelineId: sha, webUrl: `${pull.html_url}/checks`, failedJobs: [] }
    if (status !== 'failed') return result

    const failedRuns = runs.filter((run) => mapCheckRun(run) === 'failed').slice(0, FAILED_JOB_LIMIT)
    result.failedJobs = [
      ...(await Promise.all(
        failedRuns.map(async (run, index) => ({
          name: run.name,
          stage: run.app?.name ?? 'checks',
          webUrl: run.html_url ?? run.details_url ?? '',
          logTail: index < FAILED_JOB_LOG_LIMIT ? await this.logTail(repoId, run) : undefined,
        })),
      )),
      ...statuses
        .filter((item) => mapCommitState(item.state) === 'failed')
        .map((item) => ({ name: item.context, stage: 'status', webUrl: item.target_url ?? '', logTail: item.description ?? undefined })),
    ]
    return result
  }

  async merge(
    repoId: string,
    iid: number,
    input: { sha?: string | null; squash?: boolean; removeSourceBranch?: boolean },
  ): Promise<{ merged: boolean; reason?: string }> {
    try {
      const [repo, pull] = await Promise.all([this.request('GET', this.repo(repoId)), this.request('GET', `${this.repo(repoId)}/pulls/${iid}`)])
      // A repository can switch any method off, and asking for one it refuses fails the merge.
      const allows = (method: string) => repo[`allow_${method}`] !== false
      const method =
        input.squash && allows('squash_merge') ? 'squash' : allows('merge_commit') ? 'merge' : allows('squash_merge') ? 'squash' : 'rebase'
      const merged = await this.request('PUT', `${this.repo(repoId)}/pulls/${iid}/merge`, {
        body: { sha: input.sha ?? undefined, merge_method: method },
      })
      if (!merged.merged) return { merged: false, reason: merged.message ?? 'the server refused it' }
      if ((input.removeSourceBranch ?? true) && pull.head?.repo?.id === pull.base?.repo?.id) {
        const ref = String(pull.head.ref).split('/').map(encodeURIComponent).join('/')
        await this.request('DELETE', `${this.repo(repoId)}/git/refs/heads/${ref}`).catch(() => undefined)
      }
      return { merged: true }
    } catch (error) {
      return { merged: false, reason: (error as Error).message }
    }
  }

  async closeMergeRequest(repoId: string, iid: number): Promise<void> {
    await this.request('PATCH', `${this.repo(repoId)}/pulls/${iid}`, { body: { state: 'closed' } })
  }

  /** GitHub names the revert branch itself, so the one asked for is not used. */
  async revertMergeRequest(
    repoId: string,
    iid: number,
    input: { branch: string; title: string; description: string },
  ): Promise<{ reverted: true; mergeRequest: MergeRequest } | { reverted: false; reason: string }> {
    const pull = await this.request('GET', `${this.repo(repoId)}/pulls/${iid}`)
    if (!pull.merged) return { reverted: false, reason: 'This pull request has not merged, so there is nothing to revert.' }
    try {
      const data = await this.graphql(REVERT_MUTATION, { id: pull.node_id, title: input.title, body: input.description })
      const number = data.revertPullRequest?.revertPullRequest?.number as number | undefined
      if (!number) return { reverted: false, reason: 'GitHub did not open a revert pull request.' }
      return { reverted: true, mergeRequest: await this.getMergeRequest(repoId, number) }
    } catch (error) {
      return { reverted: false, reason: (error as Error).message }
    }
  }

  async registerWebhook(repoId: string, input: { url: string; secret: string }): Promise<{ id: string }> {
    const hook = await this.request('POST', `${this.repo(repoId)}/hooks`, {
      body: {
        name: 'web',
        active: true,
        events: GITHUB_WEBHOOK_EVENTS,
        config: { url: input.url, content_type: 'json', secret: input.secret, insecure_ssl: '0' },
      },
    })
    return { id: String(hook.id) }
  }
}

export const GITHUB_WEBHOOK_EVENTS = ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment', 'check_suite', 'status']
