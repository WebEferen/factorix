import { Document, isMap, isScalar, LineCounter, type Node, parse, parseDocument } from 'yaml'
import { z } from 'zod'

const NAME = /^[a-z][a-z0-9-]{0,30}$/
const name = z.string().regex(NAME, 'Use lowercase letters, digits, and dashes, starting with a letter')
const repoName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use the name of one of the project’s repositories')
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits, and underscores, not starting with a digit')
const command = z.string().trim().min(1, 'Write a command').max(4000)
const commands = z
  .union([command.transform((one) => [one]), z.array(command).max(20)])
  .optional()
  .transform((value) => value ?? [])
const port = z.number().int('Use a whole number').min(1).max(65535)
const relativePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'Use a path inside the repository')
const RESERVED_PATHS = ['/proc', '/sys', '/dev', '/workspace', '/opt/factorix', '/run/factorix']
const containerPath = z
  .string()
  .trim()
  .regex(/^\/[^\0]+$/, 'Use an absolute path')
  .max(300)
  .refine((path) => !path.split('/').includes('..'), 'Use a path without ..')
  .refine((path) => !RESERVED_PATHS.some((reserved) => path === reserved || path.startsWith(`${reserved}/`)), 'That path belongs to the container')
const image = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._/:@-]{0,254}$/, 'Use an image reference such as postgres:17')
const envValue = z.union([z.string().max(20_000), z.number(), z.boolean()]).transform(String)
const envMap = z
  .record(envKey, envValue)
  .optional()
  .transform((value) => value ?? {})
const names = z
  .array(name)
  .max(20)
  .optional()
  .transform((value) => value ?? [])

const ready = z
  .strictObject({
    command: command.optional(),
    http: z
      .string()
      .regex(/^\/\S*$/, 'Use a path that starts with /')
      .optional(),
    timeoutSeconds: z.number().int().min(5).max(3600).optional(),
  })
  .refine((check) => !(check.command && check.http), 'Use either command or http')

const service = z
  .strictObject({
    image: image.optional(),
    repo: repoName.optional(),
    workdir: relativePath.optional(),
    install: commands,
    setup: commands,
    start: command.optional(),
    port: port.optional(),
    ready: ready.optional(),
    env: envMap,
    secrets: names,
    files: z
      .array(z.strictObject({ repo: repoName, path: relativePath, to: containerPath }))
      .max(20)
      .optional()
      .transform((value) => value ?? []),
    data: containerPath.optional(),
    dependsOn: names,
    resources: z
      .strictObject({ memoryMb: z.number().int().min(128).max(32_768).optional(), cpus: z.number().min(0.1).max(16).optional() })
      .optional(),
  })
  .superRefine((entry, context) => {
    if (!entry.image && !entry.repo) context.addIssue({ code: 'custom', message: 'Give this service an image, a repo, or both', path: [] })
    if (entry.repo && !entry.start)
      context.addIssue({ code: 'custom', message: 'A service that runs repository code needs a start command', path: ['start'] })
    if (entry.repo) return
    if (entry.workdir) context.addIssue({ code: 'custom', message: 'workdir needs a repo', path: ['workdir'] })
    if (entry.install.length > 0) context.addIssue({ code: 'custom', message: 'install needs a repo', path: ['install'] })
    if (entry.setup.length > 0) context.addIssue({ code: 'custom', message: 'setup needs a repo', path: ['setup'] })
  })

const pathRule = z.strictObject({
  prefix: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/, 'Use a path that starts with /'),
  service: name,
  port: port.optional(),
  strip: z.boolean().optional(),
})

export const environmentDefinition = z.strictObject({
  services: z
    .record(name, service)
    .refine((services) => Object.keys(services).length > 0, 'Add at least one service')
    .refine((services) => Object.keys(services).length <= 20, 'Use at most 20 services'),
  expose: z
    .strictObject({
      service: name,
      port: port.optional(),
      paths: z
        .array(pathRule)
        .max(20)
        .optional()
        .transform((value) => value ?? []),
    })
    .optional(),
  agents: z
    .strictObject({ services: names, secrets: names, env: envMap })
    .optional()
    .transform((value) => value ?? { services: [], secrets: [], env: {} }),
  notes: z.string().max(4000).optional(),
})
export type EnvironmentDefinition = z.output<typeof environmentDefinition>
export type EnvironmentService = EnvironmentDefinition['services'][string]

