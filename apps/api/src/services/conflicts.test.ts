import { describe, expect, it } from 'vitest'
import { baseConflictNote, readBaseConflict } from './conflicts'

const repo = { name: 'web', baseBranch: 'main' }

describe('conflicts with the base branch found at checkout', () => {
  it('reads the count and the listed files', () => {
    expect(readBaseConflict({ BASE_CONFLICTS: '2', BASE_CONFLICT_PATHS: '["a.ts","b.ts"]' }, repo)).toEqual({
      repo: 'web',
      base: 'main',
      count: 2,
      paths: ['a.ts', 'b.ts'],
    })
  })

  it('finds nothing without a count, and acts on the count when the list is unreadable', () => {
    expect(readBaseConflict({}, repo)).toBeNull()
    expect(readBaseConflict({ BASE_CONFLICTS: '0' }, repo)).toBeNull()
    expect(readBaseConflict({ BASE_CONFLICTS: 'x' }, repo)).toBeNull()
    expect(readBaseConflict({ BASE_CONFLICTS: '3', BASE_CONFLICT_PATHS: '["a.ts",' }, repo)).toMatchObject({ count: 3, paths: [] })
    expect(readBaseConflict({ BASE_CONFLICTS: '1', BASE_CONFLICT_PATHS: '[1,"a.ts",{}]' }, repo)).toMatchObject({ paths: ['a.ts'] })
  })

  it('tells the agent to merge the base in, names the files, and forbids rewriting history', () => {
    const note = baseConflictNote('factorix/abc-1', [{ repo: 'web', base: 'main', count: 3, paths: ['a.ts', 'odd\nname'] }], false)
    expect(note).toContain('git merge origin/main conflicts in 3 files: "a.ts", "odd\\nname", and 1 more')
    expect(note).toContain('factorix/abc-1')
    expect(note).toContain('never rebase or force push')
    expect(note).not.toContain('web/')
  })

  it('names the folder of each repository when there are several', () => {
    const note = baseConflictNote(
      'factorix/abc-1',
      [
        { repo: 'web', base: 'main', count: 1, paths: ['a.ts'] },
        { repo: 'api', base: 'dev', count: 1, paths: ['b.ts'] },
      ],
      true,
    )
    expect(note).toContain('- web/: git merge origin/main conflicts in 1 file: "a.ts"')
    expect(note).toContain('- api/: git merge origin/dev conflicts in 1 file: "b.ts"')
  })
})
