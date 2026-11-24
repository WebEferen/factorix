import {
  checkRegistryArchive,
  compareVersions,
  keyId,
  PACKAGE_LIMITS,
  type PackageTrust,
  PLUGIN_PERMISSIONS,
  type PluginPackage,
  parsePackageManifest,
  parseRegistryIndex,
  REGISTRY_INDEX,
  REGISTRY_LIMITS,
  REGISTRY_SIGNATURE,
  type RegistryIndex,
  type RegistryPackage,
  type RegistryVersion,
  registryBase,
  registryKey,
  trustAllows,
  trustOf,
  versionUrl,
} from '@factorix/connectors'
import { type AccountRow, type ContentPackRow, json, type PackageSource, type PluginRegistryRow } from '@factorix/db'
import type { MarketDto, MarketPackageDto, PluginRegistryDto } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { badRequest, conflict, HttpError, isUniqueViolation, notFound } from '../lib/errors'
import { readPackage } from './plugin-packages'
import { readSettings } from './settings'

type Deps = Pick<AppDeps, 'db' | 'env'>

const FETCH_TIMEOUT_MS = 20_000

const TRUST_NEEDED: Record<PackageTrust, string> = {
  signed: 'signed packages',
  verified: 'packages by publishers it verified',
  reviewed: 'packages it reviewed',
}

/** Reads at most `max` bytes, so a registry cannot fill the API's memory. */
async function download(url: URL, max: number): Promise<Buffer> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': 'Factorix' } })
  } catch (error) {
    throw new Error(`${url.href} did not answer: ${(error as Error).message}`)
  }
  if (!response.ok || !response.body) throw new Error(`${url.href} answered ${response.status}`)
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new Error(`${url.href} is larger than ${max} bytes`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > max) throw new Error(`${url.href} is larger than ${max} bytes`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export async function fetchRegistry(url: string, publicKey: string): Promise<RegistryIndex> {
  const base = registryBase(url)
  const [index, signature] = await Promise.all([
    download(new URL(REGISTRY_INDEX, base), REGISTRY_LIMITS.indexBytes),
    download(new URL(REGISTRY_SIGNATURE, base), 1024),
  ])
  return parseRegistryIndex(index, signature.toString('utf8'), publicKey)
}

const catalogOf = (registry: PluginRegistryRow): RegistryIndex | null => registry.catalog as RegistryIndex | null

export function registryDto(registry: PluginRegistryRow): PluginRegistryDto {
  return {
    id: registry.id,
    name: registry.name,
    url: registry.url,
    publicKey: registry.publicKey,
    trust: registry.trust,
    packages: catalogOf(registry)?.packages.length ?? 0,
    issuedAt: registry.issuedAt?.toISOString() ?? null,
    fetchedAt: registry.fetchedAt?.toISOString() ?? null,
    error: registry.error,
  }
}

export async function getRegistry(deps: Pick<AppDeps, 'db'>, id: string): Promise<PluginRegistryRow> {
  const registry = /^[0-9a-f-]{36}$/i.test(id) ? await deps.db<PluginRegistryRow>('plugin_registries').where({ id }).first() : undefined
  if (!registry) throw notFound('Registry')
  return registry
}

/** The admin pins the registry to its key here, so the first index has to pass the same check as every later one. */
export async function addRegistry(
  deps: Deps,
  account: AccountRow,
  input: { url: string; publicKey: string; trust: PackageTrust },
): Promise<PluginRegistryRow> {
  let url: string
  try {
    url = registryBase(input.url).toString()
    registryKey(input.publicKey)
  } catch (error) {
    throw badRequest((error as Error).message)
  }
  if (new URL(url).origin === new URL((await readSettings(deps)).publicUrl).origin)
    throw badRequest('A registry cannot live at the address of Factorix itself')
  let catalog: RegistryIndex
  try {
    catalog = await fetchRegistry(url, input.publicKey)
  } catch (error) {
    throw badRequest(`Factorix could not read that registry: ${(error as Error).message}`)
  }
  try {
    const [registry] = await deps
      .db<PluginRegistryRow>('plugin_registries')
      .insert({
        name: catalog.name,
        url,
        publicKey: input.publicKey.trim(),
        trust: input.trust,
        catalog: json(catalog) as never,
        issuedAt: new Date(catalog.issuedAt),
        fetchedAt: new Date(),
        addedBy: account.id,
      })
      .returning('*')
    await writeAudit(deps.db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'plugin_registry.added',
      targetType: 'plugin_registry',
      targetId: registry?.id,
      metadata: { name: catalog.name, url, keyId: keyId(input.publicKey), trust: input.trust },
    })
    return registry as PluginRegistryRow
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('That registry is already added')
    throw error
  }
}

