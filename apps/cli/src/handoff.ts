import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageError } from './ops'

export const HANDOFF_BRANCH = 'factorix/handoff-'
/** Factorix keeps this much of a run's diff. One that long was cut and will not apply. */
const MAX_DIFF_CHARS = 1_000_000

function git(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      input: options.input,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    throw new UsageError(stderr || `git ${args[0]} failed.`)
  }
}

export interface Snapshot {
  root: string
  /** The checkout as it is now: HEAD, plus one commit holding everything not committed, when there is any. */
  commit: string
  /** Files that differ from HEAD, untracked ones included. Ignored files are left out. */
  files: string[]
  /** Commits on HEAD that origin does not have. */
  unpushed: number
}

/** Records the working tree as a commit without touching the index, the branch, or any file. */
export function takeSnapshot(cwd: string): Snapshot {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const head = git(root, ['rev-parse', 'HEAD'])
  const scratch = mkdtempSync(join(tmpdir(), 'fx-handoff-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') }
    git(root, ['read-tree', 'HEAD'], { env })
    git(root, ['add', '-A'], { env })
    const tree = git(root, ['write-tree'], { env })
    const changed = tree !== git(root, ['rev-parse', 'HEAD^{tree}'])
    const commit = changed ? git(root, ['commit-tree', tree, '-p', head, '-m', 'Handoff: work in progress']) : head
    const files = changed ? git(root, ['diff', '--name-only', head, commit]).split('\n').filter(Boolean) : []
    const unpushed = Number(git(root, ['rev-list', '--count', head, '--not', '--remotes=origin']))
    return { root, commit, files, unpushed }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export const handoffBranch = (snapshot: Snapshot) => `${HANDOFF_BRANCH}${snapshot.commit.slice(0, 12)}`

export function pushSnapshot(snapshot: Snapshot, branch: string): void {
  git(snapshot.root, ['push', '--quiet', 'origin', `${snapshot.commit}:refs/heads/${branch}`])
}

/** The issue's branch may already hold an agent's commits, which a push must never drop. */
export function pushToIssueBranch(snapshot: Snapshot, branch: string): void {
  try {
    pushSnapshot(snapshot, branch)
  } catch (error) {
    if (!/rejected|non-fast-forward|fetch first/.test((error as Error).message)) throw error
    throw new UsageError(
      `${branch} on origin has commits this checkout does not. Bring them in first: git pull origin ${branch}, or fx pull if you handed this issue off from here.`,
    )
  }
}

export function deleteRemoteBranch(cwd: string, branch: string): void {
  git(cwd, ['push', '--quiet', 'origin', '--delete', branch])
}

export const repoRoot = (cwd: string) => git(cwd, ['rev-parse', '--show-toplevel'])
const handoffRef = (key: string) => `refs/factorix/handoff/${key}`

/** Keeps what was handed off, so the work coming back can be compared with it, and so git does not collect it meanwhile. */
export function rememberHandoff(root: string, key: string, commit: string): void {
  git(root, ['update-ref', handoffRef(key), commit])
}

export function handoffBase(root: string, key: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', handoffRef(key)])
  } catch {
    return null
  }
}

export function forgetHandoff(root: string, key: string): void {
  git(root, ['update-ref', '-d', handoffRef(key)])
}

export function fetchBranch(root: string, branch: string): string {
  git(root, ['fetch', '--quiet', 'origin', `refs/heads/${branch}`])
  return git(root, ['rev-parse', 'FETCH_HEAD'])
}

function applyFile(root: string, args: string[], input?: string): boolean {
  try {
    git(root, ['apply', '--whitespace=nowarn', ...args], { input })
    return false
  } catch {
    git(root, ['apply', '--3way', '--whitespace=nowarn', ...args], { input })
    return true
  }
}

/**
 * Puts what changed between two commits into the working tree, through git itself, so size and binary files do not matter.
 * A checkout that moved on since the handoff gets a three-way merge, which also stages.
 */
export function applyRange(root: string, base: string, head: string): { files: string[]; merged: boolean } {
  const files = git(root, ['diff', '--name-only', base, head]).split('\n').filter(Boolean)
  if (files.length === 0) return { files, merged: false }
  const scratch = mkdtempSync(join(tmpdir(), 'fx-pull-'))
  try {
    const patch = join(scratch, 'changes.patch')
    git(root, ['diff', '--binary', `--output=${patch}`, base, head])
    return { files, merged: applyFile(root, [patch]) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** For a run that pushed nothing: the diff Factorix kept, which is text only and cut at a size. */
export function applyDiff(cwd: string, diff: string): { files: string[]; merged: boolean } {
  if (diff.length >= MAX_DIFF_CHARS) throw new UsageError('This diff is too large for Factorix to keep whole, so it cannot be applied.')
  const root = repoRoot(cwd)
  const input = diff.endsWith('\n') ? diff : `${diff}\n`
  const files = git(root, ['apply', '--numstat', '-'], { input })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[2] ?? line)
  return { files, merged: applyFile(root, ['-'], input) }
}
