import { BUNDLED_PLUGIN_NAME, bundledPluginSecret, bundledPluginUrls, fetchPluginManifest, parsePluginManifest } from '@factorix/connectors'
import { json, type PluginRow } from '@factorix/db'
import type { AppDeps } from '../deps'
import { readSettings } from './settings'

type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets'>

/**
 * Registers every plugin the plugin host runs, and keeps each one's manifest current. One that does not answer yet is
 * tried again on the next pass. A plugin the host no longer has stops counting as bundled, so an installation admin can
 * remove it.
 */
export async function syncBundledPlugins(deps: Deps, log: (message: string) => void = () => {}): Promise<void> {
  const { FACTORIX_PLUGINS_KEY: key, FACTORIX_PLUGINS_INTERNAL_URL: internalUrl, FACTORIX_PLUGINS_URL: publicUrl } = deps.env
  if (!key || !internalUrl) return
  const response = await fetch(`${new URL(internalUrl).origin}/__plugins`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`the plugin host answered ${response.status}`)
  const listed = ((await response.json()) as { plugins?: { name?: unknown; running?: unknown }[] }).plugins ?? []
  const factorixOrigin = new URL((await readSettings(deps)).publicUrl).origin

  const urls: string[] = []
  for (const entry of listed) {
    const name = String(entry.name ?? '')
    if (!BUNDLED_PLUGIN_NAME.test(name)) continue
    const { url, pageUrl } = bundledPluginUrls(name, internalUrl, publicUrl)
    urls.push(url)
    if (entry.running !== true) continue
    if (new URL(pageUrl).origin === factorixOrigin) {
      log(`bundled plugin ${name} is left out: its pages would load from Factorix's own address. Set FACTORIX_PLUGINS_URL`)
      continue
    }
    const secret = bundledPluginSecret(key, name)
    try {
      const manifest = await fetchPluginManifest({ url, secret })
      const existing = await deps.db<PluginRow>('plugins').where({ url }).first()
      const current =
        existing?.bundled &&
        existing.pageUrl === pageUrl &&
        // Stored JSON comes back with its keys reordered, so both sides go through the parser.
        JSON.stringify(parsePluginManifest(existing.manifest)) === JSON.stringify(manifest) &&
        deps.secrets.decrypt({ ciphertext: existing.secretCiphertext, nonce: existing.secretNonce }) === secret
      if (current) continue
      const { ciphertext, nonce, keyVersion } = deps.secrets.encrypt(secret)
      const row = {
        name: manifest.name,
        pageUrl,
        bundled: true,
        manifest: json(manifest) as never,
        secretCiphertext: ciphertext,
        secretNonce: nonce,
        keyVersion,
        updatedAt: deps.db.fn.now() as never,
      }
      await deps
        .db<PluginRow>('plugins')
        .insert({ url, ...row })
        .onConflict('url')
        .merge(row)
      log(`${existing ? 'updated' : 'registered'} bundled plugin ${name} ${manifest.version}`)
    } catch (error) {
      log(`bundled plugin ${name} is not registered yet: ${(error as Error).message}`)
    }
  }
  await deps.db<PluginRow>('plugins').where({ bundled: true }).whereNotIn('url', urls).update({ bundled: false })
}
