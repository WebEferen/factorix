import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSse } from '@factorix/runtime'
import { describe, expect, it } from 'vitest'
import { Client } from './client'
import { createMcpHandler, TOOLS } from './mcp'
import {
  findRunId,
  issueHandoffTarget,
  looksLikeIssue,
  normalizeGitUrl,
  openPreview,
  pickConnection,
  startIssueHandoff,
  startRun,
  UsageError,
  watchRun,
} from './ops'
import { renderEvent } from './render'

async function* chunks(...parts: string[]) {
  yield* parts
}

type Route = (request: { method: string; body: unknown }) => unknown

/** A stand-in for the API. A string answer is sent as an event stream. */
function fakeClient(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body: unknown; authorization: string | null }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace('http://fx.test', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body, authorization: new Headers(init?.headers).get('authorization') })
    const route = routes[`${method} ${path}`]
    if (!route) return new Response(JSON.stringify({ error: { code: 'not_found', message: `${path} was not found` } }), { status: 404 })
    const answer = route({ method, body })
    return typeof answer === 'string' ? new Response(answer) : new Response(JSON.stringify(answer))
  }) as typeof fetch
  return { client: new Client('http://fx.test', 'fxp_test', fetchImpl), calls }
}

const sse = (...events: object[]) => events.map((event) => `id: 1\ndata: ${JSON.stringify({ kind: 'event', event })}\n\n`).join('')
const RUN_ID = '0a1b2c3d-0000-4000-8000-000000000001'

describe('parseSse', () => {
  it('joins data split across chunks and drops comments', async () => {
    const seen: string[] = []
    for await (const data of parseSse(chunks('retry: 2000\n\n: keepalive\n\nid: 4\nda', 'ta: {"a":1}\n\ndata: one\r\ndata: two\r\n\r\n')))
      seen.push(data)
    expect(seen).toEqual(['{"a":1}', 'one\ntwo'])
  })
})

describe('normalizeGitUrl', () => {
  it('turns ssh remotes into https and drops credentials', () => {
    expect(normalizeGitUrl('git@gitlab.com:acme/web.git')).toBe('https://gitlab.com/acme/web.git')
    expect(normalizeGitUrl('ssh://git@gitlab.example.com:2222/acme/web.git')).toBe('https://gitlab.example.com/acme/web.git')
    expect(normalizeGitUrl('https://oauth2:secret@gitlab.com/acme/web.git\n')).toBe('https://gitlab.com/acme/web.git')
    expect(normalizeGitUrl('http://gitlab.local:8080/acme/web')).toBe('https://gitlab.local:8080/acme/web')
    expect(() => normalizeGitUrl('not a url')).toThrow(UsageError)
  })
})

describe('pickConnection', () => {
  const connections = [
    { id: 'c1', name: 'Linear', accountRole: 'tracker', egressHosts: ['api.linear.app'] },
    { id: 'c2', name: 'Self-hosted', accountRole: 'scm', egressHosts: ['gitlab.example.com'] },
    { id: 'c3', name: 'GitLab', accountRole: 'scm', egressHosts: ['gitlab.com'] },
  ] as never[]

  it('takes the code host account on the same server, or the named one', () => {
    expect(pickConnection(connections, 'https://gitlab.com/acme/web.git', undefined)?.id).toBe('c3')
    expect(pickConnection(connections, 'https://github.com/acme/web.git', undefined)).toBeUndefined()
    expect(pickConnection(connections, 'https://gitlab.com/acme/web.git', 'Self-hosted')?.id).toBe('c2')
    expect(() => pickConnection(connections, 'https://gitlab.com/acme/web.git', 'nope')).toThrow(UsageError)
  })
})

describe('startRun', () => {
  const agents = [
    { id: 'a1', handle: 'engineer-1', status: 'active', archetype: { role: 'engineer' } },
    { id: 'a2', handle: 'reviewer-1', status: 'active', archetype: { role: 'reviewer' } },
  ]

  it('defaults to the only engineer and sends the token as a bearer', async () => {
    const { client, calls } = fakeClient({
      'GET /api/agents': () => ({ agents }),
      'GET /api/connections': () => ({ connections: [{ id: 'c3', name: 'GitLab', accountRole: 'scm', egressHosts: ['gitlab.com'] }] }),
      'POST /api/runs': () => ({ run: { id: RUN_ID } }),
    })
    const run = await startRun(client, { prompt: 'fix the flaky test', repo: 'git@gitlab.com:acme/web.git', ref: 'develop', cwd: '/' })
    expect(run.id).toBe(RUN_ID)
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.body).toEqual({
      agentId: 'a1',
      prompt: 'fix the flaky test',
      gitUrl: 'https://gitlab.com/acme/web.git',
      ref: 'develop',
      scmConnectionId: 'c3',
    })
    expect(post?.authorization).toBe('Bearer fxp_test')
  })

  it('names the agents when the one asked for does not exist', async () => {
    const { client } = fakeClient({ 'GET /api/agents': () => ({ agents }), 'GET /api/connections': () => ({ connections: [] }) })
    await expect(startRun(client, { prompt: 'x', agent: '@ghost', repo: 'https://gitlab.com/a/b', cwd: '/' })).rejects.toThrow(
      'There is no agent called ghost. Agents: engineer-1, reviewer-1',
    )
  })
})

