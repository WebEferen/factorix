import { SCM_SOURCES, type SourceMarkup, TRACKER_SOURCES } from '@factorix/connectors'
import type { ConnectionRow, IssueRow, ProjectRepoRow, ProjectRow } from '@factorix/db'
import type { MergeRequestDto } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { repoWebUrl } from './repos'

export interface IssueTextFormatters {
  tracker(text: string): string
  /** Written on a merge request, so its short references resolve against that repository. */
  scm(text: string, repoId: string | null): string
}

const PASS_THROUGH: SourceMarkup = {
  toMarkdown: (text) => text,
  isMediaUrl: () => false,
  linkReferences: (markdown) => markdown,
  issueReferences: () => [],
}

/**
 * Text is read by the source that wrote it, then every source the project uses links its own references. So a merge
 * request mentioned in a Linear ticket and a ticket mentioned in a GitLab thread both become links.
 */
export async function issueTextFormatters(
  deps: Pick<AppDeps, 'db'>,
  input: {
    orgId: string
    issue: Pick<IssueRow, 'id' | 'trackerUrl'>
    project: ProjectRow
    repos: ProjectRepoRow[]
    mergeRequests: MergeRequestDto[]
    connections: ConnectionRow[]
    texts: string[]
  },
): Promise<IssueTextFormatters> {
  const { db } = deps
  const kindOf = (id: string) => input.connections.find((connection) => connection.id === id)?.kind
  const tracker = TRACKER_SOURCES[kindOf(input.project.trackerConnectionId) as keyof typeof TRACKER_SOURCES]?.markup ?? PASS_THROUGH
  const scm = SCM_SOURCES[kindOf(input.project.scmConnectionId) as keyof typeof SCM_SOURCES]?.markup ?? PASS_THROUGH

  const referenced = [...new Set(input.texts.flatMap((text) => tracker.issueReferences(text)))]
  const mirrored = (
    referenced.length > 0
      ? await db('issues').where({ orgId: input.orgId }).whereIn('identifier', referenced).orderBy('created_at').select('id', 'identifier')
      : []
  ) as Pick<IssueRow, 'id' | 'identifier'>[]
  const internal = new Map(mirrored.map((row) => [row.identifier, `/issues/${row.id}`]))
  const issueKeys = referenced.length
    ? (await db('issues').where({ orgId: input.orgId }).select(db.raw(`DISTINCT split_part(identifier, '-', 1) AS key`))).map(
        (row: { key: string }) => row.key,
      )
    : []

  const issueUrl = (identifier: string) => {
    const known = internal.get(identifier)
    if (known) return known
    const external = input.issue.trackerUrl?.replace(/\/issue\/[^/]+.*$/, `/issue/${identifier}`)
    return external && external !== input.issue.trackerUrl ? external : undefined
  }
  const primary = input.repos[0]
  const baseUrl = primary ? repoWebUrl(primary) : undefined
  const siblings = input.repos.map((repo) => repo.name)
  const known = new Map(input.mergeRequests.map((mr) => [String(mr.iid), mr.url]))
  const media = (url: string) => `/api/issues/${input.issue.id}/media?url=${encodeURIComponent(url)}`

  return {
    tracker: (text) =>
      scm.linkReferences(tracker.linkReferences(tracker.toMarkdown(text, { media, issueUrl }), { issueKeys, issueUrl }), {
        baseUrl,
        foreign: true,
        siblings,
        mergeRequestUrl: (iid) => known.get(iid),
      }),
    scm: (text, repoId) => {
      const repo = input.repos.find((candidate) => candidate.id === repoId) ?? primary
      const own = repo ? repoWebUrl(repo) : undefined
      return tracker.linkReferences(scm.linkReferences(scm.toMarkdown(text, { baseUrl: own }), { baseUrl: own }), {
        issueKeys,
        issueUrl,
        foreign: true,
      })
    },
  }
}
