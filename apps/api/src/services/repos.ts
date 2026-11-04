import { type Db, type IssueMergeRequestRow, json, type ProjectRepoRow, type ProjectRow } from '@factorix/db'
import type { MergeRequestDto, ProjectRepoInput } from '@factorix/schemas'
import type { Knex } from 'knex'
import { conflict } from '../lib/errors'

export function projectRepos(db: Db | Knex.Transaction, projectId: string): Promise<ProjectRepoRow[]> {
  return db<ProjectRepoRow>('project_repos').where({ projectId }).orderBy('position')
}

export interface LinkedMergeRequest extends IssueMergeRequestRow {
  repo: ProjectRepoRow
}

export const FINISHED_MR_STATES = ['merged', 'closed']

export function isOpenMergeRequest(mr: Pick<IssueMergeRequestRow, 'mrState'>): boolean {
  return !FINISHED_MR_STATES.includes(mr.mrState)
}

/** The same shape the issue queries build, for approvals that show a chain as it stood. */
export function mergeRequestSnapshot(mr: IssueMergeRequestRow): MergeRequestDto {
  return {
    repoPath: mr.repoPath,
    iid: mr.mrIid,
    url: mr.mrUrl,
    state: mr.mrState,
    ...(mr.mergeError ? { error: mr.mergeError } : {}),
    ...(mr.revertState
      ? {
          revert: { state: mr.revertState, ...(mr.revertMrUrl ? { url: mr.revertMrUrl } : {}), ...(mr.revertError ? { error: mr.revertError } : {}) },
        }
      : {}),
  }
}

/**
 * In merge order: what the agent chose for this ticket, then the rest as the repositories were picked.
 * A repository that left the project is skipped, which is safe because leaving requires its merge request to be finished.
 */
export async function mergeRequestsOf(db: Db | Knex.Transaction, issueId: string): Promise<LinkedMergeRequest[]> {
  const rows = (await db('issue_merge_requests').where({ issueId })) as IssueMergeRequestRow[]
  if (rows.length === 0) return []
  const repos = await db<ProjectRepoRow>('project_repos')
    .whereIn(
      'id',
      rows.flatMap((row) => row.repoId ?? []),
    )
    .orderBy('position')
  return repos
    .flatMap((repo) => rows.filter((row) => row.repoId === repo.id).map((row) => ({ ...row, repo })))
    .sort((a, b) => (a.mergePosition ?? Number.MAX_SAFE_INTEGER) - (b.mergePosition ?? Number.MAX_SAFE_INTEGER))
}

export function repoFolderName(path: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = (path.split('/').pop() ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'repo'
  let name = base
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}`
  return name
}

/** Keeps each repository's row and folder name across edits, so workspaces, merge requests, and threads stay attached. */
export async function saveProjectRepos(trx: Knex.Transaction, project: Pick<ProjectRow, 'id' | 'orgId'>, inputs: ProjectRepoInput[]): Promise<void> {
  const existing = await projectRepos(trx, project.id)
  const kept = new Set(inputs.map((input) => input.scmRepoId))
  const leaving = existing.filter((repo) => !kept.has(repo.scmRepoId))
  if (leaving.length > 0) {
    const busy = (await trx('issue_merge_requests')
      .whereIn(
        'repoId',
        leaving.map((repo) => repo.id),
      )
      .whereNotIn('mrState', FINISHED_MR_STATES)
      .first()) as IssueMergeRequestRow | undefined
    if (busy) throw conflict(`${busy.repoPath} still has an open merge request. Merge or close it before removing the repository.`)
    await trx('project_repos')
      .whereIn(
        'id',
        leaving.map((repo) => repo.id),
      )
      .delete()
  }
  const names = new Set(existing.filter((repo) => kept.has(repo.scmRepoId)).map((repo) => repo.name))
  for (const [position, input] of inputs.entries()) {
    const values = { ...input, setupCommands: json(input.setupCommands), checkCommands: json(input.checkCommands), position }
    const current = existing.find((repo) => repo.scmRepoId === input.scmRepoId)
    if (current) {
      await trx('project_repos')
        .where({ id: current.id })
        .update({ ...values, updatedAt: trx.fn.now() })
      continue
    }
    const name = repoFolderName(input.scmRepoPath, names)
    names.add(name)
    await trx('project_repos').insert({ ...values, orgId: project.orgId, projectId: project.id, name })
  }
}

export function repoWebUrl(repo: Pick<ProjectRepoRow, 'scmCloneUrl'>): string {
  return repo.scmCloneUrl.replace(/\.git$/, '')
}
