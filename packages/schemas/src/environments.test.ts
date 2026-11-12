// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are environment templates, not JavaScript ones
import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_EXAMPLE,
  type EnvironmentContext,
  environmentInput,
  filterSecrets,
  importSecretSets,
  maskSecrets,
  matchConnections,
  mergeEnv,
  parseEnvironment,
  readEnvironmentFile,
  resolveTemplate,
  startOrder,
  type TemplateValues,
  writeEnvironmentFile,
} from './environments'

const context = { repos: ['app'], secretSets: ['backend'] }

function issuesOf(source: string, ctx: EnvironmentContext = context) {
  return parseEnvironment(source, ctx).issues.map(({ message, line }) => ({ message, line }))
}

const values: TemplateValues = {
  services: { db: { host: 'db', port: 5432 }, api: { host: 'api', port: null } },
  preview: { url: 'http://abc.preview.localhost:4102', host: 'abc.preview.localhost' },
  repos: { app: { path: '/workspace/repos/app' } },
}

describe('parseEnvironment', () => {
  it('accepts the example as written', () => {
    const parsed = parseEnvironment(ENVIRONMENT_EXAMPLE, context)
    expect(parsed.issues).toEqual([])
    expect(Object.keys(parsed.definition?.services ?? {})).toEqual(['db', 'cache', 'api', 'web'])
    expect(parsed.definition?.services.api?.install).toEqual(['yarn install --frozen-lockfile'])
    expect(parsed.definition?.expose?.paths).toEqual([{ prefix: '/api', service: 'api' }])
  })

  it('treats an empty source as no environment', () => {
    expect(parseEnvironment('  \n', context)).toEqual({ definition: null, issues: [] })
  })

  it('points a YAML error at its line', () => {
    expect(issuesOf('services:\n  db:\n    image: postgres:16\n    image: postgres:17\n')).toEqual([{ message: 'Map keys must be unique', line: 4 }])
  })

  it('rejects settings it does not know, at their line, so nothing passes through to Docker', () => {
    expect(issuesOf('services:\n  db:\n    image: postgres:17\n    privileged: true\n')).toEqual([{ message: 'Unknown setting privileged', line: 4 }])
  })

  it('rejects a service name that is not a DNS label', () => {
    const issues = issuesOf('services:\n  Db_1:\n    image: postgres:17\n')
    expect(issues[0]?.message).toMatch(/lowercase letters/)
    expect(issues[0]?.line).toBe(2)
  })

  it('keeps names that Factorix uses on a preview network for itself', () => {
    expect(issuesOf('services:\n  factorix-egress:\n    image: x\n')).toEqual([
      { message: 'Names that start with factorix are taken by Factorix.', line: 2 },
    ])
  })

  it('needs an image or a repo, and a start command for repository code', () => {
    expect(issuesOf('services:\n  a:\n    port: 3000\n').map((issue) => issue.message)).toEqual(['Give this service an image, a repo, or both'])
    expect(issuesOf('services:\n  a:\n    repo: app\n').map((issue) => issue.message)).toEqual([
      'A service that runs repository code needs a start command',
    ])
    expect(issuesOf('services:\n  a:\n    image: node:22\n    install: yarn\n').map((issue) => issue.message)).toEqual(['install needs a repo'])
  })

  it('keeps mounts away from the paths the container needs', () => {
    const issues = issuesOf('services:\n  a:\n    image: x\n    files:\n      - { repo: app, path: db, to: /workspace/x }\n')
    expect(issues).toEqual([{ message: 'That path belongs to the container', line: 5 }])
    expect(issuesOf('services:\n  a:\n    image: x\n    files:\n      - { repo: app, path: ../etc, to: /x }\n')[0]?.message).toBe(
      'Use a path inside the repository',
    )
  })

  it('checks references to services, repositories, and secret sets', () => {
    const source = ['services:', '  api:', '    repo: other', '    start: yarn dev', '    secrets: [missing]', '    dependsOn: [nope]'].join('\n')
    expect(issuesOf(source)).toEqual([
      { message: 'This project has no repository named other.', line: 3 },
      { message: 'There is no service named nope.', line: 6 },
      { message: 'There is no secret set named missing. Add it under Secret sets.', line: 5 },
    ])
  })

  it('finds services that wait on each other', () => {
    const source = 'services:\n  a:\n    image: x\n    dependsOn: [b]\n  b:\n    image: x\n    dependsOn: [a]\n'
    expect(issuesOf(source)).toEqual([{ message: 'These services wait on each other: a → b → a.', line: 4 }])
  })

  it('checks template references and allows an escaped literal', () => {
    const source = [
      'services:',
      '  db:',
      '    image: postgres:17',
      '  api:',
      '    image: node:22',
      '    env:',
      '      A: ${services.db.host}',
      '      B: ${services.ghost.host}',
      '      C: $${HOME}',
      '      D: ${services.db.port}',
    ].join('\n')
    expect(issuesOf(source)).toEqual([
      { message: 'There is no service named ghost.', line: 8 },
      { message: 'db has no port.', line: 10 },
    ])
  })

  it('opens only a service with a port', () => {
    expect(issuesOf('services:\n  web:\n    image: x\nexpose:\n  service: web\n')).toEqual([{ message: 'web has no port to open.', line: 5 }])
    expect(issuesOf('services:\n  web:\n    image: x\nexpose:\n  service: web\n  port: 80\n')).toEqual([])
  })

  it('gives agent runs only image services, with everything they need', () => {
    const source = [
      'services:',
      '  db:',
      '    image: postgres:17',
      '  cache:',
      '    image: redis:7',
      '    dependsOn: [db]',
      '  api:',
      '    repo: app',
      '    start: yarn dev',
      'agents:',
      '  services: [api, cache]',
      '  env:',
      '    A: ${services.db.host}',
      '    B: ${preview.url}',
    ].join('\n')
    expect(issuesOf(source)).toEqual([
      { message: 'api runs repository code. Agents run their own, so list services that come from an image.', line: 11 },
      { message: 'cache needs db, so add that too.', line: 11 },
      { message: 'Agent runs do not start db. Add it to agents.services.', line: 13 },
      { message: 'Agent runs have no preview, so ${preview.url} means nothing here.', line: 14 },
    ])
  })

  it('refuses secret sets for agents, which never get secret values', () => {
    const source = 'services:\n  db:\n    image: postgres:17\nagents:\n  secrets: [backend]\n'
    expect(issuesOf(source)).toEqual([{ message: 'Agent runs never get secret values. Take out agents.secrets.', line: 5 }])
    const empty = parseEnvironment(source.replace('[backend]', '[]'), context)
    expect(empty.issues).toEqual([])
    expect(empty.definition?.agents).toEqual({ services: [], env: {} })
  })

  it('validates without a context, for checks that do not know the project yet', () => {
    expect(parseEnvironment('services:\n  api:\n    repo: anything\n    start: x\n').issues).toEqual([])
  })
})

