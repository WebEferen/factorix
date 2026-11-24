import { generateKeyPairSync, sign } from 'node:crypto'
import type { ModelLoginRow, RunRow } from '@factorix/db'
import { AsyncQueue } from '@factorix/runtime'
import type { AgentHandle, SandboxProvider } from '@factorix/sandbox'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import {
  chatgptAccess,
  claudeLoginVolume,
  noteClaudePlanFailure,
  planAccessKey,
  planForRun,
  runClaudeLoginStep,
  withPlanKeys,
} from './services/model-logins'
import { advanceIssue } from './services/pipeline'
import { relayDomainEvents } from './services/relay'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }
const STATE_MAP = { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' }
const REPO = { scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }

function idToken(claims: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

/** Stands in for auth.openai.com: discovery, keys, and a token endpoint the test scripts. */
function openai(token: (form: URLSearchParams) => { status: number; body: Record<string, unknown> }) {
  const calls: URLSearchParams[] = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url === 'https://auth.openai.com/.well-known/openid-configuration')
      return reply(200, {
        issuer: 'https://auth.openai.com',
        jwks_uri: 'https://auth.openai.com/jwks',
        revocation_endpoint: 'https://auth.openai.com/revoke',
      })
    if (url === 'https://auth.openai.com/jwks') return reply(200, { keys: [JWK] })
    if (url === 'https://auth.openai.com/revoke') return reply(200, {})
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const form = new URLSearchParams(String(init?.body))
      calls.push(form)
      // Slow enough that two refreshes that were not serialized would both reach here.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const answer = token(form)
      return reply(answer.status, answer.body)
    }
    return reply(404, {})
  })
  vi.stubGlobal('fetch', fetcher)
  return calls
}