export interface EnvironmentIssue {
  path: (string | number)[]
  message: string
  /** 1-based line in the YAML source, when the issue points at something in it. */
  line: number | null
}

export interface EnvironmentContext {
  repos?: string[]
  secretSets?: string[]
  /** Sets marked "Agents can read these values", the only ones agents.secrets may name. */
  agentSecretSets?: string[]
}

const TEMPLATE = /\$(\$)?\{([^}]*)\}/g

/** The references a value uses, without the escaped `$${...}` ones. */
export function templateReferences(value: string): string[] {
  return [...value.matchAll(TEMPLATE)].filter((match) => !match[1]).map((match) => (match[2] ?? '').trim())
}

export interface TemplateValues {
  /** Service name to the host other containers reach it on. */
  services: Record<string, { host: string; port: number | null }>
  preview: { url: string; host: string }
  repos: Record<string, { path: string }>
}

export function resolveTemplate(value: string, values: TemplateValues): string {
  return value.replace(TEMPLATE, (whole, escaped: string | undefined, reference: string) => {
    if (escaped) return whole.slice(1)
    const [scope, key, field] = reference.trim().split('.')
    if (scope === 'preview' && (key === 'url' || key === 'host') && field === undefined) return values.preview[key]
    if (scope === 'services' && key && (field === 'host' || field === 'port')) {
      const target = values.services[key]
      if (target) return field === 'host' ? target.host : String(target.port ?? '')
    }
    if (scope === 'repos' && key && field === 'path') {
      const target = values.repos[key]
      if (target) return target.path
    }
    throw new Error(`Unknown reference \${${reference}}`)
  })
}

function checkTemplate(
  reference: string,
  definition: EnvironmentDefinition,
  context: EnvironmentContext,
  running: Set<string> | null,
): string | null {
  const [scope, key, field, extra] = reference.split('.')
  const literal = `Use $\${${reference}} for a literal \${${reference}}.`
  if (extra !== undefined) return `Unknown reference \${${reference}}. ${literal}`
  if (scope === 'preview' && (key === 'url' || key === 'host') && field === undefined) {
    return running ? `Agent runs have no preview, so \${${reference}} means nothing here.` : null
  }
  if (scope === 'services' && key && (field === 'host' || field === 'port')) {
    const target = definition.services[key]
    if (!target) return `There is no service named ${key}.`
    if (running && !running.has(key)) return `Agent runs do not start ${key}. Add it to agents.services.`
    if (field === 'port' && target.port === undefined) return `${key} has no port.`
    return null
  }
  if (scope === 'repos' && key && field === 'path') {
    return context.repos && !context.repos.includes(key) ? `This project has no repository named ${key}.` : null
  }
  return `Unknown reference \${${reference}}. Use services.<name>.host, services.<name>.port, preview.url, preview.host, or repos.<name>.path. ${literal}`
}

