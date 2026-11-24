import type { ContentPackPlanDto, PackageTrust, PluginPackageDto, RunnerDto } from '@factorix/schemas'
import { Chip, Field, Select } from '@/modules/ui'

export const HERE = 'here'

export function kilobytes(size: number): string {
  return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
}

export const TRUST: Record<PackageTrust, { label: string; tone: 'success' | 'info' | 'neutral' }> = {
  reviewed: { label: 'Reviewed', tone: 'success' },
  verified: { label: 'Verified publisher', tone: 'info' },
  signed: { label: 'Signed', tone: 'neutral' },
}

export const ITEM_KINDS: Record<ContentPackPlanDto['kind'], [string, string]> = {
  skill: ['skill', 'skills'],
  archetype: ['archetype', 'archetypes'],
  workflow: ['workflow', 'workflows'],
}

const ACTIONS: Record<ContentPackPlanDto['action'], { label: string; tone: 'success' | 'info' | 'neutral' | 'outline' | 'danger' }> = {
  create: { label: 'New', tone: 'success' },
  update: { label: 'Updated', tone: 'info' },
  keep: { label: 'Kept, it was changed here', tone: 'neutral' },
  gone: { label: 'Not brought back', tone: 'neutral' },
  release: { label: 'Stays, no longer in the package', tone: 'outline' },
  conflict: { label: 'Name taken', tone: 'danger' },
}

export function countOf(items: { kind: ContentPackPlanDto['kind'] }[]): string {
  return (Object.keys(ITEM_KINDS) as ContentPackPlanDto['kind'][])
    .map((kind) => [kind, items.filter((item) => item.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${ITEM_KINDS[kind][count === 1 ? 0 : 1]}`)
    .join(', ')
}

export function PackageSummary({ found }: { found: PluginPackageDto }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 font-medium">
        <span>
          {found.name} <span className="text-ink-3">{found.version}</span>
          {found.replaces ? <span className="font-normal text-ink-2"> replaces {found.replaces}</span> : null}
        </span>
        {found.source ? <Chip tone={TRUST[found.source.trust].tone}>{TRUST[found.source.trust].label}</Chip> : null}
      </div>
      {found.description ? <p className="text-ink-2">{found.description}</p> : null}
      <p className="text-xs text-ink-3">
        {[
          found.source
            ? `Signed by ${found.source.publisher}, from ${found.source.registry}`
            : found.publisher
              ? `By ${found.publisher}, unsigned`
              : 'Unsigned',
          `${found.files} files, ${kilobytes(found.size)}`,
          `sha256 ${found.sha256.slice(0, 12)}`,
        ].join(' · ')}
      </p>
    </div>
  )
}

export function ContentPlan({ items }: { items: ContentPackPlanDto[] }) {
  const conflicts = items.some((item) => item.action === 'conflict')
  return (
    <>
      <ul className="divide-y divide-divider rounded-md border border-divider">
        {items.map((item) => (
          <li key={`${item.kind}:${item.key}`} className="flex items-center gap-3 px-3 py-1.5">
            <span className="w-20 shrink-0 text-xs text-ink-3 capitalize">{ITEM_KINDS[item.kind][0]}</span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <Chip tone={ACTIONS[item.action].tone}>{ACTIONS[item.action].label}</Chip>
          </li>
        ))}
      </ul>
      {conflicts ? (
        <p className="text-xs text-danger-ink">
          This organization already has something by a name the package uses. Rename or remove it, then try again.
        </p>
      ) : (
        <p className="text-xs text-ink-2">
          What it imports becomes this organization's own. Workflows arrive as drafts: pick their agents, projects, and connections, then publish
          them.
        </p>
      )}
    </>
  )
}

const New = () => <span className="text-warning-ink"> (new)</span>

export function PluginPlan({
  found,
  runner,
  setRunner,
  runners,
}: {
  found: PluginPackageDto
  runner: string
  setRunner: (runner: string) => void
  runners: RunnerDto[]
}) {
  const adds = found.adds
  const more = adds && (adds.permissions.length > 0 || adds.egress.length > 0 || adds.database)
  return (
    <>
      <div className="rounded-md border border-divider p-3">
        <p className="mb-1 font-medium">Once an admin turns it on, it may</p>
        {found.permissions.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-2">
            {found.permissions.map((permission) => (
              <li key={permission.id}>
                {permission.description}
                {adds?.permissions.includes(permission.id) ? <New /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2">Only read its own settings and connections.</p>
        )}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-ink-2">
        <dt className="text-ink-3">Reaches</dt>
        <dd className="min-w-0 break-words">
          {found.egress.map((host) => (
            <span key={host}>
              {host}
              {adds?.egress.includes(host) ? <New /> : null},{' '}
            </span>
          ))}
          Factorix
        </dd>
        <dt className="text-ink-3">Database</dt>
        <dd>
          {found.database ? 'A Postgres of its own' : 'None'}
          {adds?.database ? <New /> : null}
        </dd>
        <dt className="text-ink-3">Memory</dt>
        <dd>Up to {found.memoryMb} MB</dd>
      </dl>
      {found.replaces ? (
        <p className={more ? 'text-xs text-warning-ink' : 'text-xs text-ink-2'}>
          It keeps its machine, data, and settings.{' '}
          {more
            ? `This version asks for more than ${found.replaces}. A new permission waits until an admin saves its settings, and new hosts and a database apply once it starts.`
            : 'A permission the new version adds waits until an admin saves its settings.'}
        </p>
      ) : (
        <Field label="Runs on" hint="Its data stays on that machine.">
          <Select
            value={runner}
            onChange={setRunner}
            options={[
              { value: HERE, label: 'This Factorix' },
              ...runners.map((entry) => ({ value: entry.id, label: `${entry.name}${entry.online ? '' : ' (offline)'}` })),
            ]}
          />
        </Field>
      )}
    </>
  )
}