/** Keeps the last good index when a refresh fails, and never goes back to an older one someone replays. */
export async function refreshRegistry(deps: Pick<AppDeps, 'db'>, registry: PluginRegistryRow): Promise<PluginRegistryRow> {
  let update: Partial<PluginRegistryRow>
  try {
    const catalog = await fetchRegistry(registry.url, registry.publicKey)
    if (registry.issuedAt && new Date(catalog.issuedAt) < registry.issuedAt) {
      throw new Error(`The registry sent an index from ${catalog.issuedAt}, older than the one Factorix has, so Factorix keeps that one`)
    }
    update = { name: catalog.name, catalog: json(catalog) as never, issuedAt: new Date(catalog.issuedAt), fetchedAt: new Date(), error: null }
  } catch (error) {
    update = { error: (error as Error).message.slice(0, 1000) }
  }
  const [row] = await deps
    .db<PluginRegistryRow>('plugin_registries')
    .where({ id: registry.id })
    .update({ ...update, updatedAt: deps.db.fn.now() as never })
    .returning('*')
  return row as PluginRegistryRow
}

export async function refreshRegistries(deps: Pick<AppDeps, 'db'>, log: (message: string) => void): Promise<void> {
  for (const registry of await deps.db<PluginRegistryRow>('plugin_registries')) {
    const row = await refreshRegistry(deps, registry)
    if (row.error && row.error !== registry.error) log(`registry ${registry.name}: ${row.error}`)
  }
}

export async function updateRegistry(
  deps: Pick<AppDeps, 'db'>,
  account: AccountRow,
  registry: PluginRegistryRow,
  trust: PackageTrust,
): Promise<PluginRegistryRow> {
  const [row] = await deps
    .db<PluginRegistryRow>('plugin_registries')
    .where({ id: registry.id })
    .update({ trust, updatedAt: deps.db.fn.now() as never })
    .returning('*')
  await writeAudit(deps.db, {
    orgId: account.orgId,
    actorAccountId: account.id,
    actorKind: 'human',
    action: 'plugin_registry.changed',
    targetType: 'plugin_registry',
    targetId: registry.id,
    metadata: { name: registry.name, trust },
  })
  return row as PluginRegistryRow
}

/** What came from it keeps running. It just gets no updates from here. */
export async function removeRegistry(deps: Pick<AppDeps, 'db'>, account: AccountRow, registry: PluginRegistryRow): Promise<void> {
  await deps.db('plugin_registries').where({ id: registry.id }).delete()
  await writeAudit(deps.db, {
    orgId: account.orgId,
    actorAccountId: account.id,
    actorKind: 'human',
    action: 'plugin_registry.removed',
    targetType: 'plugin_registry',
    targetId: registry.id,
    metadata: { name: registry.name, url: registry.url },
  })
}

const fromHere = (source: PackageSource | null, registry: PluginRegistryRow, publisher: string) =>
  source?.registryUrl === registry.url && source.publisher === publisher

/** The newest release, or the newest pre-release when there is nothing else. */
const latestOf = (entry: RegistryPackage): RegistryVersion =>
  entry.versions.find((version) => !version.version.includes('-')) ?? (entry.versions[0] as RegistryVersion)

interface Installed {
  version: string
  source: PackageSource | null
}

async function installedOf(deps: Pick<AppDeps, 'db'>, orgId: string): Promise<Record<'plugin' | 'content', Map<string, Installed>>> {
  const [plugins, packs] = await Promise.all([
    deps
      .db('plugin_instances')
      .join('plugins', 'plugins.id', 'plugin_instances.plugin_id')
      .where('plugin_instances.org_id', orgId)
      .select('plugins.name', 'plugin_instances.package', 'plugin_instances.source') as unknown as Promise<
      { name: string; package: Record<string, unknown>; source: PackageSource | null }[]
    >,
    deps.db<ContentPackRow>('content_packs').where({ orgId }).select('name', 'version', 'source'),
  ])
  return {
    plugin: new Map(plugins.map((row) => [row.name, { version: String(row.package.version), source: row.source }])),
    content: new Map(packs.map((row) => [row.name, { version: row.version, source: row.source }])),
  }
}

