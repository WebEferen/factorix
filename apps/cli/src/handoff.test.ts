import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyDiff,
  applyRange,
  deleteRemoteBranch,
  fetchBranch,
  forgetHandoff,
  handoffBase,
  handoffBranch,
  pushSnapshot,
  pushToIssueBranch,
  rememberHandoff,
  takeSnapshot,
} from './handoff'

const IDENTITY = { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' }
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

describe('handing a checkout to an agent and taking its work back', () => {
  let dir: string
  let origin: string
  let mine: string
  let agent: string
  const saved = { ...process.env }

  beforeAll(() => {
    Object.assign(process.env, IDENTITY)
    dir = mkdtempSync(join(tmpdir(), 'fx-handoff-test-'))
    origin = join(dir, 'origin.git')
    mine = join(dir, 'mine')
    agent = join(dir, 'agent')
    git(dir, 'init', '-q', '-b', 'main', '--bare', origin)
    git(dir, 'clone', '-q', origin, mine)
    writeFileSync(join(mine, 'app.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(mine, '.gitignore'), '.env\n')
    git(mine, 'add', '-A')
    git(mine, 'commit', '-qm', 'init')
    git(mine, 'push', '-q', 'origin', 'main')
  })
  afterAll(() => {
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('sends commits, edits, and new files, leaves ignored ones, and touches nothing locally', () => {
    writeFileSync(join(mine, 'local.txt'), 'committed locally\n')
    git(mine, 'add', 'local.txt')
    git(mine, 'commit', '-qm', 'not pushed')
    writeFileSync(join(mine, 'app.txt'), 'one\ntwo edited\nthree\n')
    writeFileSync(join(mine, 'new.txt'), 'untracked\n')
    writeFileSync(join(mine, '.env'), 'SECRET=1\n')
    const before = [git(mine, 'status', '--porcelain'), git(mine, 'rev-parse', 'HEAD'), git(mine, 'stash', 'list')]

    const snapshot = takeSnapshot(mine)
    expect(snapshot.files.sort()).toEqual(['app.txt', 'new.txt'])
    expect(snapshot.unpushed).toBe(1)
    expect([git(mine, 'status', '--porcelain'), git(mine, 'rev-parse', 'HEAD'), git(mine, 'stash', 'list')]).toEqual(before)

    const branch = handoffBranch(snapshot)
    pushSnapshot(snapshot, branch)
    git(dir, 'clone', '-q', '-b', branch, origin, agent)
    expect(readFileSync(join(agent, 'app.txt'), 'utf8')).toBe('one\ntwo edited\nthree\n')
    expect(git(agent, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'app.txt', 'local.txt', 'new.txt'])
  })

  it('takes HEAD itself when nothing is uncommitted', () => {
    const clean = join(dir, 'clean')
    git(dir, 'clone', '-q', origin, clean)
    const snapshot = takeSnapshot(clean)
    expect(snapshot).toMatchObject({ commit: git(clean, 'rev-parse', 'HEAD'), files: [], unpushed: 0 })
  })

  it('applies what the agent changed, merging when the checkout moved on, and removes the branch', () => {
    const base = git(agent, 'rev-parse', 'HEAD')
    writeFileSync(join(agent, 'app.txt'), 'one\ntwo edited\nthree\nfour\n')
    writeFileSync(join(agent, 'added.txt'), 'by the agent\n')
    git(agent, 'add', '-A')
    git(agent, 'commit', '-qm', 'agent work')
    const diff = git(agent, 'diff', '--no-color', `${base}...HEAD`)

    const applied = applyDiff(mine, diff)
    expect(applied).toEqual({ files: ['added.txt', 'app.txt'], merged: false })
    expect(readFileSync(join(mine, 'app.txt'), 'utf8')).toBe('one\ntwo edited\nthree\nfour\n')
    expect(readFileSync(join(mine, 'added.txt'), 'utf8')).toBe('by the agent\n')

    git(mine, 'checkout', '-q', '--', 'app.txt')
    rmSync(join(mine, 'added.txt'))
    writeFileSync(join(mine, 'app.txt'), 'zero\none\ntwo edited\nthree\n')
    git(mine, 'add', '-A')
    git(mine, 'commit', '-qm', 'moved on')
    expect(applyDiff(mine, diff).merged).toBe(true)
    expect(readFileSync(join(mine, 'app.txt'), 'utf8')).toBe('zero\none\ntwo edited\nthree\nfour\n')

    const branch = git(agent, 'rev-parse', '--abbrev-ref', 'HEAD')
    deleteRemoteBranch(mine, branch)
    expect(git(origin, 'branch', '--list', branch)).toBe('')
  })

  it('brings back what an agent pushed through git, binary and large files included, and only what is new each time', () => {
    const work = join(dir, 'work')
    const remoteAgent = join(dir, 'remote-agent')
    git(dir, 'clone', '-q', origin, work)
    writeFileSync(join(work, 'draft.txt'), 'started locally\n')
    const snapshot = takeSnapshot(work)
    pushSnapshot(snapshot, 'factorix/ins-7-demo')
    rememberHandoff(work, 'issue-ins-7', snapshot.commit)
    expect(handoffBase(work, 'issue-ins-7')).toBe(snapshot.commit)
    expect(handoffBase(work, 'issue-ins-8')).toBeNull()

    git(dir, 'clone', '-q', '-b', 'factorix/ins-7-demo', origin, remoteAgent)
    const binary = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 31) % 256))
    writeFileSync(join(remoteAgent, 'logo.bin'), binary)
    writeFileSync(join(remoteAgent, 'big.txt'), `${'a line of generated text\n'.repeat(80_000)}`)
    writeFileSync(join(remoteAgent, 'draft.txt'), 'started locally\nfinished by the agent\n')
    git(remoteAgent, 'add', '-A')
    git(remoteAgent, 'commit', '-qm', 'agent work')
    git(remoteAgent, 'push', '-q', 'origin', 'factorix/ins-7-demo')

    const head = fetchBranch(work, 'factorix/ins-7-demo')
    const applied = applyRange(work, snapshot.commit, head)
    expect(applied).toEqual({ files: ['big.txt', 'draft.txt', 'logo.bin'], merged: false })
    expect(readFileSync(join(work, 'logo.bin')).equals(binary)).toBe(true)
    expect(readFileSync(join(work, 'big.txt')).length).toBe(25 * 80_000)
    expect(readFileSync(join(work, 'draft.txt'), 'utf8')).toBe('started locally\nfinished by the agent\n')

    rememberHandoff(work, 'issue-ins-7', head)
    expect(applyRange(work, head, fetchBranch(work, 'factorix/ins-7-demo')).files).toEqual([])
    forgetHandoff(work, 'issue-ins-7')
    expect(handoffBase(work, 'issue-ins-7')).toBeNull()
  })

  it('refuses to push over commits on an issue branch that the checkout does not have', () => {
    const behind = join(dir, 'behind')
    git(dir, 'clone', '-q', origin, behind)
    writeFileSync(join(behind, 'other.txt'), 'unrelated\n')
    expect(() => pushToIssueBranch(takeSnapshot(behind), 'factorix/ins-7-demo')).toThrow(/has commits this checkout does not/)
    expect(git(origin, 'show', 'factorix/ins-7-demo:draft.txt')).toBe('started locally\nfinished by the agent')
  })
})
