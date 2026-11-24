import { createHash } from 'node:crypto'
import type { ProviderModel } from '@factorix/connectors'
import { MODEL_PROVIDERS, type ModelProviderId, RUNTIME_CAPABILITIES, type RuntimeId, type RuntimeModel } from '@factorix/runtime'
import type { AppDeps } from '../deps'
import { resolveModelProvider } from './connections'

type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets' | 'redis' | 'connectors'>

const CACHE_SECONDS = 3600
const FAILED_CACHE_SECONDS = 300

/**
 * Reads any provider's ids the same way: after the vendor's own prefix, words name the family and numbers the version.
 * `claude-fable-5-2` is family `fable` at 5.2, `gpt-6.2-sol` family `sol` at 6.2, and `gpt-5.5` has no family.
 */
export function modelVersion(id: string): { family: string; version: number[] } | null {
  const parts = id.split('-').slice(1)
  const version = parts.filter((part) => /^\d{1,3}(?:\.\d{1,3})?$/.test(part)).flatMap((part) => part.split('.').map(Number))
  if (version.length === 0) return null
  return { family: parts.filter((part) => /^[a-z]+$/.test(part)).join('-'), version }
}

const newer = (a: number[], b: number[]) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0)

function newestOf(models: ProviderModel[]): ProviderModel | undefined {
  return models
    .flatMap((model) => {
      const parsed = modelVersion(model.id)
      return parsed ? [{ model, version: parsed.version }] : []
    })
    .sort((a, b) => newer(b.version, a.version))[0]?.model
}

/**
 * The SDK's models, after the ones the provider lists that are newer than any the SDK knows of their family, or of any
 * family when the SDK knows none of it. A new one takes the reasoning efforts of its family's newest model in the SDK.
 */
export function withNewerModels(sdk: RuntimeModel[], listed: ProviderModel[]): RuntimeModel[] {
  const known = sdk.flatMap((model) => {
    const parsed = modelVersion(model.id)
    return parsed ? [{ model, ...parsed }] : []
  })
  const newest = (family?: string) =>
    known.filter((entry) => family === undefined || entry.family === family).sort((a, b) => newer(b.version, a.version))[0]
  const added = listed.flatMap((item) => {
    const parsed = modelVersion(item.id)
    if (!parsed || sdk.some((model) => model.id === item.id)) return []
    const base = newest(parsed.family) ?? newest()
    if (base && newer(parsed.version, base.version) <= 0) return []
    return [
      {
        parsed,
        model: {
          id: item.id,
          label: item.label,
          description: 'Newer than this Factorix knows, listed by the provider',
          efforts: base?.model.efforts ?? [],
        },
      },
    ]
  })
  added.sort((a, b) => newer(b.parsed.version, a.parsed.version))
  return [...added.map((entry) => entry.model), ...sdk]
}

/**
 * What the organization's own model key can use, asked of the provider and kept for an hour. The cache is keyed by a
 * digest of the key, so changing the key asks again, and a failure is remembered for a few minutes so a page does not wait on it.
 */
export async function providerModelsFor(deps: Deps, orgId: string, runtime: RuntimeId): Promise<ProviderModel[]> {
  const { dialect } = RUNTIME_CAPABILITIES[runtime]
  const resolved = dialect ? await resolveModelProvider(deps, orgId, null, dialect) : undefined
  if (!resolved) return []
  const { provider, key } = resolved
  const cacheKey = `provider-models:${provider}:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
  const cached = await deps.redis.get(cacheKey)
  if (cached !== null) return JSON.parse(cached) as ProviderModel[]
  let models: ProviderModel[] = []
  try {
    models = await deps.connectors.models(provider, key)
    await deps.redis.set(cacheKey, JSON.stringify(models), 'EX', CACHE_SECONDS)
  } catch {
    await deps.redis.set(cacheKey, '[]', 'EX', FAILED_CACHE_SECONDS)
  }
  return models
}

/** What a connection's Test shows for a model key: the provider lists its models, and the newest one answers a call. */
export async function testModelKey(deps: Pick<AppDeps, 'connectors'>, provider: ModelProviderId, key: string): Promise<string> {
  const { label } = MODEL_PROVIDERS[provider]
  const listed = await deps.connectors.models(provider, key)
  const newest = newestOf(listed)
  if (!newest) throw new Error(`${label} took the key, but lists no model an agent can run with it`)
  await deps.connectors.pingModel(provider, key, newest.id)
  return `Connected to ${label}: ${newest.id} answered, and ${listed.length === 1 ? 'it is the only model' : `${listed.length} models are`} available`
}