/** Checks what the schema cannot see: references between services, repositories, secret sets, and templates. */
export function checkEnvironment(definition: EnvironmentDefinition, context: EnvironmentContext = {}): Omit<EnvironmentIssue, 'line'>[] {
  const issues: Omit<EnvironmentIssue, 'line'>[] = []
  const add = (path: (string | number)[], message: string) => issues.push({ path, message })
  const services = definition.services
  const hasPort = (serviceName: string, port: number | undefined) => port !== undefined || services[serviceName]?.port !== undefined

  for (const [serviceName, entry] of Object.entries(services)) {
    if (serviceName.startsWith('factorix')) add(['services', serviceName], 'Names that start with factorix are taken by Factorix.')
    if (entry.repo && context.repos && !context.repos.includes(entry.repo))
      add(['services', serviceName, 'repo'], `This project has no repository named ${entry.repo}.`)
    entry.files.forEach((file, index) => {
      if (context.repos && !context.repos.includes(file.repo))
        add(['services', serviceName, 'files', index, 'repo'], `This project has no repository named ${file.repo}.`)
    })
    entry.dependsOn.forEach((dependency, index) => {
      if (dependency === serviceName) add(['services', serviceName, 'dependsOn', index], 'A service cannot depend on itself.')
      else if (!services[dependency]) add(['services', serviceName, 'dependsOn', index], `There is no service named ${dependency}.`)
    })
    entry.secrets.forEach((set, index) => {
      if (context.secretSets && !context.secretSets.includes(set))
        add(['services', serviceName, 'secrets', index], `There is no secret set named ${set}. Add it under Secret sets.`)
    })
    for (const [key, value] of Object.entries(entry.env)) {
      for (const reference of templateReferences(value)) {
        const problem = checkTemplate(reference, definition, context, null)
        if (problem) add(['services', serviceName, 'env', key], problem)
      }
    }
    if (entry.ready?.http && entry.port === undefined) add(['services', serviceName, 'ready', 'http'], 'An http check needs the service’s port.')
  }

  const cycle = findCycle(definition)
  if (cycle) add(['services', cycle[0] as string, 'dependsOn'], `These services wait on each other: ${cycle.join(' → ')}.`)

  if (definition.expose) {
    const { expose } = definition
    if (!services[expose.service]) add(['expose', 'service'], `There is no service named ${expose.service}.`)
    else if (!hasPort(expose.service, expose.port)) add(['expose', 'service'], `${expose.service} has no port to open.`)
    expose.paths.forEach((rule, index) => {
      if (!services[rule.service]) add(['expose', 'paths', index, 'service'], `There is no service named ${rule.service}.`)
      else if (!hasPort(rule.service, rule.port)) add(['expose', 'paths', index, 'service'], `${rule.service} has no port.`)
    })
  }

  const running = new Set(definition.agents.services)
  definition.agents.services.forEach((serviceName, index) => {
    const entry = services[serviceName]
    if (!entry) add(['agents', 'services', index], `There is no service named ${serviceName}.`)
    else if (entry.repo)
      add(['agents', 'services', index], `${serviceName} runs repository code. Agents run their own, so list services that come from an image.`)
    else {
      for (const dependency of entry.dependsOn) {
        if (!running.has(dependency)) add(['agents', 'services', index], `${serviceName} needs ${dependency}, so add that too.`)
      }
    }
  })
  definition.agents.secrets.forEach((set, index) => {
    if (context.secretSets && !context.secretSets.includes(set)) add(['agents', 'secrets', index], `There is no secret set named ${set}.`)
    else if (context.agentSecretSets && !context.agentSecretSets.includes(set))
      add(['agents', 'secrets', index], `Turn on Agents can read these values for ${set} under Secret sets, or take it out of agents.secrets.`)
  })
  for (const [key, value] of Object.entries(definition.agents.env)) {
    for (const reference of templateReferences(value)) {
      const problem = checkTemplate(reference, definition, context, running)
      if (problem) add(['agents', 'env', key], problem)
    }
  }
  return issues
}

function findCycle(definition: EnvironmentDefinition): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (serviceName: string): string[] | null => {
    if (state.get(serviceName) === 'done') return null
    if (state.get(serviceName) === 'visiting') return [...stack.slice(stack.indexOf(serviceName)), serviceName]
    state.set(serviceName, 'visiting')
    stack.push(serviceName)
    for (const dependency of definition.services[serviceName]?.dependsOn ?? []) {
      if (!definition.services[dependency] || dependency === serviceName) continue
      const found = visit(dependency)
      if (found) return found
    }
    stack.pop()
    state.set(serviceName, 'done')
    return null
  }
  for (const serviceName of Object.keys(definition.services)) {
    const found = visit(serviceName)
    if (found) return found
  }
  return null
}

/** Groups services into waves: each wave only needs services from earlier ones. Assumes a definition that passed `checkEnvironment`. */
export function startOrder(definition: EnvironmentDefinition, only?: string[]): string[][] {
  const wanted = new Set(only ?? Object.keys(definition.services))
  const placed = new Set<string>()
  const waves: string[][] = []
  while (placed.size < wanted.size) {
    const wave = [...wanted].filter(
      (serviceName) =>
        !placed.has(serviceName) &&
        (definition.services[serviceName]?.dependsOn ?? []).every((dependency) => placed.has(dependency) || !wanted.has(dependency)),
    )
    if (wave.length === 0) throw new Error('These services wait on each other')
    for (const serviceName of wave) placed.add(serviceName)
    waves.push(wave.sort())
  }
  return waves
}

/** Secret-set values first, then the service's own env, so a definition can replace any value a source provides. */
export function mergeEnv(sets: Record<string, string>[], own: Record<string, string>, values: TemplateValues): Record<string, string> {
  const merged: Record<string, string> = Object.assign({}, ...sets)
  for (const [key, value] of Object.entries(own)) merged[key] = resolveTemplate(value, values)
  return merged
}

