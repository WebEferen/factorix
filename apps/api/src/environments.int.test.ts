import { importSecretSets, matchConnections, readEnvironmentFile } from '@factorix/schemas'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SOURCE = `# Kept as typed
services:
  db:
    image: postgres:17
    ready:
      command: pg_isready -U postgres
  api:
    repo: r
    start: yarn dev
    port: 3000
    secrets: [backend, local]
    env:
      DATABASE_URL: postgres://\${services.db.host}:5432/app
    dependsOn: [db]
expose:
  service: api
agents:
  services: [db]
`

describe('project environments', () => {
  let harness: Harness
  let admin: ApiClient
  let member: ApiClient
  let projectId: string
  let doppler: string
  let stored: string
  let linear: string

  const sets = () => [
    { name: 'backend', connectionId: doppler, project: 'backend', config: 'dev', except: ['DOPPLER_PROJECT'] },
    { name: 'local', connectionId: stored, project: 'ignored', config: 'ignored', only: ['NPM_TOKEN'], agents: true },
  ]
  const url = () => `/api/projects/${projectId}/environment`

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    await admin.ok('POST', '/api/members', { name: 'Bo', email: 'bo@example.com', password: 'long enough password', role: 'member' })
    member = new ApiClient(harness.app)
    await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
    linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'lin-token' })).connection.id
    const gitlab = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'git-token', config: {} })).connection.id
    doppler = (await admin.ok('POST', '/api/connections', { kind: 'doppler', name: 'Doppler', secret: 'dp.sa.the-token' })).connection.id
    stored = (
      await admin.ok('POST', '/api/connections', {
        kind: 'generic',
        name: 'Registry',
        secret: { NPM_TOKEN: 'npm-value-123', OTHER: 'other-value-456' },
      })
    ).connection.id
    projectId = (
      await admin.ok('POST', '/api/projects', {
        name: 'App',
        trackerConnectionId: linear,
        trackerTeamId: TEAM_ID,
        trackerProjectId: null,
        scmConnectionId: gitlab,
        repos: [{ scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }],
        stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
      })
    ).project.id
  })
  afterAll(() => harness.destroy())
  beforeEach(async () => {
    await harness.deps.db('project_environments').delete()
    harness.world.dopplerConfigs = new Map([['backend/dev', { API_KEY: 'doppler-secret-value', DOPPLER_PROJECT: 'backend' }]])
    harness.world.dopplerError = null
    harness.world.dopplerTokens = []
  })

  it('starts with no environment', async () => {
    expect((await member.ok('GET', url())).environment).toMatchObject({ projectId, source: '', secretSets: [], version: 0, updatedBy: null })
  })

  it('saves the YAML as typed and sets that point at secret sources', async () => {
    const saved = (await admin.ok('PUT', url(), { source: SOURCE, secretSets: sets() })).environment
    expect(saved).toMatchObject({ source: SOURCE, version: 1, updatedBy: { name: 'Ada' } })
    expect(saved.secretSets).toEqual([
      expect.objectContaining({
        name: 'backend',
        project: 'backend',
        config: 'dev',
        agents: false,
        connectionName: 'Doppler',
        connectionKind: 'doppler',
      }),
      // An environment secret has nothing to pick inside it.
      expect.objectContaining({ name: 'local', project: null, config: null, agents: true, connectionName: 'Registry', connectionKind: 'generic' }),
    ])
    const row = await harness.deps.db('project_environments').where({ projectId }).first()
    expect(Object.keys(row.definition.services)).toEqual(['db', 'api'])
    expect((await admin.ok('PUT', url(), { source: `${SOURCE}\n# again\n`, secretSets: sets() })).environment.version).toBe(2)
  })

  it('exports a file any member can read, with no ids or values, that imports back to the same environment', async () => {
    const download = () => harness.app.inject({ method: 'GET', url: `${url()}/export`, headers: { cookie: member.cookie } })
    expect((await download()).statusCode).toBe(409)
    const saved = (await admin.ok('PUT', url(), { source: SOURCE, secretSets: sets() })).environment
    const response = await download()
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/^application\/yaml/)
    expect(response.headers['content-disposition']).toBe('attachment; filename="app-environment.yaml"')
    for (const hidden of [doppler, stored, 'npm-value-123', 'dp.sa.the-token', 'doppler-secret-value']) expect(response.body).not.toContain(hidden)

    const { file } = readEnvironmentFile(response.body)
    if (!file) throw new Error('the export did not read back')
    const chosen = matchConnections(file.secretSets, (await admin.ok('GET', '/api/connections')).connections)
    expect(chosen).toEqual({ backend: doppler, local: stored })
    await harness.deps.db('project_environments').delete()
    const imported = (await admin.ok('PUT', url(), { source: file.definition, secretSets: importSecretSets(file.secretSets, chosen) })).environment
    expect(imported.source).toBe(SOURCE)
    expect(imported.secretSets).toEqual(saved.secretSets)
  })

  it('refuses an invalid definition with the line it is on', async () => {
    const response = await admin.request('PUT', url(), {
      source: SOURCE.replace('    port: 3000', '    port: 3000\n    privileged: true'),
      secretSets: sets(),
    })
    expect(response.status).toBe(422)
    expect(response.body.error.message).toBe('Line 11: Unknown setting privileged')
    expect(response.body.error.details[0]).toMatchObject({ path: ['services', 'api', 'privileged'], line: 11 })
    expect(await harness.deps.db('project_environments').where({ projectId }).first()).toBeUndefined()
  })

  it('checks references against the project: its repositories and its secret sets', async () => {
    const response = await admin.request('PUT', url(), { source: SOURCE.replace('repo: r', 'repo: elsewhere'), secretSets: sets().slice(0, 1) })
    expect(response.status).toBe(422)
    expect(response.body.error.details.map((issue: { message: string }) => issue.message)).toEqual([
      'This project has no repository named elsewhere.',
      'There is no secret set named local. Add it under Secret sets.',
    ])
  })

  it('only accepts secret sources for sets', async () => {
    const response = await admin.request('PUT', url(), { source: '', secretSets: [{ name: 'backend', connectionId: linear }] })
    expect(response.status).toBe(400)
    expect(response.body.error.message).toBe('Secret set backend needs a Doppler or environment-secret connection')
  })

  it('keeps secret sets with no services yet', async () => {
    await admin.ok('PUT', url(), { source: '', secretSets: sets() })
    const row = await harness.deps.db('project_environments').where({ projectId }).first()
    expect(row.definition).toBeNull()
    expect(row.secretSets).toHaveLength(2)
  })

  it('lets only admins change or test it', async () => {
    expect((await member.request('PUT', url(), { source: SOURCE, secretSets: sets() })).status).toBe(403)
    expect((await member.request('POST', `${url()}/test`, { source: SOURCE, secretSets: sets() })).status).toBe(403)
    expect((await member.request('GET', `/api/secret-sources/${doppler}/projects`)).status).toBe(403)
  })

  it('tests every set and shows key names, never values', async () => {
    const result = await admin.ok('POST', `${url()}/test`, { source: SOURCE, secretSets: sets() })
    expect(result).toEqual({
      issues: [],
      sets: [
        { name: 'backend', ok: true, message: null, keys: ['API_KEY'] },
        { name: 'local', ok: true, message: null, keys: ['NPM_TOKEN'] },
      ],
    })
    expect(harness.world.dopplerTokens).toEqual(['dp.sa.the-token'])
    for (const value of ['doppler-secret-value', 'npm-value-123', 'other-value-456', 'dp.sa.the-token'])
      expect(JSON.stringify(result)).not.toContain(value)
  })

  it('reports a set that cannot be read without failing the others', async () => {
    const missing = sets().map((set) => (set.name === 'backend' ? { ...set, config: 'prd' } : set))
    const result = await admin.ok('POST', `${url()}/test`, { source: SOURCE, secretSets: missing })
    expect(result.sets).toEqual([
      { name: 'backend', ok: false, message: 'Doppler has no such project or config.', keys: [] },
      { name: 'local', ok: true, message: null, keys: ['NPM_TOKEN'] },
    ])
  })

  it('lists what a Doppler token can read, for the pickers', async () => {
    harness.world.dopplerConfigs.set('backend/prd', {})
    harness.world.dopplerConfigs.set('frontend/dev', {})
    expect((await admin.ok('GET', `/api/secret-sources/${doppler}/projects`)).projects.map((project: { id: string }) => project.id)).toEqual([
      'backend',
      'frontend',
    ])
    expect(
      (await admin.ok('GET', `/api/secret-sources/${doppler}/configs?project=backend`)).configs.map((config: { id: string }) => config.id),
    ).toEqual(['dev', 'prd'])
    expect((await admin.ok('GET', `/api/secret-sources/${stored}/projects`)).projects).toBeNull()
    expect((await admin.request('GET', `/api/secret-sources/${linear}/projects`)).status).toBe(400)
  })

  it('tests a Doppler connection like any other integration', async () => {
    expect(await admin.ok('POST', `/api/connections/${doppler}/test`)).toEqual({ ok: true, message: 'Connected to Doppler as previews in Acme' })
    harness.world.dopplerError = new Error('Doppler rejected the token.')
    expect(await admin.ok('POST', `/api/connections/${doppler}/test`)).toEqual({ ok: false, message: 'Doppler rejected the token.' })
  })

  it('audits changes by name, without values', async () => {
    await admin.ok('PUT', url(), { source: SOURCE, secretSets: sets() })
    const entry = await harness.deps.db('audit_log').where({ action: 'environment.updated', targetId: projectId }).orderBy('ts', 'desc').first()
    expect(entry.metadata).toMatchObject({ version: 1, services: ['db', 'api'] })
    expect(entry.metadata.secretSets.map((set: { name: string }) => set.name)).toEqual(['backend', 'local'])
    for (const value of ['doppler-secret-value', 'npm-value-123', 'dp.sa.the-token']) expect(JSON.stringify(entry.metadata)).not.toContain(value)
  })
})
