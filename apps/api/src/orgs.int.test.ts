import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { resolveModelProvider } from './services/connections'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }
const BO = { name: 'Bo', email: 'bo@example.com', password: 'long enough password' }

describe('organizations', () => {
  let harness: Harness
  let ada: ApiClient
  let bo: ApiClient
  let acmeId: string
  let betaId: string
  let acmeConnectionId: string

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    ada = new ApiClient(harness.app)
    bo = new ApiClient(harness.app)
    await ada.ok('POST', '/api/auth/setup', SETUP)
  })
  afterAll(() => harness.destroy())

  it('make whoever set the installation up its admin, in one organization', async () => {
    const me = await ada.ok('GET', '/api/auth/me')
    acmeId = me.org.id
    expect(me).toMatchObject({ installationAdmin: true, org: { name: 'Acme' }, orgs: [{ id: acmeId, name: 'Acme', slug: 'acme', role: 'admin' }] })
  })

  it('are made by an installation admin, who becomes the admin of each, with the usual agents', async () => {
    const { org } = await ada.ok('POST', '/api/orgs', { name: 'Beta' })
    betaId = org.id
    expect(org).toMatchObject({ name: 'Beta', slug: 'beta' })
    expect((await ada.ok('POST', '/api/orgs', { name: 'Beta' })).org.slug).toBe('beta-2')
    const me = await ada.ok('GET', '/api/auth/me')
    expect(me.org.id).toBe(acmeId)
    expect(me.orgs.map((entry: { name: string }) => entry.name)).toEqual(['Acme', 'Beta', 'Beta'])
    expect((await ada.ok('GET', '/api/orgs')).orgs.find((entry: { id: string }) => entry.id === betaId)).toMatchObject({
      memberCount: 1,
      projectCount: 0,
    })
  })

  it('show only their own data after a switch', async () => {
    const created = await ada.ok('POST', '/api/connections', { kind: 'anthropic', name: 'Acme key', secret: 'sk-acme' })
    acmeConnectionId = created.connection.id
    const acmeAgents = (await ada.ok('GET', '/api/agents')).agents.map((agent: { id: string }) => agent.id)

    await ada.ok('POST', '/api/auth/switch', { orgId: betaId })
    expect((await ada.ok('GET', '/api/auth/me')).org).toMatchObject({ id: betaId, name: 'Beta' })
    expect((await ada.ok('GET', '/api/connections')).connections).toEqual([])
    expect((await ada.request('PUT', `/api/connections/${acmeConnectionId}`, { name: 'Taken' })).status).toBe(404)
    const betaAgents = (await ada.ok('GET', '/api/agents')).agents
    expect(betaAgents.map((agent: { handle: string }) => agent.handle)).toEqual(['engineer-1', 'reviewer-1'])
    expect(betaAgents.some((agent: { id: string }) => acmeAgents.includes(agent.id))).toBe(false)
    expect((await ada.request('GET', `/api/agents/${acmeAgents[0]}`)).status).toBe(404)
  })

  it('follow a link into another organization the person is in, and nowhere else', async () => {
    const [acmeAgent] = await harness.deps.db('agents').where({ orgId: acmeId }).pluck('account_id')
    expect((await ada.request('GET', `/api/agents/${acmeAgent}`)).status).toBe(404)
    expect(await ada.ok('POST', '/api/auth/follow', { kind: 'agents', id: acmeAgent })).toMatchObject({ switched: true, org: { name: 'Acme' } })
    expect((await ada.ok('GET', `/api/agents/${acmeAgent}`)).agent.id).toBe(acmeAgent)
    expect(await ada.ok('POST', '/api/auth/follow', { kind: 'agents', id: acmeAgent })).toEqual({ switched: false })

    const [outside] = await harness.deps.db('organizations').insert({ name: 'Outside', slug: 'outside' }).returning('id')
    const [foreign] = await harness.deps.db('workflows').insert({ orgId: outside.id, name: 'Theirs', definition: '{}' }).returning('id')
    const missing = await ada.request('POST', '/api/auth/follow', { kind: 'workflows', id: '11111111-2222-4333-8444-555555555555' })
    const notMine = await ada.request('POST', '/api/auth/follow', { kind: 'workflows', id: foreign.id })
    expect(missing.status).toBe(404)
    expect(notMine.body).toEqual(missing.body)
    expect((await ada.ok('GET', '/api/auth/me')).org.id).toBe(acmeId)
    await harness.deps.db('organizations').where({ id: outside.id }).delete()
    await ada.ok('POST', '/api/auth/switch', { orgId: betaId })
  })

  it('land a new sign-in where the person last worked', async () => {
    const again = new ApiClient(harness.app)
    await again.ok('POST', '/api/auth/login', { email: SETUP.email, password: SETUP.password })
    expect((await again.ok('GET', '/api/auth/me')).org.id).toBe(betaId)
    await ada.ok('POST', '/api/auth/switch', { orgId: acmeId })
    expect((await again.ok('GET', '/api/auth/me')).org.id).toBe(betaId)
  })

  it('refuse a switch to one the person is not in', async () => {
    await ada.ok('POST', '/api/members', { ...BO, role: 'member' })
    await bo.ok('POST', '/api/auth/login', { email: BO.email, password: BO.password })
    expect((await bo.request('POST', '/api/auth/switch', { orgId: betaId })).status).toBe(404)
    expect((await bo.ok('GET', '/api/auth/me')).org.id).toBe(acmeId)
  })

  it('take someone who already signs in as a member, without touching their password or name', async () => {
    await ada.ok('POST', '/api/auth/switch', { orgId: betaId })
    expect((await ada.request('POST', '/api/members', { name: 'Cy', email: 'cy@example.com', role: 'member' })).status).toBe(400)
    const added = await ada.ok('POST', '/api/members', { name: 'Renamed', email: 'BO@example.com', password: 'another long password', role: 'admin' })
    expect(added).toMatchObject({ existing: true, member: { displayName: 'Bo', role: 'admin', email: BO.email } })
    expect((await ada.request('POST', '/api/members', { ...BO, role: 'member' })).status).toBe(409)
    await ada.ok('POST', '/api/auth/switch', { orgId: acmeId })

    const fresh = new ApiClient(harness.app)
    expect((await fresh.request('POST', '/api/auth/login', { email: BO.email, password: 'another long password' })).status).toBe(401)
    const me = await bo.ok('GET', '/api/auth/me')
    expect(me.orgs).toMatchObject([
      { id: acmeId, role: 'member' },
      { id: betaId, role: 'admin' },
    ])
  })

  it('keep the installation to its admins, whatever someone is in an organization', async () => {
    await bo.ok('POST', '/api/auth/switch', { orgId: betaId })
    const me = await bo.ok('GET', '/api/auth/me')
    expect(me).toMatchObject({ installationAdmin: false, account: { role: 'admin' } })
    expect((await bo.request('POST', '/api/orgs', { name: 'Mine' })).status).toBe(403)
    expect((await bo.request('GET', '/api/orgs')).status).toBe(403)
    expect((await bo.request('PUT', '/api/settings/general', { runConcurrency: 9 })).status).toBe(403)
    expect((await bo.request('PUT', '/api/settings/network', { mode: 'extend', hosts: ['beta.example'] })).status).toBe(200)
    expect((await ada.ok('GET', '/api/settings/network')).network.hosts).toEqual([])
  })

  it('leave an API token in the organization it was made in', async () => {
    const { secret } = await ada.ok('POST', '/api/tokens', { name: 'cli' })
    const token = new ApiClient(harness.app)
    token.token = secret
    await ada.ok('POST', '/api/auth/switch', { orgId: betaId })
    expect((await token.ok('GET', '/api/auth/me')).org.id).toBe(acmeId)
    expect((await token.ok('GET', '/api/connections')).connections).toHaveLength(1)
    expect((await token.request('POST', '/api/auth/switch', { orgId: betaId })).status).toBe(403)
  })

  it('spend the keys in the environment only for the first organization', async () => {
    const deps = { ...harness.deps, env: { ...harness.deps.env, ANTHROPIC_API_KEY: 'sk-env', OPENAI_API_KEY: 'sk-env-openai' } }
    const agentIn = async (orgId: string) => (await deps.db('agents').where({ orgId }).first()).accountId as string
    expect(await resolveModelProvider(deps, acmeId, await agentIn(acmeId), 'anthropic')).toEqual({ provider: 'anthropic', key: 'sk-acme' })
    expect(await resolveModelProvider(deps, acmeId, await agentIn(acmeId), 'openai')).toEqual({ provider: 'openai', key: 'sk-env-openai' })
    expect(await resolveModelProvider(deps, betaId, await agentIn(betaId), 'anthropic')).toBeUndefined()
    expect(await resolveModelProvider(deps, betaId, await agentIn(betaId), 'openai')).toBeUndefined()
  })

  it('let an admin change what a member may do, and never their own role', async () => {
    await ada.ok('POST', '/api/auth/switch', { orgId: acmeId })
    const boInAcme = (await ada.ok('GET', '/api/members')).members.find((member: { email: string }) => member.email === BO.email)
    const me = (await ada.ok('GET', '/api/auth/me')).account
    await bo.ok('POST', '/api/auth/switch', { orgId: acmeId })
    expect((await bo.request('PUT', `/api/members/${me.id}`, { role: 'member' })).status).toBe(403)
    expect((await bo.request('POST', '/api/connections', { kind: 'openai', name: 'Mine', secret: 'sk' })).status).toBe(403)

    expect((await ada.ok('PUT', `/api/members/${boInAcme.id}`, { role: 'admin' })).member.role).toBe('admin')
    expect((await bo.request('POST', '/api/connections', { kind: 'openai', name: 'Mine', secret: 'sk' })).status).toBe(200)
    expect((await ada.request('PUT', `/api/members/${me.id}`, { role: 'member' })).status).toBe(400)
    expect((await ada.request('DELETE', `/api/members/${me.id}`)).status).toBe(400)
  })

  it('take a member out of one organization and leave their other one alone', async () => {
    const boInAcme = (await ada.ok('GET', '/api/members')).members.find((member: { email: string }) => member.email === BO.email)
    const { secret } = await bo.ok('POST', '/api/tokens', { name: 'cli' })
    const token = new ApiClient(harness.app)
    token.token = secret
    expect((await token.request('GET', '/api/auth/me')).status).toBe(200)

    expect((await ada.request('DELETE', `/api/members/${boInAcme.id}`)).status).toBe(200)
    expect((await ada.ok('GET', '/api/members')).members.map((member: { email: string }) => member.email)).toEqual([SETUP.email])
    expect((await bo.request('GET', '/api/auth/me')).status).toBe(401)
    expect((await token.request('GET', '/api/auth/me')).status).toBe(401)
    expect((await ada.request('PUT', `/api/members/${boInAcme.id}`, { role: 'member' })).status).toBe(404)

    await bo.ok('POST', '/api/auth/login', { email: BO.email, password: BO.password })
    const me = await bo.ok('GET', '/api/auth/me')
    expect(me.org.id).toBe(betaId)
    expect(me.orgs.map((org: { id: string }) => org.id)).toEqual([betaId])
    expect((await bo.request('POST', '/api/auth/switch', { orgId: acmeId })).status).toBe(404)
  })

  it('bring a removed member back as the account they had', async () => {
    const back = await ada.ok('POST', '/api/members', { name: 'Bo', email: BO.email, role: 'member' })
    expect(back).toMatchObject({ existing: true, member: { role: 'member', status: 'active' } })
    expect((await bo.ok('GET', '/api/auth/me')).orgs).toHaveLength(2)
    const audit = (await ada.ok('GET', '/api/audit')).entries ?? []
    expect(JSON.stringify(audit)).toContain('member.removed')
  })
})
