import { branchNameFor } from '@factorix/core'
import type { Db, IssueRow, RunRow, WorkspaceRow } from '@factorix/db'

export function workspaceKey(run: Pick<RunRow, 'id' | 'issueId'>): string {
  return run.issueId ?? run.id
}

export async function ensureWorkspaceRow(db: Db, run: RunRow, volume: string, mirrorVolume: string): Promise<WorkspaceRow> {
  const existing = run.issueId
    ? await db<WorkspaceRow>('workspaces').where({ issueId: run.issueId }).first()
    : run.workspaceId
      ? await db<WorkspaceRow>('workspaces').where({ id: run.workspaceId }).first()
      : undefined
  if (existing) {
    const [row] = await db<WorkspaceRow>('workspaces')
      .where({ id: existing.id })
      .update({ state: 'in_use', lastUsedAt: db.fn.now() as never })
      .returning('*')
    return row as WorkspaceRow
  }
  const [row] = await db<WorkspaceRow>('workspaces')
    .insert({ orgId: run.orgId, issueId: run.issueId, volumeName: volume, mirrorVolumeName: mirrorVolume, state: 'in_use' })
    .returning('*')
  return row as WorkspaceRow
}

export function resolveBranch(issue: Pick<IssueRow, 'branchName' | 'identifier' | 'title'>): string {
  return issue.branchName ?? branchNameFor(issue.identifier, issue.title)
}