/** Replaces secret values in text shown to people. Short values are left alone, since they would mask ordinary words. */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let masked = text
  const sorted = [...new Set(secrets)].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length)
  for (const value of sorted) masked = masked.split(value).join('••••••')
  return masked
}

function lineAt(lineCounter: LineCounter, offset: number | undefined): number | null {
  return offset === undefined ? null : lineCounter.linePos(offset).line
}

/** The line of the node at `path`, or of the closest thing above it that exists. */
function lineOfPath(document: ReturnType<typeof parseDocument>, lineCounter: LineCounter, path: (string | number)[], key?: string): number | null {
  for (let depth = path.length; depth >= 0; depth--) {
    const node = (depth === 0 ? document.contents : document.getIn(path.slice(0, depth), true)) as Node | null | undefined
    if (!node) continue
    if (key && depth === path.length && isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && item.key.value === key)
      if (pair && isScalar(pair.key)) return lineAt(lineCounter, pair.key.range?.[0])
    }
    if (depth < path.length && isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && item.key.value === path[depth])
      if (pair && isScalar(pair.key)) return lineAt(lineCounter, pair.key.range?.[0])
    }
    return lineAt(lineCounter, node.range?.[0])
  }
  return null
}

export interface ParsedEnvironment {
  /** Null for an empty source, which means the project has no environment. */
  definition: EnvironmentDefinition | null
  issues: EnvironmentIssue[]
}

export function parseEnvironment(source: string, context: EnvironmentContext = {}): ParsedEnvironment {
  if (source.trim() === '') return { definition: null, issues: [] }
  const lineCounter = new LineCounter()
  const document = parseDocument(source, { lineCounter, uniqueKeys: true, prettyErrors: false })
  if (document.errors.length > 0) {
    return {
      definition: null,
      issues: document.errors.map((error) => ({
        path: [],
        message: error.message.split('\n')[0] ?? error.message,
        line: lineAt(lineCounter, error.pos[0]),
      })),
    }
  }
  let raw: unknown
  try {
    raw = document.toJS({ maxAliasCount: 20 })
  } catch (error) {
    return { definition: null, issues: [{ path: [], message: (error as Error).message, line: null }] }
  }
  const parsed = environmentDefinition.safeParse(raw ?? {})
  if (!parsed.success) {
    return {
      definition: null,
      issues: parsed.error.issues.flatMap((issue) => {
        const path = issue.path as (string | number)[]
        if (issue.code === 'unrecognized_keys') {
          return issue.keys.map((key) => ({
            path: [...path, key],
            message: `Unknown setting ${key}`,
            line: lineOfPath(document, lineCounter, path, key),
          }))
        }
        if (issue.code === 'invalid_key') {
          return [
            {
              path,
              message: `${String(path.at(-1))}: ${issue.issues[0]?.message ?? issue.message}`,
              line: lineOfPath(document, lineCounter, path.slice(0, -1), String(path.at(-1))),
            },
          ]
        }
        return [{ path, message: issue.message, line: lineOfPath(document, lineCounter, path) }]
      }),
    }
  }
  // A path that ends in a name points at that key's line, where a nested value would start one line lower.
  const lineOf = (path: (string | number)[]) =>
    typeof path.at(-1) === 'string'
      ? lineOfPath(document, lineCounter, path.slice(0, -1), String(path.at(-1)))
      : lineOfPath(document, lineCounter, path)
  const issues = checkEnvironment(parsed.data, context).map((issue) => ({ ...issue, line: lineOf(issue.path) }))
  return { definition: issues.length > 0 ? null : parsed.data, issues }
}

export const secretSetInput = z.strictObject({
  name,
  connectionId: z.uuid(),
  project: z.string().trim().min(1).max(200).nullable().default(null),
  config: z.string().trim().min(1).max(200).nullable().default(null),
  only: z.array(envKey).max(1000).default([]),
  except: z.array(envKey).max(1000).default([]),
  /** Agent runs may receive these values. Code in the run can read them, so this is off unless someone turns it on. */
  agents: z.boolean().default(false),
})
export type SecretSetInput = z.infer<typeof secretSetInput>

