import { marketPackageInput, pluginRegistryInput, pluginRegistryUpdateInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { requireAdmin, requireAuth, requireInstallationAdmin } from '../lib/auth'
import { parseBody } from '../lib/errors'
import { installContentPack } from '../services/content-packs'
import {
  addRegistry,
  fetchMarketPackage,
  getRegistry,
  marketDto,
  refreshRegistry,
  registryDto,
  removeRegistry,
  updateRegistry,
} from '../services/market'
import { inspectPluginPackage, installPluginPackage } from '../services/plugin-packages'

/** Registries belong to the installation, since the API downloads from them. What an organization installs is its own. */
export function marketRoutes(app: FastifyInstance, deps: AppDeps): void {
  const registryOf = (request: { params: unknown }) => getRegistry(deps, (request.params as { id: string }).id)

  app.get('/api/market', async (request) => {
    const { account } = requireAuth(request)
    return { market: await marketDto(deps, account.orgId) }
  })

  app.post('/api/market/registries', async (request) => {
    const { account } = requireInstallationAdmin(request)
    return { registry: registryDto(await addRegistry(deps, account, parseBody(pluginRegistryInput, request.body))) }
  })

  app.put('/api/market/registries/:id', async (request) => {
    const { account } = requireInstallationAdmin(request)
    const { trust } = parseBody(pluginRegistryUpdateInput, request.body)
    return { registry: registryDto(await updateRegistry(deps, account, await registryOf(request), trust)) }
  })

  app.post('/api/market/registries/:id/refresh', async (request) => {
    requireInstallationAdmin(request)
    return { registry: registryDto(await refreshRegistry(deps, await registryOf(request))) }
  })

  app.delete('/api/market/registries/:id', async (request) => {
    const { account } = requireInstallationAdmin(request)
    await removeRegistry(deps, account, await registryOf(request))
    return { ok: true }
  })

  app.post('/api/market/inspect', async (request) => {
    const { account } = requireAdmin(request)
    const { pkg, source } = await fetchMarketPackage(deps, account.orgId, parseBody(marketPackageInput, request.body))
    return { package: await inspectPluginPackage(deps, account.orgId, pkg, source) }
  })

  app.post('/api/market/install', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(marketPackageInput, request.body)
    const { pkg, archive, source } = await fetchMarketPackage(deps, account.orgId, input)
    if (pkg.manifest.content) await installContentPack(deps, account, pkg, source)
    else await installPluginPackage(deps, account, pkg, archive, input.runnerId ?? null, source)
    return { installed: { kind: pkg.manifest.content ? 'content' : 'plugin', name: pkg.manifest.name, version: pkg.manifest.version } }
  })
}
