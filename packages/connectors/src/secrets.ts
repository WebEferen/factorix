import type { EgressHosts } from './source'

export interface SecretScope {
  project?: string | null
  config?: string | null
}

export interface SecretProject {
  id: string
  name: string
}

export interface SecretConfig {
  name: string
  environment: string | null
}

/**
 * Where a project keeps the values its apps read. The worker fetches them and hands the values to containers, so the source's
 * own token never enters one. A new source is this interface plus an entry in `SECRET_SOURCES`.
 */
export interface SecretSourceConnector {
  readonly kind: SecretSourceKind
  viewer(): Promise<{ name: string }>
  /** Null when the token can only reach one place, so there is nothing to pick. */
  listProjects(): Promise<SecretProject[] | null>
  listConfigs(project: string): Promise<SecretConfig[] | null>
  fetch(scope: SecretScope): Promise<Record<string, string>>
}

export type SecretSourceKind = 'doppler' | 'generic'

export interface SecretSource {
  label: string
  /** A set picks a project and config inside the connection. */
  scoped: boolean
  egressHosts: EgressHosts
}

/** Values typed into Factorix itself, stored encrypted on the connection. */
export class StoredSecretSource implements SecretSourceConnector {
  readonly kind = 'generic' as const

  constructor(private readonly values: Record<string, string>) {}

  async viewer(): Promise<{ name: string }> {
    return { name: `${Object.keys(this.values).length} stored values` }
  }

  async listProjects(): Promise<null> {
    return null
  }

  async listConfigs(): Promise<null> {
    return null
  }

  async fetch(): Promise<Record<string, string>> {
    return { ...this.values }
  }
}

export const storedSecretSource: SecretSource = { label: 'Environment secret', scoped: false, egressHosts: () => [] }
