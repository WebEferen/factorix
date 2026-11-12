import type { ProjectRow, RunRow } from '@factorix/db'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { agentMcp } from './services/spec'
import { ApiClient, createHarness, type Harness } from './testing/harness'

describe('an agent’s MCP servers', () => {
  let harness: Harness
  let run: RunRow
  const proxy = { origin: 'http://egress-proxy:8080', token: 'run-token' }

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    const admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    const http = (
      await admin.ok('POST', '/api/connections', {
        kind: 'mcp_http',
        name: 'Docs Search',
        config: { url: 'https://mcp.example/mcp' },
        secret: { Authorization: 'Bearer real-mcp-key' },
      })
    ).connection
    const stdio = (
      await admin.ok('POST', '/api/connections', {
        kind: 'mcp_stdio',
        name: 'db',
        config: { command: 'npx', args: ['db-mcp'] },
        secret: { DB_PASSWORD: 'real-db-password' },
      })
    ).connection
    const [agent] = (await admin.ok('GET', '/api/agents')).agents
    await admin.ok('PUT', `/api/agents/${agent.id}`, {
      handle: agent.handle,
      displayName: agent.displayName,
      archetypeId: agent.archetype.id,
      runtime: agent.runtime,
      policy: { mode: agent.policy.mode },
      connectionIds: [http.id, stdio.id],
    })
    run = { agentId: agent.id } as RunRow
  })
  afterAll(() => harness.destroy())

  it('reaches HTTP servers through the egress proxy, which holds their headers, and starts stdio servers without values', async () => {
    const mcp = await agentMcp(harness.deps, { run, project: null, proxy })
    expect(mcp.servers).toEqual({
      'docs-search': { type: 'http', url: 'http://egress-proxy:8080/mcp/docs-search', headers: { Authorization: 'Bearer run-token' } },
      db: { type: 'stdio', command: 'npx', args: ['db-mcp'], env: {} },
    })
    expect(JSON.stringify(mcp.servers)).not.toContain('real-')
    expect(mcp.grant).toEqual({ 'docs-search': { url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer real-mcp-key' } } })
    expect(mcp.warnings).toEqual(['db starts without its environment values, since agents never get secret values.'])
  })

  it('leaves HTTP servers out without the proxy, and under network policy None', async () => {
    const without = await agentMcp(harness.deps, { run, project: null, proxy: null })
    expect(Object.keys(without.servers)).toEqual(['db'])
    expect(without.grant).toEqual({})
    expect(without.warnings).toContain('Docs Search is left out, since HTTP MCP servers are reached through the egress proxy and none is set up.')

    const offline = await agentMcp(harness.deps, { run, project: { networkPolicy: 'none' } as ProjectRow, proxy })
    expect(Object.keys(offline.servers)).toEqual(['db'])
    expect(offline.grant).toEqual({})
    expect(offline.warnings).toContain("Docs Search is left out, since the project's network policy is None.")
  })
})
