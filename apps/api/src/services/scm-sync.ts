import type { ScmConnector } from '@factorix/connectors'
import { isFactoryScmBody } from '@factorix/core'
import type { Db, IssueRow, MrDiscussionRow } from '@factorix/db'
import type { LinkedMergeRequest } from './repos'

function originFor(body: string, system: boolean): MrDiscussionRow['origin'] {
  if (system) return 'system'
  return isFactoryScmBody(body) ? 'factory' : 'human'
}

export async function upsertDiscussionNote(
  db: Db,
  issue: Pick<IssueRow, 'id' | 'orgId'>,
  mr: { repoId: string | null; mrIid: number },
  discussionId: string,
  note: { id: string; body: string; author: string; system: boolean; path: string | null; line: number | null; createdAt: string; resolved: boolean },
): Promise<boolean> {
  const inserted = await db('mr_discussions')
    .insert({
      orgId: issue.orgId,
      issueId: issue.id,
      repoId: mr.repoId,
      mrIid: mr.mrIid,
      discussionId,
      noteId: note.id,
      authorLogin: note.author,
      origin: originFor(note.body, note.system),
      body: note.body,
      path: note.path,
      line: note.line,
      resolved: note.resolved,
      createdAt: note.createdAt,
    })
    .onConflict(['issue_id', 'note_id'])
    .merge(['body', 'resolved'])
    .returning(db.raw('(xmax = 0) AS inserted'))
  return Boolean((inserted[0] as { inserted?: boolean } | undefined)?.inserted)
}

/** Returns human notes this mirror had not seen, so a polling sweep can behave like a webhook. */
export async function syncDiscussions(
  db: Db,
  scm: ScmConnector,
  issue: Pick<IssueRow, 'id' | 'orgId'>,
  mr: LinkedMergeRequest,
): Promise<{ newHumanNotes: number }> {
  const discussions = await scm.listDiscussions(mr.repo.scmRepoId, mr.mrIid)
  let newHumanNotes = 0
  for (const discussion of discussions) {
    for (const note of discussion.notes) {
      const inserted = await upsertDiscussionNote(db, issue, mr, discussion.id, note)
      if (inserted && originFor(note.body, note.system) === 'human') newHumanNotes += 1
    }
  }
  return { newHumanNotes }
}
