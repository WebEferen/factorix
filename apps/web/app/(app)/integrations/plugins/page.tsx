'use client'

import type { PluginDto, PluginPackageDto, RunnerDto } from '@factorix/schemas'
import { Plus, Puzzle, Upload } from 'lucide-react'
import Link from 'next/link'
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '@/modules/lib/api'
import { useMe, usePlugins } from '@/modules/lib/data'
import { PluginFields } from '@/modules/plugins/fields'
import { Button, Chip, Dialog, DialogFooter, EmptyState, ErrorState, Field, Input, ListSkeleton, Select } from '@/modules/ui'

const HERE = 'here'

function kilobytes(size: number): string {
  return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
}

function UploadDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [found, setFound] = useState<PluginPackageDto | null>(null)
  const [runner, setRunner] = useState(HERE)
  const [loading, setLoading] = useState(false)
  const { data: runners } = useSWR<{ runners: RunnerDto[] }>(open ? '/api/runners' : null, fetcher as never)
  useEffect(() => {
    if (open) return
    setFile(null)
    setFound(null)
    setRunner(HERE)
  }, [open])
  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]
    event.target.value = ''
    if (!chosen) return
    setLoading(true)
    try {
      setFound((await api.upload<{ package: PluginPackageDto }>('/api/plugin-packages/inspect', chosen)).package)
      setFile(chosen)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const install = async () => {
    if (!file || !found) return
    setLoading(true)
    try {
      const query = runner === HERE || found.replaces ? '' : `?runner=${encodeURIComponent(runner)}`
      await api.upload(`/api/plugin-packages${query}`, file)
      toast.success(found.replaces ? `Replacing ${found.name} ${found.replaces} with ${found.version}` : `Installing ${found.name}`)
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
      title="Upload a plugin package"
      description="Factorix runs it for this organization only, in a container of its own. Nothing in it runs until you install it."
    >
      <input ref={input} type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => void pick(event)} />
      {!found ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => input.current?.click()}
          className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-divider px-4 py-8 text-center transition-colors hover:border-ink-3 hover:bg-soft/40 disabled:opacity-60"
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-signal text-white [&_svg]:size-5">
            <Upload />
          </span>
          <span className="text-sm font-medium">{loading ? 'Reading the package' : 'Choose a .zip'}</span>
          <span className="max-w-sm text-xs text-ink-2">
            Built with <code>factorix-plugin pack</code> from the plugin SDK: one bundled server file and a factorix-plugin.json.
          </span>
        </button>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div>
            <div className="font-medium">
              {found.name} <span className="text-ink-3">{found.version}</span>
              {found.replaces ? <span className="text-ink-2"> replaces {found.replaces}</span> : null}
            </div>
            {found.description ? <p className="text-ink-2">{found.description}</p> : null}
            <p className="text-xs text-ink-3">
              {[
                found.publisher ? `By ${found.publisher}` : null,
                `${found.files} files, ${kilobytes(found.size)}`,
                `sha256 ${found.sha256.slice(0, 12)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className="rounded-md border border-divider p-3">
            <p className="mb-1 font-medium">Once an admin turns it on, it may</p>
            {found.permissions.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-2">
                {found.permissions.map((permission) => (
                  <li key={permission.id}>{permission.description}</li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-2">Only read its own settings and connections.</p>
            )}
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-ink-2">
            <dt className="text-ink-3">Reaches</dt>
            <dd className="min-w-0 break-words">{[...found.egress, 'Factorix'].join(', ')}</dd>
            <dt className="text-ink-3">Database</dt>
            <dd>{found.database ? 'A Postgres of its own' : 'None'}</dd>
            <dt className="text-ink-3">Memory</dt>
            <dd>Up to {found.memoryMb} MB</dd>
          </dl>
          {found.replaces ? (
            <p className="text-xs text-ink-2">
              It keeps its machine, data, and settings. A permission the new version adds waits until an admin saves its settings.
            </p>
          ) : (
            <Field label="Runs on" hint="Its data stays on that machine.">
              <Select
                value={runner}
                onChange={setRunner}
                options={[
                  { value: HERE, label: 'This Factorix' },
                  ...(runners?.runners ?? []).map((entry) => ({ value: entry.id, label: `${entry.name}${entry.online ? '' : ' (offline)'}` })),
                ]}
              />
            </Field>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => input.current?.click()} disabled={loading}>
              Choose another
            </Button>
            <Button variant="primary" loading={loading} onClick={() => void install()}>
              {found.replaces ? `Replace with ${found.version}` : 'Install'}
            </Button>
          </DialogFooter>
        </div>
      )}
    </Dialog>
  )
}

function RemoveDialog({ plugin, onOpenChange, onDone }: { plugin: PluginDto | null; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const remove = async () => {
    if (!plugin) return
    setLoading(true)
    try {
      await api.delete(`/api/plugins/${plugin.id}`)
      toast.success(`Removing ${plugin.name}`)
      onDone()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <Dialog open={plugin !== null} onOpenChange={onOpenChange} title={`Remove ${plugin?.name ?? ''}`}>
      <p className="text-sm text-ink-2">
        This stops it and deletes its container{plugin?.package?.database ? ' and its database' : ''}. It cannot be undone. Upload the package again
        to start over.
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="danger" loading={loading} onClick={() => void remove()}>
          Remove
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

const STATES: Record<NonNullable<PluginDto['package']>['state'], { label: string; tone: 'info' | 'danger' | 'neutral' } | null> = {
  starting: { label: 'Starting', tone: 'info' },
  ready: null,
  failed: { label: 'Failed', tone: 'danger' },
  removing: { label: 'Removing', tone: 'neutral' },
}

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
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState<PluginDto | null>(null)
  const [editing, setEditing] = useState<PluginDto | null>(null)
  const busy = data?.plugins.some((plugin) => plugin.package?.state === 'starting' || plugin.package?.state === 'removing') ?? false
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void mutate(), 3000)
    return () => clearInterval(timer)
  }, [busy, mutate])
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
            Plugins add a tracker, pages, or workflow blocks. An installation admin installs one by its address, an admin uploads a package that
            Factorix runs for this organization, and each organization turns a plugin on for itself. A plugin sees only what its own connections and
            settings hold.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {admin ? (
            <Button size="sm" variant={me?.installationAdmin ? 'ghost' : 'primary'} onClick={() => setUploading(true)}>
              <Upload />
              Upload package
            </Button>
          ) : null}
          {me?.installationAdmin ? (
            <Button size="sm" onClick={() => setInstalling(true)}>
              <Plus />
              Install plugin
            </Button>
          ) : null}
        </div>
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={2} />
      ) : data.plugins.length === 0 ? (
        <EmptyState title="No plugins yet">
          {admin ? 'Upload a package, or have an installation admin install one by its address.' : 'An admin can upload one.'}
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
                    plugin.bundled
                      ? 'Comes with Factorix'
                      : plugin.package
                        ? `Uploaded, runs on ${plugin.package.runner?.name ?? 'this Factorix'}`
                        : plugin.url,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {plugin.package?.error ? (
                  <div className={plugin.package.state === 'failed' ? 'text-xs break-words text-danger-ink' : 'text-xs break-words text-ink-3'}>
                    {plugin.package.error}
                  </div>
                ) : null}
              </div>
              {plugin.package && STATES[plugin.package.state] ? (
                <Chip tone={STATES[plugin.package.state]?.tone}>{STATES[plugin.package.state]?.label}</Chip>
              ) : null}
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
                  <Button size="sm" disabled={Boolean(plugin.package) && plugin.package?.state !== 'ready'} onClick={() => turnOn(plugin)}>
                    Turn on
                  </Button>
                )
              ) : null}
              {admin && plugin.package && plugin.package.state !== 'removing' ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(() => api.post(`/api/plugins/${plugin.id}/restart`), `Restarting ${plugin.name}`)}
                  >
                    Restart
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(plugin)}>
                    Remove
                  </Button>
                </>
              ) : null}
              {me?.installationAdmin && !plugin.package ? (
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
      <UploadDialog open={uploading} onOpenChange={setUploading} onDone={() => void mutate()} />
      <RemoveDialog plugin={removing} onOpenChange={(open) => !open && setRemoving(null)} onDone={() => void mutate()} />
      <SettingsDialog plugin={editing} onOpenChange={(open) => !open && setEditing(null)} onDone={() => void mutate()} />
    </div>
  )
}
