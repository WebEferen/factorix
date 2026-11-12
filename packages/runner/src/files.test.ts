import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeIssueFiles } from './files'

describe('writeIssueFiles', () => {
  it('replaces what an earlier run left and skips names that would leave the folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'issue-files-'))
    const dir = join(root, 'issue-files')
    mkdirSync(dir)
    writeFileSync(join(dir, 'old.txt'), 'stale')
    const content = (text: string) => Buffer.from(text).toString('base64')
    const written = writeIssueFiles(
      [
        { name: '1-spec.txt', content: content('the spec') },
        { name: '../escape.txt', content: content('no') },
        { name: '.hidden', content: content('no') },
      ],
      dir,
    )
    expect(written).toEqual(['1-spec.txt'])
    expect(readdirSync(dir)).toEqual(['1-spec.txt'])
    expect(readFileSync(join(dir, '1-spec.txt'), 'utf8')).toBe('the spec')
    expect(existsSync(join(root, 'escape.txt'))).toBe(false)
  })
})