describe('findRunId', () => {
  it('resolves the start of an id, and an issue to its active run', async () => {
    const { client } = fakeClient({
      'GET /api/runs?limit=300': () => ({ runs: [{ id: RUN_ID }, { id: 'ffff0000-0000-4000-8000-000000000002' }] }),
      'GET /api/issues?q=ins-7&limit=50': () => ({
        issues: [
          { id: 'i1', identifier: 'INS-70' },
          { id: 'i2', identifier: 'INS-7' },
        ],
      }),
      'GET /api/issues/i2': () => ({ issue: { id: 'i2', identifier: 'INS-7', activeRunId: null, runs: [{ id: RUN_ID }] } }),
    })
    expect(await findRunId(client, '0a1b')).toBe(RUN_ID)
    expect(await findRunId(client, 'ins-7')).toBe(RUN_ID)
  })
})

describe('watchRun', () => {
  const started = { type: 'run.started', seq: 1, model: 'm', runtime: 'claude' }
  const call = { type: 'tool.call', seq: 2, tool: 'Bash', summary: 'yarn test' }
  const done = { type: 'done', seq: 3, outcome: 'completed', usage: { turns: 4, costUsd: 0.5 } }

  it('stops at what has happened so far when not following', async () => {
    const lines: string[] = []
    const { client } = fakeClient({
      [`GET /api/runs/${RUN_ID}`]: () => ({ run: { id: RUN_ID, state: 'running', lastSeq: 2 } }),
      [`GET /api/runs/${RUN_ID}/events`]: () => sse(started, call, done),
    })
    await watchRun(client, RUN_ID, { follow: false, onLine: (line) => lines.push(line) })
    expect(lines).toEqual(['▸ started on m (claude)', '  → Bash: yarn test'])
  })

  it('follows to the end', async () => {
    const lines: string[] = []
    const { client } = fakeClient({
      [`GET /api/runs/${RUN_ID}`]: () => ({ run: { id: RUN_ID, state: 'running', lastSeq: 1 } }),
      [`GET /api/runs/${RUN_ID}/events`]: () => sse(started, call, done),
    })
    await watchRun(client, RUN_ID, { follow: true, onLine: (line) => lines.push(line) })
    expect(lines.at(-1)).toBe('■ completed after 4 turns, $0.50')
  })

  it('gives up on a quiet stream once the run has ended without a final event', async () => {
    let state = 'running'
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith('/events')) return new Response(JSON.stringify({ run: { id: RUN_ID, state, lastSeq: 0 } }))
      state = 'failed'
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(body)
    }) as typeof fetch
    const run = await watchRun(new Client('http://fx.test', 'fxp_test', fetchImpl), RUN_ID, { follow: true, onLine: () => undefined, idleMs: 20 })
    expect(run.state).toBe('failed')
  })
})

describe('renderEvent', () => {
  it('skips streaming fragments and successful tool output', () => {
    expect(renderEvent({ type: 'message', role: 'assistant', text: 'par', partial: true, messageId: 'm' } as never)).toBeNull()
    expect(renderEvent({ type: 'tool.result', callId: 'c', output: 'ok', isError: false } as never)).toBeNull()
    expect(renderEvent({ type: 'tool.result', callId: 'c', output: 'boom\nstack', isError: true } as never)).toBe('  ✗ boom')
  })
})

describe('MCP server', () => {
  it('lists its tools without their handlers and reports a failed call as a tool error', async () => {
    const { client } = fakeClient({ 'GET /api/inbox': () => ({ approvals: [], failedIssues: [] }) })
    const handle = createMcpHandler(client, '/')
    const listed = (await handle({ id: 1, method: 'tools/list' })) as { result: { tools: { name: string; call?: unknown }[] } }
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name))
    expect(listed.result.tools.every((tool) => tool.call === undefined)).toBe(true)

    const inbox = (await handle({ id: 2, method: 'tools/call', params: { name: 'factorix_inbox', arguments: {} } })) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    expect(inbox.result.content[0]?.text).toBe('Nothing is waiting.')

    const failed = (await handle({ id: 3, method: 'tools/call', params: { name: 'factorix_issue', arguments: { issue: 'INS-1' } } })) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    expect(failed.result.isError).toBe(true)
    expect(await handle({ method: 'notifications/initialized' })).toBeNull()
  })
})

