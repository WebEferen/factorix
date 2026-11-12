import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RunFile } from '@factorix/runtime'

/** Replaces the folder's contents with these files. Names come from tracker titles, so anything but a plain name is skipped. */
export function writeIssueFiles(files: RunFile[], dir: string): string[] {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const file of files) {
    if (basename(file.name) !== file.name || file.name.startsWith('.')) continue
    writeFileSync(join(dir, file.name), Buffer.from(file.content, 'base64'), { mode: 0o644 })
    written.push(file.name)
  }
  return written
}
