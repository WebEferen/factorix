// Publishes each npm package of the repository whose shipped code changed since its last release, one patch version up.
// A version in package.json that npm does not have yet goes out as it is, so a bump made by hand wins.
// Run by .github/workflows/release.yml. `--dry-run` only prints the plan.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REGISTRY = 'https://registry.npmjs.org'
const RELEASES = [
  { dir: 'packages/plugin-sdk', publish: './dist' },
  { dir: 'apps/cli', publish: '.' },
]
// Changes here never reach the published files.
const IGNORED = [':(exclude)*.test.ts', ':(exclude)*/examples/*']
const dryRun = process.argv.includes('--dry-run')

const run = (command, args, options = {}) => {
  const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
  return typeof output === 'string' ? output.trim() : ''
}
const succeeds = (command, args) => {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

const workspaces = new Map()
for (const pattern of readJson('package.json').workspaces) {
  const root = pattern.replace(/\/\*$/, '')
  for (const entry of readdirSync(root)) {
    const file = join(root, entry, 'package.json')
    if (existsSync(file)) workspaces.set(readJson(file).name, join(root, entry))
  }
}

/** The package's folder and those of the workspaces it is built from, since the CLI bundles them. */
function sources(dir, found = new Set()) {
  if (found.has(dir)) return found
  found.add(dir)
  const pkg = readJson(join(dir, 'package.json'))
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (workspaces.has(name)) sources(workspaces.get(name), found)
  }
  return found
}

function publishedVersions(name) {
  try {
    const versions = JSON.parse(run('npm', ['view', name, 'versions', '--json', '--registry', REGISTRY], { stdio: ['ignore', 'pipe', 'pipe'] }))
    return Array.isArray(versions) ? versions : [versions]
  } catch (error) {
    if (String(error.stderr).includes('E404')) return []
    throw error
  }
}

const tagOf = (name, version) => `${name}@${version}`
const isCommit = (ref) => Boolean(ref) && succeeds('git', ['rev-parse', '--quiet', '--verify', `${ref}^{commit}`])

/** Where the published version was built from: its release tag, else the commit npm recorded for it. */
function releasedFrom(name, version) {
  const tag = `refs/tags/${tagOf(name, version)}`
  if (isCommit(tag)) return tag
  const gitHead = run('npm', ['view', `${name}@${version}`, 'gitHead', '--registry', REGISTRY])
  return isCommit(gitHead) ? gitHead : null
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`Cannot bump ${version}: set the next version by hand`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

const plan = []
for (const release of RELEASES) {
  const { name, version } = readJson(join(release.dir, 'package.json'))
  if (!publishedVersions(name).includes(version)) {
    plan.push({ ...release, name, version, bump: false })
    continue
  }
  const base = releasedFrom(name, version)
  if (base && succeeds('git', ['diff', '--quiet', base, 'HEAD', '--', ...sources(release.dir), ...IGNORED])) {
    console.log(`${name} ${version} is current`)
    continue
  }
  if (!base) console.log(`${name} ${version} has no record of the commit it came from, so it is released again`)
  plan.push({ ...release, name, version: nextPatch(version), bump: true })
}

for (const item of plan) console.log(`release ${item.name} ${item.version}${item.bump ? ' (patch bump)' : ''}`)
if (plan.length === 0 || dryRun) process.exit(0)

const bumped = plan.filter((item) => item.bump)
for (const item of bumped) {
  const file = join(item.dir, 'package.json')
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/"version": "[^"]+"/, `"version": "${item.version}"`)
  if (next === text) throw new Error(`No version field in ${file}`)
  writeFileSync(file, next)
}
if (bumped.length > 0) {
  run('git', ['add', ...bumped.map((item) => join(item.dir, 'package.json'))])
  run('git', ['commit', '--quiet', '-m', `chore: release ${bumped.map((item) => `${item.name} ${item.version}`).join(', ')}`])
}
const tags = plan.map((item) => tagOf(item.name, item.version)).filter((tag) => !isCommit(`refs/tags/${tag}`))
for (const tag of tags) run('git', ['tag', tag])

// The commit and tags land before anything is published, so a push refused because main moved publishes nothing.
const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env
const remote = GITHUB_TOKEN && GITHUB_REPOSITORY ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git` : 'origin'
const refs = [...(bumped.length > 0 ? ['HEAD:refs/heads/main'] : []), ...tags.map((tag) => `refs/tags/${tag}`)]
if (refs.length > 0) run('git', ['push', '--atomic', '--quiet', remote, ...refs])

for (const item of plan) {
  run('yarn', ['build'], { cwd: item.dir, stdio: 'inherit' })
  run('npm', ['publish', item.publish, '--access', 'public', '--registry', REGISTRY], { cwd: item.dir, stdio: 'inherit' })
}
