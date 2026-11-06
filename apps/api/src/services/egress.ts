import { egressHostsOf } from '@factorix/connectors'
import type { ConnectionRow, Db, OrganizationRow, ProjectRow } from '@factorix/db'
import { egressGroups } from '@factorix/schemas'
import { networkSettingsDto } from '../dto'

/** What a restricted project may reach: the organization's groups, its connections' hosts, and its own extra hosts. */
export async function restrictedHosts(
  db: Db,
  orgId: string,
  project: Pick<ProjectRow, 'networkAllowlist'> | null,
  connectionIds: string[],
): Promise<string[]> {
  const connections = await db<ConnectionRow>('connections').whereIn('id', connectionIds).select('kind', 'config')
  const org = (await db<OrganizationRow>('organizations').where({ id: orgId }).first()) as OrganizationRow
  const groups = egressGroups(
    networkSettingsDto(org),
    connections.map((connection) => ({
      name: connection.kind,
      egressHosts: egressHostsOf(connection.kind, connection.config as Record<string, unknown>),
    })),
  )
  return [...groups.flatMap((group) => group.hosts), ...(project?.networkAllowlist ?? [])]
}
