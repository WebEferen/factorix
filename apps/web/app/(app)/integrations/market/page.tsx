'use client'

import type { MarketDto, MarketPackageDto, PackageTrust, PluginPackageDto, PluginRegistryDto, RunnerDto } from '@factorix/schemas'
import { Package, Plus, Puzzle, RefreshCw } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '@/modules/lib/api'
import { useMe } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { ContentPlan, HERE, PackageSummary, PluginPlan, TRUST } from '@/modules/plugins/package-plan'
import { Button, Chip, Dialog, DialogFooter, EmptyState, ErrorState, Field, Input, ListSkeleton, SectionTitle, Select } from '@/modules/ui'

const LEAST_TRUST: { value: PackageTrust; label: string }[] = [
  { value: 'reviewed', label: 'Only versions the registry reviewed' },
  { value: 'verified', label: 'Packages by publishers it verified' },
  { value: 'signed', label: 'Any package it lists, signed by its publisher' },
]

const pick = (entry: MarketPackageDto) => ({ registryId: entry.registryId, name: entry.name, version: entry.version, sha256: entry.sha256 })

function InstallDialog({
  entry,
  onOpenChange,
  onDone,
}: {
  entry: MarketPackageDto | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [found, setFound] = useState<PluginPackageDto | null>(null)
  const [runner, setRunner] = useState(HERE)
  const [loading, setLoading] = useState(false)
  const { data: runners } = useSWR<{ runners: RunnerDto[] }>(entry?.kind === 'plugin' ? '/api/runners' : null, fetcher as never)
  useEffect(() => {
    setFound(null)
    setRunner(HERE)
    if (!entry) return
    let current = true
    api
      .post<{ package: PluginPackageDto }>('/api/market/inspect', pick(entry))
      .then(({ package: inspected }) => current && setFound(inspected))
      .catch((error: Error) => {
        if (!current) return
        toast.error(error.message)
        onOpenChange(false)
      })
    return () => {
      current = false
    }
  }, [entry, onOpenChange])
  const install = async () => {
    if (!entry || !found) return
    setLoading(true)
    try {
      await api.post('/api/market/install', { ...pick(entry), runnerId: runner === HERE || found.replaces ? null : runner })
      const verb = found.kind === 'content' ? (found.replaces ? 'Updated' : 'Imported') : found.replaces ? 'Updating' : 'Installing'
      toast.success(`${verb} ${found.name} ${found.version}`)
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
      open={entry !== null}
      onOpenChange={onOpenChange}
      title={entry ? `${found?.replaces ? 'Update' : 'Install'} ${entry.name}` : ''}
      description="Factorix downloaded it and checked its signatures. Nothing in it runs or changes until you confirm."
    >
      {!found ? (
        <p className="py-6 text-center text-sm text-ink-2">Downloading and checking the package</p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <PackageSummary found={found} />
          {found.kind === 'content' ? (
            <ContentPlan items={found.items} />
          ) : (
            <PluginPlan found={found} runner={runner} setRunner={setRunner} runners={runners?.runners ?? []} />
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={loading}
              disabled={found.items.some((item) => item.action === 'conflict')}
              onClick={() => void install()}
            >
              {found.replaces ? `Update to ${found.version}` : found.kind === 'content' ? 'Import' : 'Install'}
            </Button>
          </DialogFooter>
        </div>
      )}
    </Dialog>
  )
}

function AddRegistryDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [url, setUrl] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [trust, setTrust] = useState<PackageTrust>('verified')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const { registry } = await api.post<{ registry: PluginRegistryDto }>('/api/market/registries', { url, publicKey, trust })
      toast.success(`Added ${registry.name}, with ${registry.packages} packages`)
      setUrl('')
      setPublicKey('')
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
      title="Add a registry"
      description="A registry is a folder of signed packages anyone can host. Factorix reads its index now and every hour, and only while the registry's key signed it."
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Address" hint="Where its index.json is.">
          <Input
            required
            autoFocus
            type="url"
            placeholder="https://market.example.com/"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label="Public key" hint="The key that signs its index, from whoever runs it.">
          <Input
            required
            className="font-mono"
            placeholder="ed25519:..."
            autoComplete="off"
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
          />
        </Field>
        <Field label="Organizations may install">
          <Select value={trust} onChange={(value) => setTrust(value as PackageTrust)} options={LEAST_TRUST} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={loading}>
            Add registry
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function PackageRow({ entry, admin, onPick }: { entry: MarketPackageDto; admin: boolean; onPick: (entry: MarketPackageDto) => void }) {
  const Icon = entry.kind === 'content' ? Package : Puzzle
  const action = entry.blocked
    ? null
    : !entry.installed
      ? 'Install'
      : entry.update
        ? `Update to ${entry.version}`
        : !entry.installed.fromHere
          ? 'Replace'
          : null
  return (
    <div className="flex min-h-14 items-center gap-3 border-b border-divider px-4 py-2 last:border-b-0">
      <Icon className="size-4 shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="truncate">
            {entry.name} <span className="text-ink-3">{entry.version}</span>
          </span>
          <Chip tone={TRUST[entry.trust].tone}>{TRUST[entry.trust].label}</Chip>
        </div>
        <div className="truncate text-xs text-ink-2">
          {[
            entry.description,
            `By ${entry.publisher.name}`,
            entry.kind === 'content'
              ? 'Skills, archetypes, and workflows'
              : `Asks for ${entry.permissions.length === 0 ? 'no permissions' : entry.permissions.length === 1 ? '1 permission' : `${entry.permissions.length} permissions`}`,
            entry.registry,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {entry.blocked ? <div className="text-xs break-words text-ink-3">{entry.blocked}</div> : null}
      </div>
      {entry.installed && !entry.update && entry.installed.fromHere ? <Chip tone="success">Installed</Chip> : null}
      {entry.installed && entry.update ? <Chip tone="info">{entry.installed.version} installed</Chip> : null}
      {admin && action ? (
        <Button size="sm" variant={entry.update ? 'primary' : undefined} onClick={() => onPick(entry)}>
          {action}
        </Button>
      ) : null}
    </div>
  )
}

function RegistryRow({ registry, manage, onChange }: { registry: PluginRegistryDto; manage: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await work()
      if (done) toast.success(done)
      onChange()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-3 border-b border-divider px-4 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {registry.name} <span className="text-ink-3">{registry.packages} packages</span>
        </div>
        <div className="truncate text-xs text-ink-2">
          {[registry.url, registry.fetchedAt ? `Read ${timeAgo(registry.fetchedAt)}` : null].filter(Boolean).join(' · ')}
        </div>
        {registry.error ? <div className="text-xs break-words text-danger-ink">{registry.error}</div> : null}
      </div>
      {manage ? (
        <>
          <Select
            className="w-64"
            value={registry.trust}
            disabled={busy}
            onChange={(trust) => void act(() => api.put(`/api/market/registries/${registry.id}`, { trust }), 'Saved')}
            options={LEAST_TRUST}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const { registry: read } = await api.post<{ registry: PluginRegistryDto }>(`/api/market/registries/${registry.id}/refresh`)
                if (read.error) throw new Error(read.error)
              }, `Read ${registry.name} again`)
            }
          >
            <RefreshCw />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(() => api.delete(`/api/market/registries/${registry.id}`), `Removed ${registry.name}`)}
          >
            Remove
          </Button>
        </>
      ) : (
        <Chip tone="outline">{LEAST_TRUST.find((option) => option.value === registry.trust)?.label}</Chip>
      )}
    </div>
  )
}

export default function MarketPage() {
  const { data, error, mutate } = useSWR<{ market: MarketDto }>('/api/market', fetcher as never)
  const { data: me } = useMe()
  const admin = me?.account.role === 'admin'
  const installationAdmin = Boolean(me?.installationAdmin)
  const [picked, setPicked] = useState<MarketPackageDto | null>(null)
  const [adding, setAdding] = useState(false)
  const market = data?.market
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Market</h1>
          <p className="text-sm text-ink-2">
            Plugins and content from the registries this installation trusts. Every package is signed by its publisher, and Factorix checks the
            signature and what it asks for before an admin installs it for this organization.
          </p>
        </div>
        {installationAdmin ? (
          <Button size="sm" className="shrink-0" onClick={() => setAdding(true)}>
            <Plus />
            Add registry
          </Button>
        ) : null}
      </div>
      {error && !market ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !market ? (
        <ListSkeleton rows={3} />
      ) : market.packages.length === 0 ? (
        <EmptyState title={market.registries.length === 0 ? 'No registries yet' : 'Nothing to install yet'}>
          {market.registries.length === 0
            ? installationAdmin
              ? 'Add a registry by its address and the key that signs it.'
              : 'An installation admin adds the registries packages come from.'
            : 'The registries here list no packages.'}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-divider">
          {market.packages.map((entry) => (
            <PackageRow key={`${entry.registryId}:${entry.name}`} entry={entry} admin={admin} onPick={setPicked} />
          ))}
        </div>
      )}
      {market && market.registries.length > 0 ? (
        <section className="mt-6">
          <SectionTitle>Registries</SectionTitle>
          <div className="overflow-hidden rounded-lg border border-divider">
            {market.registries.map((registry) => (
              <RegistryRow key={registry.id} registry={registry} manage={installationAdmin} onChange={() => void mutate()} />
            ))}
          </div>
          {!market.uploads ? (
            <p className="mt-2 text-xs text-ink-2">
              Organizations install packages only from here. Uploading a file is turned off on Settings, General.
            </p>
          ) : null}
        </section>
      ) : null}
      <InstallDialog entry={picked} onOpenChange={(open) => !open && setPicked(null)} onDone={() => void mutate()} />
      <AddRegistryDialog open={adding} onOpenChange={setAdding} onDone={() => void mutate()} />
    </div>
  )
}
