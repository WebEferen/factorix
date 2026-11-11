import { z } from 'zod'

export const PACKAGE_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'objects.githubusercontent.com',
  'nodejs.org',
] as const

/** A bare `*` is the Open policy, and a URL would never match, so neither belongs in a list of hosts. */
export const egressHost = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/, 'Use a host name like example.com or *.example.com')

/** NO_PROXY spells a wildcard as a leading dot, which curl, Node, and Python all read. */
export function noProxyHost(host: string): string {
  return host.startsWith('*.') ? host.slice(1) : host
}

export const networkSettingsInput = z.object({
  mode: z.enum(['extend', 'replace']),
  hosts: z
    .array(egressHost)
    .max(200)
    .transform((hosts) => [...new Set(hosts)]),
})

export type NetworkSettings = z.output<typeof networkSettingsInput>

export interface EgressGroup {
  label: string
  hosts: readonly string[]
}

/** What a restricted project reaches before its own additions. The settings pages list this and the worker enforces it, so they cannot disagree. */
export function egressGroups(settings: NetworkSettings, connections: { name: string; egressHosts: readonly string[] }[]): EgressGroup[] {
  const own = settings.hosts.length > 0 ? [{ label: 'Your organization', hosts: settings.hosts }] : []
  if (settings.mode === 'replace') return own
  return [
    { label: 'Package registries', hosts: PACKAGE_REGISTRY_HOSTS },
    ...connections
      .filter((connection) => connection.egressHosts.length > 0)
      .map((connection) => ({ label: connection.name, hosts: connection.egressHosts })),
    ...own,
  ]
}
