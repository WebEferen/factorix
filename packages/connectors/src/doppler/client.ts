import type { SecretConfig, SecretProject, SecretScope, SecretSource, SecretSourceConnector } from '../secrets'

const API_URL = 'https://api.doppler.com'
const PAGE_SIZE = 100

const HELP: Record<number, string> = {
  401: 'Doppler rejected the token.',
  403: 'This Doppler token cannot read that.',
  404: 'Doppler has no such project or config.',
  429: 'Doppler asked to slow down. Try again in a minute.',
}

/** The token stays in the worker, so agents and previews reach none of Doppler's hosts. */
export const dopplerSource: SecretSource = { label: 'Doppler', scoped: true, egressHosts: () => [] }

export class DopplerConnector implements SecretSourceConnector {
  readonly kind = 'doppler' as const
  private readonly token: string
  private readonly apiUrl: string
  private readonly http: typeof fetch

  constructor(options: { token: string; apiUrl?: string; fetch?: typeof fetch }) {
    this.token = options.token
    this.apiUrl = (options.apiUrl ?? API_URL).replace(/\/+$/, '')
    this.http = options.fetch ?? fetch
  }

  private async get(path: string, query: Record<string, string | number | null | undefined> = {}): Promise<Response> {
    const url = new URL(`${this.apiUrl}${path}`)
    for (const [key, value] of Object.entries(query))
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value))
    return this.http(url, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  }

  private async json<T>(path: string, query?: Record<string, string | number | null | undefined>): Promise<T> {
    const response = await this.get(path, query)
    if (!response.ok) throw new Error(HELP[response.status] ?? `Doppler returned ${response.status}`)
    return (await response.json()) as T
  }

  async viewer(): Promise<{ name: string }> {
    const me = await this.json<{ name?: string; slug?: string; type?: string; workplace?: { name?: string } }>('/v3/me')
    const who = me.name || me.slug || me.type || 'token'
    return { name: me.workplace?.name ? `${who} in ${me.workplace.name}` : who }
  }

  async listProjects(): Promise<SecretProject[] | null> {
    const projects: SecretProject[] = []
    for (let page = 1; ; page++) {
      const response = await this.get('/v3/projects', { page, per_page: PAGE_SIZE })
      // A service token belongs to one config and may not list anything.
      if (response.status === 403) return null
      if (!response.ok) throw new Error(HELP[response.status] ?? `Doppler returned ${response.status}`)
      const data = (await response.json()) as { projects?: { slug?: string; id?: string; name?: string }[] }
      const batch = data.projects ?? []
      for (const project of batch) {
        const id = project.slug ?? project.id
        if (id) projects.push({ id, name: project.name ?? id })
      }
      if (batch.length < PAGE_SIZE) return projects
    }
  }

  async listConfigs(project: string): Promise<SecretConfig[] | null> {
    const configs: SecretConfig[] = []
    for (let page = 1; ; page++) {
      const response = await this.get('/v3/configs', { project, page, per_page: PAGE_SIZE })
      if (response.status === 403) return null
      if (!response.ok) throw new Error(HELP[response.status] ?? `Doppler returned ${response.status}`)
      const data = (await response.json()) as { configs?: { name?: string; environment?: string }[] }
      const batch = data.configs ?? []
      for (const config of batch) if (config.name) configs.push({ name: config.name, environment: config.environment ?? null })
      if (batch.length < PAGE_SIZE) return configs
    }
  }

  async fetch(scope: SecretScope): Promise<Record<string, string>> {
    const data = await this.json<Record<string, unknown>>('/v3/configs/config/secrets/download', {
      format: 'json',
      project: scope.project,
      config: scope.config,
    })
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(data)) if (value !== null && value !== undefined) values[key] = String(value)
    return values
  }
}
