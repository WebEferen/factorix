import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { resolveModelKey } from './services/connections'
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
    expect(await resolveModelKey(deps, acmeId, await agentIn(acmeId), 'anthropic')).toBe('sk-acme')
    expect(await resolveModelKey(deps, acmeId, await agentIn(acmeId), 'openai')).toBe('sk-env-openai')
    expect(await resolveModelKey(deps, betaId, await agentIn(betaId), 'anthropic')).toBeUndefined()
    expect(await resolveModelKey(deps, betaId, await agentIn(betaId), 'openai')).toBeUndefined()
  })
})
