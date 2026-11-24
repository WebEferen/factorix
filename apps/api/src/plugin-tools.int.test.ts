import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IssueRow, ProjectRow, RunRow } from '@factorix/db'
import { definePlugin, type ToolCall } from '@moxxy/factorix-plugin-sdk'
import { serve } from '@moxxy/factorix-plugin-sdk/node'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { answerPluginTool, pluginToolsFor } from './services/plugin-tools'
import { buildRunSpec } from './services/spec'
import { ApiClient, createHarness, type Harness } from './testing/harness'

describe('plugin tools for agents', () => {
  const secret = 'tools-secret-0123456789'
  const seen: ToolCall[] = []
  const servers: Server[] = []
  let harness: Harness
  let admin: ApiClient
  let run: RunRow
  let docsId: string
  let otherId: string
  const issue = { identifier: 'ENG-7', title: 'Retries', trackerUrl: 'https://tracker.test/ENG-7' } as IssueRow

  const install = async (plugin: ReturnType<typeof definePlugin>) => {
    const server = await serve(plugin, { secret, port: 0, hostname: '127.0.0.1' })
    servers.push(server)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/factorix`
    return (await admin.ok('POST', '/api/plugins', { url, secret })).plugin.id as string
  }
  const names = async (project: ProjectRow | null = null) => (await pluginToolsFor(harness.deps.db, run, project)).map((tool) => tool.name)
  const call = (name: string, input: unknown) =>
    answerPluginTool(harness.deps, { run, issue, project: null, op: 'tool.call', input: { name, input } }) as Promise<string>

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    docsId = await install(
      definePlugin({
        name: 'Docs',
        version: '1.0.0',
        tools: [
          {
            key: 'search',
            description: 'Searches the docs.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            run(toolCall) {
              seen.push(toolCall)
              if (toolCall.input.query === 'boom') throw new Error('The index is rebuilding')
              return { hits: [`retries.md for ${String(toolCall.input.query)}`] }
            },
          },
        ],
      }),
    )
    otherId = await install(
      definePlugin({
        name: 'DOCS!',
        version: '1.0.0',
        tools: [
          { key: 'search', description: 'Another search.', run: () => 'not this one' },
          { key: 'lookup', description: 'Looks a word up.', run: () => 'a word' },
        ],
      }),
    )
    await install(definePlugin({ name: 'Chat', version: '1.0.0', blocks: [{ key: 'post', title: 'Post', description: 'Posts.', run: () => ({}) }] }))
    const { agents } = await admin.ok('GET', '/api/agents')
    const created = (await admin.ok('POST', '/api/runs', { agentId: agents[0].id, prompt: 'Look', gitUrl: 'file:///remote/repo.git' })).run
    run = (await harness.deps.db('runs').where({ id: created.id }).first()) as RunRow
  })
  afterAll(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve))
    await harness.destroy()
  })

  it('offers a plugin’s tools once the organization turned it on, and the first plugin keeps a shared name', async () => {
    expect(await names()).toEqual([])
    await admin.ok('PUT', `/api/plugins/${docsId}/organization`, { enabled: true })
    await admin.ok('PUT', `/api/plugins/${otherId}/organization`, { enabled: true })
    expect(await names()).toEqual(['docs_search', 'docs_lookup'])
    expect(await answerPluginTool(harness.deps, { run, issue: null, project: null, op: 'tool.list', input: {} })).toEqual([
      {
        name: 'docs_search',
        description: 'Searches the docs.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      { name: 'docs_lookup', description: 'Looks a word up.', inputSchema: { type: 'object', properties: {} } },
    ])
  })

  it('asks the plugin and answers with its text, telling it which agent called and on what', async () => {
    expect(JSON.parse(await call('docs_search', { query: 'retries' }))).toEqual({ hits: ['retries.md for retries'] })
    expect(seen.at(-1)).toEqual({
      tool: 'search',
      plugin: { id: docsId },
      org: { id: run.orgId },
      agent: { id: run.agentId, handle: (run.agentSnapshot as { handle: string }).handle },
      run: { id: run.id, url: expect.stringMatching(new RegExp(`/runs/${run.id}$`)) },
      issue: { identifier: 'ENG-7', title: 'Retries', url: 'https://tracker.test/ENG-7' },
      input: { query: 'retries' },
    })
    expect(await call('docs_lookup', {})).toBe('a word')
  })

  it('refuses a tool it does not offer and input that is not an object or too large, and passes on what the plugin threw', async () => {
    await expect(call('chat_post', {})).rejects.toThrow('There is no tool called chat_post')
    await expect(call('docs_search', ['retries'])).rejects.toThrow('takes an object')
    await expect(call('docs_search', { query: 'x'.repeat(70_000) })).rejects.toThrow('larger than 64 KB')
    await expect(call('docs_search', { query: 'boom' })).rejects.toThrow('The index is rebuilding')
  })

  it('offers none to a project with no network, nor once the permission was not allowed', async () => {
    expect(await names({ networkPolicy: 'none' } as ProjectRow)).toEqual([])
    expect(await names({ networkPolicy: 'restricted' } as ProjectRow)).toEqual(['docs_search', 'docs_lookup'])
    await harness.deps.db('organization_plugins').where({ pluginId: otherId }).update({ permissions: [] })
    expect(await names()).toEqual(['docs_search'])
    const before = seen.length
    await expect(call('docs_lookup', {})).rejects.toThrow('There is no tool called docs_lookup')
    await admin.ok('PUT', `/api/plugins/${docsId}/organization`, { enabled: false })
    await expect(call('docs_search', { query: 'retries' })).rejects.toThrow('There is no tool called docs_search')
    expect(seen).toHaveLength(before)
  })

  it('names them to the factorix MCP server of the run, which the agent may call', async () => {
    const spec = await buildRunSpec(harness.deps, {
      run: { ...run, runtime: 'codex' },
      issue: null,
      project: null,
      repos: [],
      branch: 'main',
      repoDocs: [],
      ciFailures: [],
      extraNotes: [],
      pluginTools: true,
    })
    expect(spec.mcpServers.factorix).toMatchObject({ env: { FACTORIX_TOOLS: 'plugins' } })
    expect(spec.policy.allow).toContain('mcp__factorix__*')
  })
})
