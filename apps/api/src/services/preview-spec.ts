import { type Environment, environmentDataVolume, type ServiceSpec } from '@factorix/sandbox'
import { type EnvironmentDefinition, mergeEnv, type TemplateValues } from '@factorix/schemas'

export const REPOS_ROOT = '/workspace/repos'
const DEFAULT_READY_SECONDS = { repo: 900, image: 180 }

export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function previewAddress(baseUrl: string, slug: string): { url: string; host: string } {
  const base = new URL(baseUrl)
  const host = `${slug}.${base.host}`
  return { url: `${base.protocol}//${host}`, host }
}

export function templateValues(definition: EnvironmentDefinition, preview: { url: string; host: string }, repos: string[]): TemplateValues {
  return {
    services: Object.fromEntries(Object.entries(definition.services).map(([name, entry]) => [name, { host: name, port: entry.port ?? null }])),
    preview,
    repos: Object.fromEntries(repos.map((repo) => [repo, { path: `${REPOS_ROOT}/${repo}` }])),
  }
}

/** Repositories a definition runs code from or mounts files from, so only those are copied in. */
export function reposUsed(definition: EnvironmentDefinition): string[] {
  const names = new Set<string>()
  for (const entry of Object.values(definition.services)) {
    if (entry.repo) names.add(entry.repo)
    for (const file of entry.files) names.add(file.repo)
  }
  return [...names].sort()
}

export function readySeconds(definition: EnvironmentDefinition, service: string): number {
  const entry = definition.services[service]
  return entry?.ready?.timeoutSeconds ?? (entry?.repo ? DEFAULT_READY_SECONDS.repo : DEFAULT_READY_SECONDS.image)
}

/** Ready once something answers below 500, with whichever client the image has. */
function httpProbe(port: number, path: string): string {
  const url = quote(`http://127.0.0.1:${port}${path}`)
  return [
    `if command -v node >/dev/null 2>&1; then node -e 'fetch(process.argv[1]).then((r)=>process.exit(r.status<500?0:1),()=>process.exit(1))' ${url}`,
    `elif command -v curl >/dev/null 2>&1; then code=$(curl -s -o /dev/null -w '%{http_code}' ${url}); [ "$code" -ge 200 ] && [ "$code" -lt 500 ]`,
    `else wget -q -O /dev/null ${url}; fi`,
  ].join('; ')
}

/**
 * Install runs on every start so a changed lockfile is picked up. Setup runs once per data generation, which
 * "Reset data" moves on, so seeding follows the database it filled.
 */
export function serviceScript(definition: EnvironmentDefinition, service: string, dataGeneration: number): string | undefined {
  const entry = definition.services[service]
  if (!entry?.repo || !entry.start) return undefined
  const lines = ['set -e', `cd ${quote(workdirOf(definition, service) as string)}`]
  for (const command of entry.install) lines.push(`echo ${quote(`[factorix] install: ${command}`)}`, command)
  if (entry.setup.length > 0) {
    const marker = quote(`/workspace/.factorix/setup/${service}-${dataGeneration}`)
    lines.push(`if [ ! -e ${marker} ]; then`)
    for (const command of entry.setup) lines.push(`echo ${quote(`[factorix] setup: ${command}`)}`, command)
    lines.push(`mkdir -p /workspace/.factorix/setup && touch ${marker}`, 'fi')
  }
  lines.push(`echo ${quote(`[factorix] start: ${entry.start}`)}`, `exec sh -c ${quote(entry.start)}`)
  return lines.join('\n')
}

function workdirOf(definition: EnvironmentDefinition, service: string): string | undefined {
  const entry = definition.services[service]
  if (!entry?.repo) return undefined
  return [REPOS_ROOT, entry.repo, entry.workdir].filter(Boolean).join('/')
}

export interface ServiceContext {
  environment: Environment
  values: TemplateValues
  /** Values of each secret set by name. */
  secrets: Map<string, Record<string, string>>
  /** Proxy settings and the like. They win over the definition, which cannot route around the egress proxy. */
  platformEnv: Record<string, string>
  dataGeneration: number
  labels: Record<string, string>
}

export function serviceSpec(definition: EnvironmentDefinition, service: string, context: ServiceContext): ServiceSpec {
  const entry = definition.services[service]
  if (!entry) throw new Error(`There is no service named ${service}`)
  const repoCode = Boolean(entry.repo)
  const env = {
    ...(repoCode ? { HOME: '/workspace/.home' } : {}),
    ...mergeEnv(
      entry.secrets.map((set) => context.secrets.get(set) ?? {}),
      entry.env,
      context.values,
    ),
    ...context.platformEnv,
  }
  const mounts: ServiceSpec['mounts'] = []
  if (repoCode) mounts.push({ volume: context.environment.sourceVolume, target: '/workspace', readOnly: false })
  if (entry.data) mounts.push({ volume: environmentDataVolume(context.environment.key, service), target: entry.data, readOnly: false })
  for (const file of entry.files) {
    mounts.push({ volume: context.environment.sourceVolume, target: file.to, readOnly: true, subpath: `repos/${file.repo}/${file.path}` })
  }
  const healthcheck = entry.ready?.command ?? (entry.ready?.http && entry.port ? httpProbe(entry.port, entry.ready.http) : undefined)
  return {
    service,
    image: entry.image,
    repoCode,
    script: serviceScript(definition, service, context.dataGeneration),
    workdir: workdirOf(definition, service),
    env,
    mounts,
    healthcheck,
    limits: {
      ...(entry.resources?.memoryMb ? { memoryBytes: entry.resources.memoryMb * 1024 * 1024 } : {}),
      ...(entry.resources?.cpus ? { cpus: entry.resources.cpus } : {}),
    },
    labels: context.labels,
  }
}