export const environmentInput = z
  .object({
    source: z.string().max(200_000),
    secretSets: z.array(secretSetInput).max(20).default([]),
  })
  .superRefine((input, context) => {
    const seen = new Set<string>()
    input.secretSets.forEach((set, index) => {
      if (seen.has(set.name))
        context.addIssue({ code: 'custom', message: `Two secret sets are named ${set.name}`, path: ['secretSets', index, 'name'] })
      seen.add(set.name)
    })
  })
export type EnvironmentInput = z.infer<typeof environmentInput>

/** Keeps the keys a set asks for: `only` narrows, then `except` removes. */
export function filterSecrets(values: Record<string, string>, set: Pick<SecretSetInput, 'only' | 'except'>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (set.only.length > 0 && !set.only.includes(key)) continue
    if (set.except.includes(key)) continue
    kept[key] = value
  }
  return kept
}

export interface SecretSetDto extends SecretSetInput {
  connectionName: string | null
  connectionKind: string | null
}

/** Marks a file as a Factorix environment, and the version of its shape. */
export const ENVIRONMENT_FILE_FORMAT = 'factorix/environment@1'

const portableSecretSet = z.strictObject({
  name,
  /** The kind of connection it reads, such as doppler. Whoever imports it picks one of theirs. */
  source: z.string().trim().min(1).max(40),
  /** The connection's name where it was exported, which picks the same one when imported into the same Factorix. */
  connection: z.string().trim().max(200).optional(),
  project: z.string().trim().min(1).max(200).nullable().default(null),
  config: z.string().trim().min(1).max(200).nullable().default(null),
  only: z.array(envKey).max(1000).default([]),
  except: z.array(envKey).max(1000).default([]),
  agents: z.boolean().default(false),
})
export type PortableSecretSet = z.infer<typeof portableSecretSet>

export const environmentFile = z.strictObject({
  format: z.literal(ENVIRONMENT_FILE_FORMAT),
  /** The project it came from, for whoever reads the file. */
  project: z.string().max(200).optional(),
  definition: z.string().max(200_000),
  secretSets: z.array(portableSecretSet).max(20).default([]),
})
export type EnvironmentFile = z.infer<typeof environmentFile>

/** A file teammates or another Factorix can import. Connections appear by kind and name, never by id, and no values are in it. */
export function writeEnvironmentFile(input: { project: string; source: string; secretSets: SecretSetDto[] }): string {
  const document = new Document({
    format: ENVIRONMENT_FILE_FORMAT,
    project: input.project,
    definition: input.source,
    secretSets: input.secretSets.map((set) => ({
      name: set.name,
      source: set.connectionKind ?? 'unknown',
      ...(set.connectionName ? { connection: set.connectionName } : {}),
      ...(set.project ? { project: set.project } : {}),
      ...(set.config ? { config: set.config } : {}),
      ...(set.only.length > 0 ? { only: set.only } : {}),
      ...(set.except.length > 0 ? { except: set.except } : {}),
      ...(set.agents ? { agents: true } : {}),
    })),
  })
  document.commentBefore = ` A Factorix environment, exported from ${input.project}. Import it on a project's Environment page.\n It holds no secret values. Each secret set names its source, and the import picks one of your connections for it.`
  return document.toString({ lineWidth: 0 })
}

export function readEnvironmentFile(text: string): { file: EnvironmentFile; error?: undefined } | { file?: undefined; error: string } {
  let value: unknown
  try {
    value = parse(text)
  } catch (error) {
    return { error: `This file is not valid YAML: ${(error as Error).message.split('\n')[0]}` }
  }
  if (!value || typeof value !== 'object' || (value as { format?: unknown }).format !== ENVIRONMENT_FILE_FORMAT)
    return { error: 'This is not a Factorix environment file. Export one from a project’s Environment page.' }
  const parsed = environmentFile.safeParse(value)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    return { error: `${issue?.path.join('.') || 'The file'}: ${issue?.message ?? 'is not valid'}` }
  }
  const names = parsed.data.secretSets.map((set) => set.name)
  const repeated = names.find((set, index) => names.indexOf(set) !== index)
  if (repeated) return { error: `Two secret sets are named ${repeated}.` }
  return { file: parsed.data }
}

/** Picks a connection for each imported set: the one with the same kind and name, else the only one of that kind. */
export function matchConnections(
  sets: PortableSecretSet[],
  connections: { id: string; name: string; kind: string }[],
): Record<string, string | null> {
  return Object.fromEntries(
    sets.map((set) => {
      const candidates = connections.filter((connection) => connection.kind === set.source)
      const named = candidates.find((connection) => connection.name === set.connection)
      return [set.name, named?.id ?? (candidates.length === 1 ? (candidates[0]?.id ?? null) : null)]
    }),
  )
}

