import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { WorkflowRow } from '@factorix/db'
import { packPlugin } from '@moxxy/factorix-plugin-sdk/pack'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }

const TRIAGE = {
  name: 'Security triage',
  description: 'Asks for a security review and tells Slack.',
  definition: {
    nodes: [
      { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'review',
        type: 'agent.prompt',
        position: { x: 0, y: 100 },
        config: {
          agentId: 'b7a4e7f2-1d5c-4a3e-9f0e-2c6b8d9e1f00',
          projectId: 'c7a4e7f2-1d5c-4a3e-9f0e-2c6b8d9e1f00',
          prompt: 'Review {{issue.identifier}} for security problems.',
          skillIds: ['review-checklist', 'not-here'],
          model: 'claude-opus-5-5',
          post: 'none',
        },
      },
      {
        id: 'tell',
        type: 'slack.send_message',
        position: { x: 0, y: 200 },
        config: { connectionId: 'd7a4e7f2-1d5c-4a3e-9f0e-2c6b8d9e1f00', channel: 'reply', message: '{{text}}' },
      },
    ],
    edges: [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'review' },
      { id: 'e2', source: 'review', sourceHandle: 'next', target: 'tell' },
    ],
  },
}

/** Built the way an author builds one, with the SDK's pack. */
async function contentPack(version: string, options: { checklist?: string; dropTone?: boolean; workflow?: object } = {}): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'fx-content-'))
  const write = (path: string, data: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), data)
  }
  const skills = [
    { key: 'review-checklist', name: 'Review checklist', file: 'skills/review-checklist.md' },
    ...(options.dropTone ? [] : [{ key: 'review-tone', name: 'Review tone', file: 'skills/review-tone.md' }]),
  ]
  const archetypes = [
    { key: 'security', name: 'Security reviewer', role: 'reviewer', description: 'Reviews for security', prompt: 'archetypes/security.md' },
  ]
  const workflows = [{ key: 'triage', file: 'workflows/triage.json' }]
  write(
    'package.json',
    JSON.stringify({ name: 'security-kit', version, description: 'Security reviews', factorix: { content: { skills, archetypes, workflows } } }),
  )
  write('skills/review-checklist.md', options.checklist ?? '# Checklist\n\n- Injection')
  write('skills/review-tone.md', 'Be kind.')
  write('archetypes/security.md', 'You review code for security problems.')
  write('workflows/triage.json', JSON.stringify(options.workflow ?? TRIAGE))
  try {
    return readFileSync((await packPlugin(dir)).file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('content packs', () => {
  let harness: Harness
  let ada: ApiClient

  const upload = (path: string, archive: Buffer) =>
    harness.app.inject({ method: 'POST', url: path, payload: archive, headers: { cookie: ada.cookie, 'content-type': 'application/zip' } })
  const plan = async (archive: Buffer) => {
    const answer = await upload('/api/plugin-packages/inspect', archive)
    expect(answer.statusCode, answer.body).toBe(200)
    return answer.json().package
  }
  const actions = (items: { kind: string; key: string; action: string }[]) =>
    Object.fromEntries(items.map((item) => [`${item.kind}:${item.key}`, item.action]))
  const skill = (slug: string) => harness.deps.db('skills').where({ slug }).first()
  const triage = () => harness.deps.db<WorkflowRow>('workflows').where({ name: 'Security triage' }).first() as Promise<WorkflowRow>

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    ada = new ApiClient(harness.app)
    await ada.ok('POST', '/api/auth/setup', SETUP)
  })

  afterAll(async () => {
    await harness.destroy()
  })

  it('shows what it would import, and imports nothing when a name is taken', async () => {
    const found = await plan(await contentPack('1.0.0'))
    expect(found).toMatchObject({ kind: 'content', name: 'security-kit', version: '1.0.0', replaces: null, permissions: [], egress: [] })
    expect(actions(found.items)).toEqual({
      'skill:review-checklist': 'create',
      'skill:review-tone': 'create',
      'archetype:security': 'create',
      'workflow:triage': 'create',
    })

    const own = await ada.ok('POST', '/api/skills', { slug: 'review-tone', name: 'Our tone', markdown: 'Ours.' })
    expect(actions((await plan(await contentPack('1.0.0'))).items)['skill:review-tone']).toBe('conflict')
    const refused = await upload('/api/plugin-packages', await contentPack('1.0.0'))
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toContain('the skill review-tone')
    expect(await skill('review-checklist')).toBeUndefined()
    await harness.deps.db('skills').where({ id: own.skill.id }).delete()

    const workflow = {
      ...TRIAGE,
      definition: { ...TRIAGE.definition, nodes: [{ ...TRIAGE.definition.nodes[0], type: `plugin.${own.skill.id}.post` }] },
    }
    const foreign = await upload('/api/plugin-packages/inspect', await contentPack('1.0.0', { workflow }))
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().error.message).toContain("a plugin's block")
  })

  it('imports skills, archetypes, and a workflow that waits as a draft for what is local', async () => {
    const answer = await upload('/api/plugin-packages', await contentPack('1.0.0'))
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json().contentPack).toMatchObject({ name: 'security-kit', version: '1.0.0', description: 'Security reviews' })

    const checklist = await skill('review-checklist')
    expect(checklist).toMatchObject({ name: 'Review checklist', markdown: '# Checklist\n\n- Injection' })
    const { archetypes } = await ada.ok('GET', '/api/archetypes')
    expect(archetypes).toContainEqual(
      expect.objectContaining({ name: 'Security reviewer', role: 'reviewer', systemPrompt: 'You review code for security problems.' }),
    )

    const workflow = await triage()
    expect(workflow).toMatchObject({ enabled: false, publishedVersion: 0, publishedDefinition: null, projectId: null })
    const [, review, tell] = workflow.definition.nodes
    expect(review?.config).toEqual({
      prompt: 'Review {{issue.identifier}} for security problems.',
      skillIds: [checklist.id],
      model: 'claude-opus-5-5',
      post: 'none',
    })
    expect(tell?.config).toEqual({ channel: 'reply', message: '{{text}}' })

    const { contentPacks } = await ada.ok('GET', '/api/content-packs')
    expect(contentPacks).toEqual([
      expect.objectContaining({
        name: 'security-kit',
        items: expect.arrayContaining([
          { kind: 'skill', key: 'review-checklist', id: checklist.id, name: 'Review checklist' },
          { kind: 'workflow', key: 'triage', id: workflow.id, name: 'Security triage' },
        ]),
      }),
    ])
  })

  it('upgrades only what nobody changed, and never brings back what someone deleted', async () => {
    const { archetypes } = await ada.ok('GET', '/api/archetypes')
    const security = archetypes.find((archetype: { name: string }) => archetype.name === 'Security reviewer')
    await ada.ok('PUT', `/api/archetypes/${security.id}`, { systemPrompt: 'Our own prompt.' })
    const workflow = await triage()
    expect((await ada.request('DELETE', `/api/workflows/${workflow.id}`)).status).toBe(200)

    const next = await contentPack('1.1.0', { checklist: '# Checklist\n\n- Injection\n- Secrets', dropTone: true })
    const found = await plan(next)
    expect(found.replaces).toBe('1.0.0')
    expect(actions(found.items)).toEqual({
      'skill:review-checklist': 'update',
      'skill:review-tone': 'release',
      'archetype:security': 'keep',
      'workflow:triage': 'gone',
    })
    expect((await upload('/api/plugin-packages', next)).statusCode).toBe(200)
    expect((await skill('review-checklist')).markdown).toContain('Secrets')
    expect(await skill('review-tone')).toMatchObject({ markdown: 'Be kind.' })
    expect((await harness.deps.db('archetypes').where({ id: security.id }).first()).systemPrompt).toBe('Our own prompt.')
    expect(await harness.deps.db('workflows').where({ name: 'Security triage' }).whereNull('archivedAt').first()).toBeUndefined()
    expect(actions((await plan(next)).items)['workflow:triage']).toBe('gone')
  })

  it('takes back what it imported on removal, except what the organization made its own', async () => {
    const answer = await upload('/api/plugin-packages', await contentPack('1.2.0', { dropTone: true }))
    expect(answer.statusCode).toBe(200)
    const { contentPacks } = await ada.ok('GET', '/api/content-packs')
    const pack = contentPacks[0]
    const checklist = await skill('review-checklist')

    const removed = await ada.request('DELETE', `/api/content-packs/${pack.id}`)
    expect(removed.status).toBe(200)
    expect(removed.body.kept).toEqual(['Security reviewer'])
    expect(await harness.deps.db('skills').where({ id: checklist.id }).first()).toBeUndefined()
    expect(await skill('review-tone')).toBeDefined()
    expect(await harness.deps.db('archetypes').where({ name: 'Security reviewer' }).first()).toBeDefined()
    expect((await ada.ok('GET', '/api/content-packs')).contentPacks).toEqual([])
    expect((await ada.request('DELETE', `/api/content-packs/${pack.id}`)).status).toBe(404)
  })
})
