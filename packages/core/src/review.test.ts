import { describe, expect, it } from 'vitest'
import { reviewNote } from './review'

describe('reviewNote', () => {
  it('is the verdict and summary when there are no comments to list', () => {
    expect(reviewNote({ verdict: 'approve', summary: 'Looks right.' })).toBe('**Review verdict: approve**\n\nLooks right.')
  })

  it('lists findings worst first and keeps a long one inside its bullet', () => {
    const note = reviewNote({ verdict: 'request_changes', summary: 'Two problems.' }, [
      { repo: '', path: 'src/a.ts', line: 4, side: 'new', severity: 'nit', body: 'Rename this.' },
      { repo: '', path: 'src/b.ts', line: 9, side: 'new', severity: 'blocker', body: 'Drops the last row.\nSee the loop bound.\n' },
    ])
    expect(note).toBe(
      '**Review verdict: changes requested**\n\nTwo problems.\n\n**Findings**\n\n' +
        '- **blocker** `src/b.ts:9`: Drops the last row.\n  See the loop bound.\n' +
        '- **nit** `src/a.ts:4`: Rename this.',
    )
  })
})