describe('templates', () => {
  it('resolves references and unescapes literals', () => {
    expect(resolveTemplate('postgres://${services.db.host}:${services.db.port}/x', values)).toBe('postgres://db:5432/x')
    expect(resolveTemplate('${preview.url}/api and $${HOME}', values)).toBe('http://abc.preview.localhost:4102/api and ${HOME}')
    expect(resolveTemplate('${repos.app.path}/seed.sql', values)).toBe('/workspace/repos/app/seed.sql')
    expect(() => resolveTemplate('${nope}', values)).toThrow('Unknown reference ${nope}')
  })

  it('lets the definition override what a secret source provides', () => {
    const merged = mergeEnv([{ A: 'doppler', B: 'doppler', C: 'first' }, { C: 'second' }], { B: 'local:${services.db.host}' }, values)
    expect(merged).toEqual({ A: 'doppler', B: 'local:db', C: 'second' })
  })
})

describe('startOrder', () => {
  it('starts each service after what it depends on', () => {
    const parsed = parseEnvironment(ENVIRONMENT_EXAMPLE, context)
    if (!parsed.definition) throw new Error('example did not parse')
    expect(startOrder(parsed.definition)).toEqual([['cache', 'db'], ['api'], ['web']])
    expect(startOrder(parsed.definition, ['db', 'cache'])).toEqual([['cache', 'db']])
  })
})

