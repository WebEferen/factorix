'use client'

import type { PluginDto } from '@factorix/schemas'
import { Plus, Puzzle } from 'lucide-react'
import Link from 'next/link'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useMe, usePlugins } from '@/modules/lib/data'
import { PluginFields } from '@/modules/plugins/fields'
import { Button, Chip, Dialog, EmptyState, ErrorState, Field, Input, ListSkeleton } from '@/modules/ui'

function InstallDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const { plugin } = await api.post<{ plugin: PluginDto }>('/api/plugins', { url, secret })
      toast.success(`Installed ${plugin.name}`)
      setUrl('')
      setSecret('')
      onDone()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Install a plugin"
      description="A plugin is a server someone runs outside Factorix. Factorix calls it at this address, and both sides sign with the secret."
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Address">
          <Input
            required
            autoFocus
            type="url"
            placeholder="https://plugin.example.com/factorix"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label="Secret" hint="The one the plugin was started with. Encrypted at rest and never shown again.">
          <Input required type="password" autoComplete="off" minLength={16} value={secret} onChange={(event) => setSecret(event.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={loading}>
            Install
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function SettingsDialog({ plugin, onOpenChange, onDone }: { plugin: PluginDto | null; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (plugin) setValues(plugin.settings)
  }, [plugin])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!plugin) return
    setLoading(true)
    try {
      await api.put(`/api/plugins/${plugin.id}/organization`, { enabled: true, settings: values })
      toast.success(plugin.enabled ? 'Saved' : `Turned on ${plugin.name}`)
      onDone()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <Dialog open={plugin !== null} onOpenChange={onOpenChange} title={plugin?.name ?? ''} description="Settings for this organization.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        {plugin && plugin.permissions.length > 0 ? (
          <div className="rounded-md border border-divider p-3 text-sm">
            <p className="mb-1 font-medium">{plugin.enabled ? 'Saving allows it to' : 'Turning it on allows it to'}</p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-2">
              {plugin.permissions.map((permission) => (
                <li key={permission.id}>
                  {permission.description}
                  {plugin.enabled && !permission.granted ? <span className="text-warning-ink"> (new)</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {plugin ? <PluginFields fields={plugin.settingsFields} values={values} stored={plugin.secretSettings} onChange={setValues} /> : null}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={loading}>
            {plugin?.enabled ? 'Save changes' : 'Turn on'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export default function PluginsPage() {
  const { data, error, mutate } = usePlugins()
  const { data: me } = useMe()
  const admin = me?.account.role === 'admin'
  const [installing, setInstalling] = useState(false)
  const [editing, setEditing] = useState<PluginDto | null>(null)
  const act = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work()
      toast.success(done)
      void mutate()
    } catch (caught) {
      toast.error((caught as Error).message)
    }
  }
  const pending = (plugin: PluginDto) => plugin.enabled && plugin.permissions.some((permission) => !permission.granted)
  const turnOn = (plugin: PluginDto) =>
    plugin.settingsFields.length > 0 || plugin.permissions.length > 0
      ? setEditing(plugin)
      : void act(() => api.put(`/api/plugins/${plugin.id}/organization`, { enabled: true }), `Turned on ${plugin.name}`)
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Plugins</h1>
          <p className="text-sm text-ink-2">
            Servers outside Factorix that add a tracker or pages of their own. An installation admin installs one, and each organization turns it on
            for itself. A plugin sees only what its own connections and settings hold.
          </p>
        </div>
        {me?.installationAdmin ? (
          <Button size="sm" onClick={() => setInstalling(true)}>
            <Plus />
            Install plugin
          </Button>
        ) : null}
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={2} />
      ) : data.plugins.length === 0 ? (
        <EmptyState title="No plugins yet">
          {me?.installationAdmin ? 'Install one by its address and secret.' : 'An installation admin can install one.'}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-divider">
          {data.plugins.map((plugin) => (
            <div key={plugin.id} className="flex min-h-14 items-center gap-3 border-b border-divider px-4 py-2 last:border-b-0">
              <Puzzle className="size-4 shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  {plugin.name} <span className="text-ink-3">{plugin.version}</span>
                </div>
                <div className="truncate text-xs text-ink-2">
                  {[
                    plugin.description,
                    plugin.provides.includes('tracker') ? 'Tracker' : null,
                    plugin.pages.length > 0 ? plugin.pages.map((page) => page.label).join(', ') : null,
                    plugin.bundled ? 'Comes with Factorix' : plugin.url,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {plugin.enabled
                ? plugin.pages
                    .filter((page) => page.placement === 'settings')
                    .map((page) => (
                      <Link key={page.key} href={`/plugins/${plugin.id}/${page.key}`} className="text-xs text-link hover:underline">
                        {page.label}
                      </Link>
                    ))
                : null}
              {pending(plugin) ? <Chip tone="warning">Asks for more</Chip> : null}
              <Chip tone={plugin.enabled ? 'success' : 'neutral'}>{plugin.enabled ? 'On' : 'Off'}</Chip>
              {admin && plugin.enabled && (plugin.settingsFields.length > 0 || pending(plugin)) ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(plugin)}>
                  Settings
                </Button>
              ) : null}
              {admin ? (
                plugin.enabled ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(() => api.put(`/api/plugins/${plugin.id}/organization`, { enabled: false }), `Turned off ${plugin.name}`)}
                  >
                    Turn off
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => turnOn(plugin)}>
                    Turn on
                  </Button>
                )
              ) : null}
              {me?.installationAdmin ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(() => api.post(`/api/plugins/${plugin.id}/refresh`), 'Read the manifest again')}
                  >
                    Refresh
                  </Button>
                  {plugin.bundled ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void act(() => api.delete(`/api/plugins/${plugin.id}`), `Removed ${plugin.name}`)}
                    >
                      Remove
                    </Button>
                  )}
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <InstallDialog open={installing} onOpenChange={setInstalling} onDone={() => void mutate()} />
      <SettingsDialog plugin={editing} onOpenChange={(open) => !open && setEditing(null)} onDone={() => void mutate()} />
    </div>
  )
}