/** The sets to save after an import, each on the connection picked for it. A set left without one stays out. */
export function importSecretSets(sets: PortableSecretSet[], chosen: Record<string, string | null>): SecretSetInput[] {
  return sets.flatMap(({ source: _source, connection: _connection, ...set }) => {
    const connectionId = chosen[set.name]
    return connectionId ? [{ ...set, connectionId }] : []
  })
}

export interface EnvironmentDto {
  projectId: string
  source: string
  secretSets: SecretSetDto[]
  version: number
  updatedAt: string | null
  updatedBy: { id: string; name: string } | null
}

export interface SecretSetTestDto {
  name: string
  ok: boolean
  message: string | null
  /** Key names only. Values never leave the API. */
  keys: string[]
}

export interface EnvironmentTestDto {
  issues: EnvironmentIssue[]
  sets: SecretSetTestDto[]
}

export interface SecretSourceOptionDto {
  id: string
  name: string
  detail: string | null
}

export type PreviewState = 'starting' | 'ready' | 'refreshing' | 'stopping' | 'stopped' | 'failed'

export interface PreviewServiceDto {
  name: string
  state: 'waiting' | 'starting' | 'ready' | 'failed' | 'stopped'
  message: string | null
  /** The repository it runs code from, or null for an image. */
  repo: string | null
  image: string | null
}

export interface PreviewDto {
  /** Why this issue cannot have a preview, or null when it can. */
  unavailable: string | null
  /** Null until the first start. */
  state: PreviewState | null
  url: string | null
  services: PreviewServiceDto[]
  commits: { repo: string; ref: string; sha: string }[]
  /** Pushed code, or an agent's working copy that it asked for mid-run and has not pushed. */
  source: 'branch' | 'worktree' | null
  error: string | null
  startedBy: { id: string; name: string } | null
  startedAt: string | null
  readyAt: string | null
  lastSeenAt: string | null
  /** When it stops by itself: the time limit, or sooner when nobody opens it. */
  stopsAt: string | null
  definitionVersion: number | null
  /** Differs from definitionVersion when the environment changed after this preview started. */
  currentVersion: number | null
  notes: string | null
}

export interface PreviewOpenDto {
  url: string
}

export const previewOpenInput = z.strictObject({
  path: z
    .string()
    .max(2000)
    .regex(/^\/(?!\/)/, 'Use a path on the preview, starting with one /')
    .optional(),
})

export interface PreviewLogDto {
  /** Orders entries across reconnects. Zero for messages that are only shown live, such as blocked requests. */
  seq: number
  ts: number
  /** A service name, or factorix for what Factorix itself did. */
  service: string
  text: string
  error?: boolean
}

export const ENVIRONMENT_EXAMPLE = `# How to run this project for previews and agent runs.
# Each service is a container. Services reach each other by name,
# so servers must listen on 0.0.0.0, not localhost.
services:
  db:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: local
      POSTGRES_DB: app
    data: /var/lib/postgresql/data      # kept across refreshes, cleared by Reset data
    ready:
      command: pg_isready -U postgres

  cache:
    image: redis:7
    ready:
      command: redis-cli ping

  api:
    repo: app                           # one of this project's repositories
    workdir: backend
    install: yarn install --frozen-lockfile
    setup: yarn db:seed                 # runs once, on a fresh database
    start: yarn dev
    port: 3000
    secrets: [backend]                  # secret sets, defined under Secret sets
    env:
      DATABASE_URL: postgres://postgres:local@\${services.db.host}:5432/app
      REDIS_URL: redis://\${services.cache.host}:6379
      APP_ORIGIN: \${preview.url}
    dependsOn: [db, cache]

  web:
    repo: app
    workdir: frontend
    install: yarn install --frozen-lockfile
    start: yarn dev --port 8001
    port: 8001
    env:
      API_URL: \${preview.url}/api
    dependsOn: [api]

# What a preview opens. Paths send parts of the site to other services.
expose:
  service: web
  paths:
    - prefix: /api
      service: api

# What agent runs get next to their own code.
agents:
  services: [db, cache]
  secrets: []
  env:
    DATABASE_URL: postgres://postgres:local@\${services.db.host}:5432/app

notes: Sign in with the user the seed creates.
`