describe('secrets', () => {
  it('narrows with only, then removes with except', () => {
    expect(filterSecrets({ A: '1', B: '2', C: '3' }, { only: [], except: ['B'] })).toEqual({ A: '1', C: '3' })
    expect(filterSecrets({ A: '1', B: '2', C: '3' }, { only: ['A', 'B'], except: ['B'] })).toEqual({ A: '1' })
  })

  it('masks values in logs, longest first, leaving short ones', () => {
    expect(maskSecrets('token=abcdef123 and abcdef and id=42', ['abcdef', 'abcdef123', '42'])).toBe('token=•••••• and •••••• and id=42')
  })

  it('refuses two sets with one name', () => {
    const set = { name: 'a', connectionId: '00000000-0000-4000-8000-000000000000' }
    expect(environmentInput.safeParse({ source: '', secretSets: [set, set] }).success).toBe(false)
  })
})

describe('environment files', () => {
  const doppler = { id: '00000000-0000-4000-8000-000000000001', name: 'Doppler', kind: 'doppler' }
  const registry = { id: '00000000-0000-4000-8000-000000000002', name: 'Registry', kind: 'generic' }
  const saved = [
    {
      name: 'backend',
      connectionId: doppler.id,
      connectionName: 'Doppler',
      connectionKind: 'doppler',
      project: 'backend',
      config: 'dev',
      only: [],
      except: ['DOPPLER_PROJECT'],
    },
    {
      name: 'local',
      connectionId: registry.id,
      connectionName: 'Registry',
      connectionKind: 'generic',
      project: null,
      config: null,
      only: ['NPM_TOKEN'],
      except: [],
    },
  ]

  it('carries the definition as typed and the secret sets without connection ids', () => {
    const text = writeEnvironmentFile({ project: 'Web', source: ENVIRONMENT_EXAMPLE, secretSets: saved })
    expect(text).not.toContain(doppler.id)
    expect(text).not.toContain(registry.id)
    expect(text.startsWith('# A Factorix environment, exported from Web.')).toBe(true)
    const { file, error } = readEnvironmentFile(text)
    expect(error).toBeUndefined()
    expect(file?.definition).toBe(ENVIRONMENT_EXAMPLE)
    expect(file?.secretSets).toEqual([
      {
        name: 'backend',
        source: 'doppler',
        connection: 'Doppler',
        project: 'backend',
        config: 'dev',
        only: [],
        except: ['DOPPLER_PROJECT'],
      },
      { name: 'local', source: 'generic', connection: 'Registry', project: null, config: null, only: ['NPM_TOKEN'], except: [] },
    ])
  })

  it('imports a file from when agents could read secret values, without that flag', () => {
    const { file } = readEnvironmentFile(
      'format: factorix/environment@1\ndefinition: ""\nsecretSets:\n  - { name: a, source: doppler, agents: true }\n',
    )
    expect(importSecretSets(file?.secretSets ?? [], { a: doppler.id })).toEqual([
      { name: 'a', connectionId: doppler.id, project: null, config: null, only: [], except: [] },
    ])
  })

  it('refuses files that are not environments, or that are malformed', () => {
    expect(readEnvironmentFile('services: {}').error).toMatch(/not a Factorix environment file/)
    expect(readEnvironmentFile('format: [').error).toMatch(/not valid YAML/)
    expect(readEnvironmentFile('format: factorix/environment@1\ndefinition: 3\n').error).toMatch(/^definition:/)
    const twice = 'format: factorix/environment@1\ndefinition: ""\nsecretSets:\n  - { name: a, source: doppler }\n  - { name: a, source: doppler }\n'
    expect(readEnvironmentFile(twice).error).toBe('Two secret sets are named a.')
    expect(readEnvironmentFile('format: factorix/environment@1\ndefinition: ""\nconnectionId: x\n').error).toBeDefined()
  })

  it('picks the connection with the same kind and name, else the only one of that kind', () => {
    const sets = readEnvironmentFile(writeEnvironmentFile({ project: 'Web', source: '', secretSets: saved })).file?.secretSets ?? []
    const other = { id: '00000000-0000-4000-8000-000000000003', name: 'Doppler staging', kind: 'doppler' }
    expect(matchConnections(sets, [doppler, registry, other])).toEqual({ backend: doppler.id, local: registry.id })
    expect(matchConnections(sets, [{ ...other }])).toEqual({ backend: other.id, local: null })
    expect(matchConnections(sets, [other, { ...other, id: '00000000-0000-4000-8000-000000000004', name: 'Doppler prod' }])).toEqual({
      backend: null,
      local: null,
    })
  })
})
