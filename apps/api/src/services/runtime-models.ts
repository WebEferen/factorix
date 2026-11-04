import { type Db, json } from '@factorix/db'
import type { SandboxProvider } from '@factorix/sandbox'

export async function refreshRuntimeModels(deps: { db: Db; sandbox: Pick<SandboxProvider, 'listRuntimeModels'> }): Promise<void> {
  const catalogs = await deps.sandbox.listRuntimeModels()
  for (const [runtime, catalog] of Object.entries(catalogs)) {
    await deps
      .db('runtime_models')
      .insert({ runtime, defaultModel: catalog.defaultModel, models: json(catalog.models), fetchedAt: deps.db.fn.now() })
      .onConflict('runtime')
      .merge()
  }
}