describe('openPreview', () => {
  const issue = { id: 'i1', identifier: 'INS-7' }
  const preview = (state: string | null, extra: object = {}) => ({ preview: { unavailable: null, state, services: [], error: null, ...extra } })

  it('starts a stopped preview, waits for it, and asks for the address last', async () => {
    const states = [preview('stopped'), preview('starting', { services: [{ name: 'web', state: 'starting', message: null }] }), preview('ready')]
    const { client, calls } = fakeClient({
      'GET /api/issues/i1/preview': () => states.shift(),
      'POST /api/issues/i1/preview/start': () => preview('starting'),
      'POST /api/issues/i1/preview/open': () => ({ url: 'http://abc.preview.test/__factorix/enter?ticket=t' }),
    })
    const lines: string[] = []
    const url = await openPreview(client, issue, { path: '/login', onLine: (line) => lines.push(line), pollMs: 1 })
    expect(url).toBe('http://abc.preview.test/__factorix/enter?ticket=t')
    expect(lines).toEqual(['Starting the preview of INS-7.', '  web: starting'])
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/issues/i1/preview',
      'POST /api/issues/i1/preview/start',
      'GET /api/issues/i1/preview',
      'GET /api/issues/i1/preview',
      'POST /api/issues/i1/preview/open',
    ])
    expect(calls.at(-1)?.body).toEqual({ path: '/login' })
  })

  it('opens a running preview without starting it, and says why one cannot run or failed', async () => {
    const ready = fakeClient({
      'GET /api/issues/i1/preview': () => preview('ready'),
      'POST /api/issues/i1/preview/open': () => ({ url: 'u' }),
    })
    expect(await openPreview(ready.client, issue, { onLine: () => undefined })).toBe('u')
    expect(ready.calls).toHaveLength(2)

    const none = fakeClient({ 'GET /api/issues/i1/preview': () => ({ preview: { unavailable: 'This project has no environment.', state: null } }) })
    await expect(openPreview(none.client, issue, { onLine: () => undefined })).rejects.toThrow('This project has no environment.')

    const failing = [preview('starting'), preview('failed', { error: 'web could not start' })]
    const failed = fakeClient({ 'GET /api/issues/i1/preview': () => failing.shift() })
    await expect(openPreview(failed.client, issue, { onLine: () => undefined, pollMs: 1 })).rejects.toThrow(
      'The preview failed: web could not start.',
    )
  })
})

describe('handing a checkout to an issue', () => {
  const agents = { agents: [{ id: 'a1', handle: 'engineer-1', status: 'active', archetype: { role: 'engineer' } }] }
  const issue = (factoryState: string) => ({
    issue: {
      id: '11111111-1111-4111-8111-111111111111',
      identifier: 'INS-7',
      factoryState,
      assignedAgentId: null,
      activeRunId: null,
      workBranch: 'factorix/ins-7-demo',
      project: { name: 'Web app', repos: [{ scmCloneUrl: 'https://gitlab.com/acme/web.git' }] },
    },
  })
  const checkout = (remote: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-cli-test-'))
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
    return dir
  }
  const routes = (state: string) => ({
    'GET /api/issues?q=INS-7&limit=50': () => ({ issues: [issue(state).issue] }),
    'GET /api/issues/11111111-1111-4111-8111-111111111111': () => issue(state),
    'GET /api/agents': () => agents,
  })

  it('tells an issue from a prompt', () => {
    expect(looksLikeIssue('INS-7')).toBe(true)
    expect(looksLikeIssue('fix-7-things')).toBe(false)
    expect(looksLikeIssue('fix')).toBe(false)
  })

  it('takes a checkout of one of the project repositories, for an issue nobody is working on', async () => {
    const mine = checkout('git@gitlab.com:acme/web.git')
    const other = checkout('git@gitlab.com:acme/api.git')
    try {
      const { client } = fakeClient(routes('untracked'))
      const target = await issueHandoffTarget(client, 'INS-7', { cwd: mine })
      expect(target.agent.handle).toBe('engineer-1')
      expect(target.issue.workBranch).toBe('factorix/ins-7-demo')
      await expect(issueHandoffTarget(client, 'INS-7', { cwd: other })).rejects.toThrow('is not a repository of Web app')
      await expect(issueHandoffTarget(fakeClient(routes('running')).client, 'INS-7', { cwd: mine })).rejects.toThrow('an agent already has it')
    } finally {
      rmSync(mine, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('leaves the instruction, assigns the agent, and waits for the run', async () => {
    const answers = [issue('running'), { issue: { ...issue('running').issue, activeRunId: RUN_ID } }]
    const { client, calls } = fakeClient({
      'POST /api/issues/11111111-1111-4111-8111-111111111111/instructions': () => ({ ok: true }),
      'POST /api/issues/11111111-1111-4111-8111-111111111111/assign': () => issue('running'),
      'GET /api/issues/11111111-1111-4111-8111-111111111111': () => answers.shift(),
    })
    const runId = await startIssueHandoff(client, issue('untracked').issue as never, agents.agents[0] as never, 'finish it', { pollMs: 1 })
    expect(runId).toBe(RUN_ID)
    expect(calls.slice(0, 2).map((call) => call.body)).toEqual([{ body: 'finish it' }, { agentId: 'a1' }])
  })
})