/** Why an organization may not take this version from this registry, or null. */
function blockedBy(registry: PluginRegistryRow, publisher: string, trust: PackageTrust, installed: Installed | undefined): string | null {
  if (!trustAllows(registry.trust, trust)) return `This installation takes only ${TRUST_NEEDED[registry.trust]} from ${registry.name}`
  if (installed?.source && !fromHere(installed.source, registry, publisher)) {
    return `This organization has a package of this name from ${installed.source.publisherName} in ${installed.source.registry}. Remove it first`
  }
  return null
}

export async function marketDto(deps: Deps, orgId: string): Promise<MarketDto> {
  const [registries, installed, settings] = await Promise.all([
    deps.db<PluginRegistryRow>('plugin_registries').orderBy('name'),
    installedOf(deps, orgId),
    readSettings(deps),
  ])
  const packages: MarketPackageDto[] = []
  for (const registry of registries) {
    const catalog = catalogOf(registry)
    for (const entry of catalog?.packages ?? []) {
      const publisher = catalog?.publishers.find((candidate) => candidate.id === entry.publisher)
      if (!publisher) continue
      const latest = latestOf(entry)
      const manifest = parsePackageManifest(latest.manifest)
      const kind = manifest.content ? 'content' : 'plugin'
      const trust = trustOf(latest, publisher)
      const mine = installed[kind].get(entry.name)
      const here = Boolean(mine) && fromHere(mine?.source ?? null, registry, publisher.id)
      packages.push({
        registryId: registry.id,
        registry: registry.name,
        kind,
        name: entry.name,
        version: latest.version,
        sha256: latest.sha256,
        description: manifest.description ?? null,
        publisher: { id: publisher.id, name: publisher.name, verified: publisher.verified },
        trust,
        permissions: manifest.permissions.map((id) => ({ id, description: PLUGIN_PERMISSIONS[id] })),
        egress: manifest.egress,
        database: manifest.database,
        blocked: blockedBy(registry, publisher.id, trust, mine),
        installed: mine ? { version: mine.version, fromHere: here } : null,
        update: here && compareVersions(latest.version, mine?.version ?? '0.0.0') > 0,
      })
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.registry.localeCompare(b.registry))
  return { registries: registries.map(registryDto), packages, uploads: settings.allowPackageUploads }
}

/**
 * Downloads one version and checks it all the way down: the index it is in passed the registry's key, the zip is the one
 * the index pinned, and its publisher signed it. What comes back is then installed exactly as an upload would be.
 */
export async function fetchMarketPackage(
  deps: Pick<AppDeps, 'db'>,
  orgId: string,
  input: { registryId: string; name: string; version: string; sha256?: string },
): Promise<{ pkg: PluginPackage; archive: Buffer; source: PackageSource }> {
  const registry = await getRegistry(deps, input.registryId)
  const catalog = catalogOf(registry)
  const entry = catalog?.packages.find((candidate) => candidate.name === input.name)
  const version = entry?.versions.find((candidate) => candidate.version === input.version)
  const publisher = catalog?.publishers.find((candidate) => candidate.id === entry?.publisher)
  if (!entry || !version || !publisher) throw notFound(`${input.name} ${input.version}`)
  if (input.sha256 && input.sha256 !== version.sha256)
    throw conflict(`${registry.name} changed ${entry.name} ${version.version} since you looked. Look again`)
  const trust = trustOf(version, publisher)
  const kind = parsePackageManifest(version.manifest).content ? 'content' : 'plugin'
  const blocked = blockedBy(registry, publisher.id, trust, (await installedOf(deps, orgId))[kind].get(entry.name))
  if (blocked) throw new HttpError(403, 'not_allowed', blocked)

  let archive: Buffer
  let key: string
  try {
    archive = await download(versionUrl(registryBase(registry.url), version), PACKAGE_LIMITS.archiveBytes)
    key = checkRegistryArchive(publisher, version, entry.name, archive)
  } catch (error) {
    throw new HttpError(502, 'bad_package', (error as Error).message)
  }
  const pkg = readPackage(archive)
  if (JSON.stringify(pkg.manifest) !== JSON.stringify(parsePackageManifest(version.manifest))) {
    throw new HttpError(502, 'bad_package', `The zip of ${entry.name} ${version.version} asks for something other than what ${registry.name} lists`)
  }
  return {
    pkg,
    archive,
    source: {
      registryId: registry.id,
      registryUrl: registry.url,
      registry: registry.name,
      publisher: publisher.id,
      publisherName: publisher.name,
      trust,
      keyId: keyId(key),
    },
  }
}