describe('model plans', () => {
  let harness: Harness
  let admin: ApiClient
  let accountId: string
  let projectId: string
  let agentId: string

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', SETUP)
    accountId = (await admin.ok('GET', '/api/auth/me')).account.id
    const linearId = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'x' })).connection.id
    const gitlabId = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'y', config: {} })).connection.id
    projectId = (
      await admin.ok('POST', '/api/projects', {
        name: 'Platform',
        trackerConnectionId: linearId,
        trackerTeamId: TEAM_ID,
        trackerProjectId: null,
        scmConnectionId: gitlabId,
        repos: [REPO],
        stateMap: STATE_MAP,
      })
    ).project.id
    const archetypeId = (await admin.ok('GET', '/api/archetypes')).archetypes.find((item: { name: string }) => item.name === 'Engineer').id
    agentId = (
      await admin.ok('POST', '/api/agents', {
        handle: 'coder',
        displayName: 'Coder',
        archetypeId,
        systemPrompt: 'Code',
        policy: { mode: 'edit', allow: [], deny: [], requireApproval: [], networkAccess: true },
        runtime: 'codex',
      })
    ).agent.id
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  afterAll(() => harness.destroy())

  const db = () => harness.deps.db
  const login = () => db()<ModelLoginRow>('model_logins').where({ accountId, provider: 'chatgpt' }).first()

  async function signIn(): Promise<ModelLoginRow> {
    const { url } = await admin.ok('POST', '/api/model-plans/chatgpt/start', {})
    const asked = new URL(url).searchParams
    const calls = openai(() => ({
      status: 200,
      body: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        id_token: idToken({
          iss: 'https://auth.openai.com',
          aud: 'oaiapp_1',
          sub: 'user-1',
          email: 'ada@example.com',
          nonce: asked.get('nonce'),
          exp: Math.floor(Date.now() / 1000) + 600,
          'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
        }),
      },
    }))
    const callback = `http://127.0.0.1:1455/auth/callback?code=code-1&state=${asked.get('state')}&client_id=oaiapp_1&scope=openid`
    const { login: dto } = await admin.ok('POST', '/api/model-plans/chatgpt/complete', { callbackUrl: callback })
    expect(dto).toMatchObject({ provider: 'chatgpt', status: 'active', email: 'ada@example.com', plan: 'pro' })
    expect(calls[0]?.get('client_id')).toBe('oaiapp_1')
    expect(calls[0]?.get('code_verifier')).toBeTruthy()
    return (await login()) as ModelLoginRow
  }

  it('keeps personal plans off until an admin allows them', async () => {
    expect(await admin.ok('GET', '/api/model-plans')).toEqual({ enabled: false, logins: [] })
    expect((await admin.request('POST', '/api/model-plans/chatgpt/start', {})).status).toBe(409)
    await admin.ok('PUT', '/api/settings/model-plans', { enabled: true })
    expect((await admin.ok('GET', '/api/model-plans')).enabled).toBe(true)
  })

  it('registers Factorix with ChatGPT and refuses a callback it did not start', async () => {
    const { url, redirectUri } = await admin.ok('POST', '/api/model-plans/chatgpt/start', {})
    const asked = new URL(url).searchParams
    expect(asked.get('client_id')).toBe('dynamic_agent_client')
    expect(asked.get('agent_name_hint')).toBe('Factorix')
    expect(asked.get('ext_agent_host_id')).toBeTruthy()
    expect(redirectUri).toBe('http://127.0.0.1:1455/auth/callback')
    const forged = await admin.request('POST', '/api/model-plans/chatgpt/complete', {
      callbackUrl: 'http://127.0.0.1:1455/auth/callback?code=c&state=not-ours&client_id=oaiapp_1',
    })
    expect(forged.status).toBe(400)
  })

  it('stores the sign-in encrypted and never hands its tokens out', async () => {
    const row = await signIn()
    expect(row.clientId).toBe('oaiapp_1')
    expect(row.secretCiphertext?.toString('utf8')).not.toContain('refresh-1')
    expect(JSON.stringify(await admin.ok('GET', '/api/model-plans'))).not.toContain('access-1')
    expect(await harness.deps.redis.get(planAccessKey(row.id))).toBe('access-1')
    const again = new URL((await admin.ok('POST', '/api/model-plans/chatgpt/start', {})).url).searchParams
    expect(again.get('client_id')).toBe('oaiapp_1')
    expect(again.has('agent_name_hint')).toBe(false)
  })

  it('uses the plan only for runs its owner started, while the organization allows it', async () => {
    const run = { orgId: (await login())?.orgId as string, createdBy: accountId }
    expect(await planForRun(harness.deps, run, 'openai')).toMatchObject({ use: { plan: 'chatgpt' } })
    expect(await planForRun(harness.deps, { ...run, createdBy: null }, 'openai')).toBeUndefined()
    expect(await planForRun(harness.deps, run, 'anthropic')).toBeUndefined()
    await db()('organizations').update({ personalModelLogins: false })
    expect(await planForRun(harness.deps, run, 'openai')).toBeUndefined()
    await db()('organizations').update({ personalModelLogins: true })
  })

  it('refreshes once when several runs need a new token at the same time, and keeps the rotated refresh token', async () => {
    const row = (await login()) as ModelLoginRow
    await db()('model_logins')
      .where({ id: row.id })
      .update({ accessExpiresAt: new Date(Date.now() + 60_000) })
    const calls = openai((form) => ({
      status: 200,
      body: { access_token: `access-after-${form.get('refresh_token')}`, refresh_token: 'refresh-2', expires_in: 3600 },
    }))
    const tokens = await Promise.all([1, 2, 3].map(() => chatgptAccess(harness.deps, row.id, { minSeconds: 900 })))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.get('grant_type')).toBe('refresh_token')
    expect(calls[0]?.get('resource')).toBe('https://api.openai.com/v1')
    expect(tokens).toEqual(['access-after-refresh-1', 'access-after-refresh-1', 'access-after-refresh-1'])
    await db()('model_logins').where({ id: row.id }).update({ accessExpiresAt: new Date() })
    expect(await chatgptAccess(harness.deps, row.id, { minSeconds: 900 })).toBe('access-after-refresh-2')
  })

  it('fills a grant from the cache, and asks for a new sign-in once ChatGPT ends the old one', async () => {
    const row = (await login()) as ModelLoginRow
    const grant = await withPlanKeys(harness.deps.redis, { models: { chatgpt: { key: '', login: row.id }, openai: { key: 'sk-org' } } })
    expect(grant.models.chatgpt.key).toBe('access-after-refresh-2')
    expect(grant.models.openai.key).toBe('sk-org')
    openai(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token was revoked' } }))
    expect(await chatgptAccess(harness.deps, row.id, { minSeconds: 0, force: true })).toBeNull()
    expect(await login()).toMatchObject({ status: 'needs_login', lastError: expect.stringContaining('revoked') })
    expect(await harness.deps.redis.get(planAccessKey(row.id))).toBeNull()
    expect(await planForRun(harness.deps, { orgId: row.orgId, createdBy: accountId }, 'openai')).toEqual({
      skip: expect.stringContaining('needs signing in again'),
    })
  })

  it('credits a pipeline run to whoever started it in Factorix, and no one else', async () => {
    const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, { title: 'Fix it', assignAgentId: agentId })
    await relayDomainEvents(harness.deps)
    const first = await db()<RunRow>('runs').where({ issueId: issue.id }).orderBy('created_at').first()
    expect(first).toMatchObject({ createdBy: accountId, agentId })
    expect((await db()('issues').where({ id: issue.id }).first()).startedBy).toBe(accountId)

    await advanceIssue(db(), issue.id, { type: 'cancel' })
    await db()('runs').where({ issueId: issue.id }).update({ state: 'cancelled' })
    await db()('issues').where({ id: issue.id }).update({ lockedByRunId: null, factoryState: 'cancelled' })
    await advanceIssue(db(), issue.id, { type: 'start' })
    const second = await db()<RunRow>('runs').where({ issueId: issue.id }).orderBy('created_at', 'desc').first()
    expect(second?.id).not.toBe(first?.id)
    expect(second?.createdBy).toBeNull()
  })

  it('lets a person disconnect only their own plan, and revokes it', async () => {
    const row = (await login()) as ModelLoginRow
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect((await admin.request('DELETE', '/api/model-plans/00000000-0000-0000-0000-000000000000')).status).toBe(404)
    expect((await admin.request('DELETE', `/api/model-plans/${row.id}`)).status).toBe(200)
    expect(await login()).toBeUndefined()
  })

  describe('a Claude plan', () => {
    const SIGN_IN = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s1'

    /** Plays the Claude CLI in its container: prints the address inside a terminal link, then takes one line of input. */
    function fakeCli(answer: { exitCode: number; said?: string }) {
      const sent: string[] = []
      const removed: string[] = []
      const forgotten: string[] = []
      const handle = (id: string, lines: string[]): AgentHandle => {
        const queue = new AsyncQueue<string>()
        for (const line of lines) queue.push(line)
        return {
          containerId: id,
          lines: queue,
          send: (line) => {
            sent.push(line)
            if (answer.said) queue.push(answer.said)
            queue.close()
          },
          onStderr: () => undefined,
          wait: async () => ({ exitCode: answer.exitCode }),
          detach: () => queue.close(),
        }
      }
      const sandbox = {
        startClaudeLogin: async (volume: string) => {
          expect(volume).toBe(claudeLoginVolume(accountId))
          return handle('login-1', [
            'Opening browser to sign in…',
            `If the browser didn't open, visit: \u001b]8;;${SIGN_IN}\u0007${SIGN_IN}\u001b]8;;\u0007`,
          ])
        },
        reattach: async (id: string) => handle(id, []),
        remove: async (id: string) => void removed.push(id),
        claudeLoginStatus: async () => ({
          exitCode: 0,
          output: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'ada@example.com', subscriptionType: 'max' }),
        }),
        forgetClaudeLogin: async (volume: string) => void forgotten.push(volume),
      } as unknown as SandboxProvider
      return { sandbox, sent, removed, forgotten }
    }

    /** Plays the worker for the jobs a sign-in queues. */
    async function work(sandbox: SandboxProvider) {
      const jobs = await harness.deps.queues.environments.getJobs(['waiting'])
      for (const job of jobs) {
        if (job.name === 'plan.claude-forget') await sandbox.forgetClaudeLogin(job.data.volume)
        else await runClaudeLoginStep({ ...harness.deps, sandbox }, job.data)
        await job.remove()
      }
    }

    const claude = () => db()<ModelLoginRow>('model_logins').where({ accountId, provider: 'claude' }).first()

    it('signs in through the CLI, and keeps who signed in but no secret', async () => {
      const cli = fakeCli({ exitCode: 0 })
      const { attemptId } = await admin.ok('POST', '/api/model-plans/claude/start', {})
      expect((await admin.ok('GET', `/api/model-plans/claude/attempts/${attemptId}`)).attempt.status).toBe('starting')
      await work(cli.sandbox)
      expect((await admin.ok('GET', `/api/model-plans/claude/attempts/${attemptId}`)).attempt).toEqual({
        status: 'waiting',
        url: SIGN_IN,
        error: null,
      })

      await admin.ok('POST', `/api/model-plans/claude/attempts/${attemptId}/code`, { code: ' abc#s1 ' })
      expect((await admin.request('POST', `/api/model-plans/claude/attempts/${attemptId}/code`, { code: 'again' })).status).toBe(409)
      await work(cli.sandbox)
      expect(cli.sent).toEqual(['abc#s1'])
      expect(cli.removed).toContain('login-1')
      expect((await admin.ok('GET', `/api/model-plans/claude/attempts/${attemptId}`)).attempt.status).toBe('done')
      expect(await claude()).toMatchObject({ status: 'active', email: 'ada@example.com', plan: 'max', secretCiphertext: null, clientId: null })
      expect(await harness.deps.queues.environments.getJobs(['waiting', 'completed'])).toHaveLength(0)
    })

    it('says what the CLI said when Claude refuses the code', async () => {
      const cli = fakeCli({ exitCode: 1, said: '\u001b[31mOAuth error: Invalid code\u001b[39m' })
      const { attemptId } = await admin.ok('POST', '/api/model-plans/claude/start', {})
      await work(cli.sandbox)
      await admin.ok('POST', `/api/model-plans/claude/attempts/${attemptId}/code`, { code: 'wrong' })
      await work(cli.sandbox)
      expect((await admin.ok('GET', `/api/model-plans/claude/attempts/${attemptId}`)).attempt).toMatchObject({
        status: 'failed',
        error: 'OAuth error: Invalid code',
      })
      expect(cli.removed).toContain('login-1')
      expect((await claude())?.status).toBe('active')
    })

    it('serves only runs on the main machine in projects with network access', async () => {
      const run = { orgId: (await claude())?.orgId as string, createdBy: accountId }
      expect(await planForRun(harness.deps, run, 'anthropic')).toMatchObject({ use: { plan: 'claude' } })
      expect(await planForRun(harness.deps, run, 'anthropic', { onRunner: true })).toEqual({ skip: expect.stringContaining('runner') })
      expect(await planForRun(harness.deps, run, 'anthropic', { networkPolicy: 'none' })).toEqual({ skip: expect.stringContaining('no network') })
      expect(await planForRun(harness.deps, { ...run, createdBy: null }, 'anthropic')).toBeUndefined()
    })

    it('asks for a new sign-in once a run is refused, and signs the CLI out on disconnect', async () => {
      const row = (await claude()) as ModelLoginRow
      await noteClaudePlanFailure(db(), row.id, 'OAuth token has expired · Please run /login')
      expect(await claude()).toMatchObject({ status: 'needs_login', lastError: expect.stringContaining('/login') })
      expect(await planForRun(harness.deps, { orgId: row.orgId, createdBy: accountId }, 'anthropic')).toEqual({
        skip: expect.stringContaining('needs signing in again'),
      })
      const cli = fakeCli({ exitCode: 0 })
      expect((await admin.request('DELETE', `/api/model-plans/${row.id}`)).status).toBe(200)
      await work(cli.sandbox)
      expect(cli.forgotten).toEqual([claudeLoginVolume(accountId)])
      expect(await claude()).toBeUndefined()
    })
  })
})
