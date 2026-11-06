// biome-ignore-all lint/suspicious/noTemplateCurlyInString: definitions use ${...} templates
import { parseEnvironment } from '@factorix/schemas'
import { describe, expect, it } from 'vitest'
import { previewAddress, quote, readySeconds, reposUsed, serviceScript, serviceSpec, templateValues } from './preview-spec'

const source = `
services:
  db:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: local
    files:
      - repo: app
        path: database/init
        to: /docker-entrypoint-initdb.d
    data: /var/lib/postgresql/data
    ready:
      command: pg_isready -U postgres
  api:
    repo: app
    workdir: backend
    install: yarn install --frozen-lockfile
    setup: [yarn db:migrate, yarn db:seed]
    start: yarn dev --host 0.0.0.0
    port: 3000
    secrets: [backend]
    env:
      DATABASE_URL: postgres://postgres:local@\${services.db.host}:5432/app
      API_TOKEN: from-definition
      APP_ORIGIN: \${preview.url}
    ready:
      http: /health
    dependsOn: [db]
    resources:
      memoryMb: 3072
      cpus: 2
expose:
  service: api
`

const { definition, issues } = parseEnvironment(source, { repos: ['app', 'docs'], secretSets: ['backend'] })
if (!definition) throw new Error(JSON.stringify(issues))
const environment = { key: 'abcdefghij', network: 'fx-env-abcdefghij', sourceVolume: 'fx-envsrc-abcdefghij' }
const address = previewAddress('http://preview.localhost:4102', 'abcdefghij')
const context = {
  environment,
  values: templateValues(definition, address, ['app', 'docs']),
  secrets: new Map([['backend', { API_TOKEN: 'from-doppler', STRIPE_KEY: 'sk_test_123456', HTTP_PROXY: 'http://sneaky' }]]),
  platformEnv: { HTTP_PROXY: 'http://token:x@factorix-egress:8080', NO_PROXY: 'db,api' },
  dataGeneration: 3,
  labels: { 'factorix.issue': 'issue-1' },
}

describe('previewAddress', () => {
  it('puts each preview on its own subdomain of the base address', () => {
    expect(address).toEqual({ url: 'http://abcdefghij.preview.localhost:4102', host: 'abcdefghij.preview.localhost:4102' })
    expect(previewAddress('https://preview.example.com', 'abcdefghij').url).toBe('https://abcdefghij.preview.example.com')
  })
})

describe('serviceSpec', () => {
  it('layers secret sets, then the definition, then the platform, and resolves templates', () => {
    const spec = serviceSpec(definition, 'api', context)
    expect(spec.env).toMatchObject({
      HOME: '/workspace/.home',
      STRIPE_KEY: 'sk_test_123456',
      API_TOKEN: 'from-definition',
      DATABASE_URL: 'postgres://postgres:local@db:5432/app',
      APP_ORIGIN: 'http://abcdefghij.preview.localhost:4102',
      HTTP_PROXY: 'http://token:x@factorix-egress:8080',
    })
  })

  it('runs repository code from the source volume on the sandbox image', () => {
    const spec = serviceSpec(definition, 'api', context)
    expect(spec).toMatchObject({ repoCode: true, image: undefined, workdir: '/workspace/repos/app/backend' })
    expect(spec.mounts).toEqual([{ volume: 'fx-envsrc-abcdefghij', target: '/workspace', readOnly: false }])
    expect(spec.limits).toEqual({ memoryBytes: 3072 * 1024 * 1024, cpus: 2 })
    expect(spec.healthcheck).toContain("'http://127.0.0.1:3000/health'")
  })

  it('gives an image its data volume and read-only files from a repository', () => {
    const spec = serviceSpec(definition, 'db', context)
    expect(spec).toMatchObject({ repoCode: false, image: 'postgres:17', script: undefined, healthcheck: 'pg_isready -U postgres' })
    expect(spec.env.HOME).toBeUndefined()
    expect(spec.mounts).toEqual([
      { volume: 'fx-envdata-abcdefghij-db', target: '/var/lib/postgresql/data', readOnly: false },
      { volume: 'fx-envsrc-abcdefghij', target: '/docker-entrypoint-initdb.d', readOnly: true, subpath: 'repos/app/database/init' },
    ])
  })
})

describe('serviceScript', () => {
  it('installs every time, sets up once per data generation, then hands over to start', () => {
    const script = serviceScript(definition, 'api', 3) as string
    expect(script.split('\n')).toEqual([
      'set -e',
      "cd '/workspace/repos/app/backend'",
      "echo '[factorix] install: yarn install --frozen-lockfile'",
      'yarn install --frozen-lockfile',
      "if [ ! -e '/workspace/.factorix/setup/api-3' ]; then",
      "echo '[factorix] setup: yarn db:migrate'",
      'yarn db:migrate',
      "echo '[factorix] setup: yarn db:seed'",
      'yarn db:seed',
      "mkdir -p /workspace/.factorix/setup && touch '/workspace/.factorix/setup/api-3'",
      'fi',
      "echo '[factorix] start: yarn dev --host 0.0.0.0'",
      "exec sh -c 'yarn dev --host 0.0.0.0'",
    ])
    expect(serviceScript(definition, 'db', 3)).toBeUndefined()
  })

  it('quotes commands so a quote in them cannot break out', () => {
    expect(quote("it's")).toBe(`'it'\\''s'`)
  })
})

describe('reposUsed and readySeconds', () => {
  it('copies in only the repositories a service runs or mounts', () => {
    expect(reposUsed(definition)).toEqual(['app'])
  })

  it('waits longer for repository services, which install first', () => {
    expect(readySeconds(definition, 'api')).toBe(900)
    expect(readySeconds(definition, 'db')).toBe(180)
  })
})
