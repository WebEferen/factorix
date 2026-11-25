/** What the checkout found when it tried merging the base branch into the issue branch, for one repository. */
export interface BaseConflict {
  repo: string
  base: string
  count: number
  /** The first of them. The checkout lists at most 50. */
  paths: string[]
}

const MAX_PATHS = 50

export function readBaseConflict(values: Record<string, string>, repo: { name: string; baseBranch: string }): BaseConflict | null {
  const count = Number(values.BASE_CONFLICTS)
  if (!Number.isInteger(count) || count <= 0) return null
  let paths: string[] = []
  try {
    const parsed: unknown = JSON.parse(values.BASE_CONFLICT_PATHS ?? '[]')
    if (Array.isArray(parsed)) paths = parsed.filter((path): path is string => typeof path === 'string').slice(0, MAX_PATHS)
  } catch {
    // The count alone is enough to act on.
  }
  return { repo: repo.name, base: repo.baseBranch, count, paths }
}

/** For every run that pushes to the issue branch, so no merge request is handed over while it conflicts with its base. */
export function baseConflictNote(branch: string, conflicts: BaseConflict[], several: boolean): string {
  const lines = conflicts.map((conflict) => {
    const files = conflict.count === 1 ? '1 file' : `${conflict.count} files`
    const more = conflict.count > conflict.paths.length ? `, and ${conflict.count - conflict.paths.length} more` : ''
    // File names come from the repository, so each one is quoted and cannot pass for anything else in the prompt.
    const listed = conflict.paths.map((path) => JSON.stringify(path)).join(', ')
    return `- ${several ? `${conflict.repo}/: ` : ''}git merge origin/${conflict.base} conflicts in ${files}${listed ? `: ${listed}` : ''}${more}`
  })
  return `The base branch moved on, and merging it into ${branch} now conflicts:\n${lines.join('\n')}\nBefore you finish, run that merge, resolve every conflict so that both sides keep working, run the checks, and commit the merge. Use git merge, never rebase or force push: the factory pushes without force, so rewritten history cannot land.`
}
