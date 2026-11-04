'use client'

import { egressGroups, type NetworkSettings } from '@factorix/schemas'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useConnections, useMe, useNetworkSettings } from '@/modules/lib/data'
import { HostGroups } from '@/modules/projects/forms'
import { Button, ErrorState, Field, ListSkeleton, Select, Textarea } from '@/modules/ui'

const MODES = [
  { value: 'extend', label: 'Add to the defaults' },
  { value: 'replace', label: 'Use only my list' },
]

function NetworkForm({ network, onSaved }: { network: NetworkSettings; onSaved: (network: NetworkSettings) => void }) {
  const { data: me } = useMe()
  const { data: connections } = useConnections()
  const admin = me?.account.role === 'admin'
  const [mode, setMode] = useState<string>(network.mode)
  const [hosts, setHosts] = useState(network.hosts.join('\n'))
  const [saving, setSaving] = useState(false)
  const list = hosts
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const changed = mode !== network.mode || list.join('\n') !== network.hosts.join('\n')
  const defaults = egressGroups({ mode: 'extend', hosts: [] }, connections?.connections ?? [])

  const save = async () => {
    setSaving(true)
    try {
      const saved = await api.put<{ network: NetworkSettings }>('/api/settings/network', { mode, hosts: list })
      onSaved(saved.network)
      setHosts(saved.network.hosts.join('\n'))
      toast.success('Network settings saved')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Field
          label="Allowlist"
          hint={
            mode === 'replace'
              ? 'Agents reach only your list. Package registries and connector hosts stop working unless you list them.'
              : 'Agents reach the defaults and your list.'
          }
        >
          <Select value={mode} onChange={setMode} options={MODES} disabled={!admin} />
        </Field>
        <Field label="Your hosts" hint="One per line. *.example.com works too. Applies from the next run.">
          <Textarea className="min-h-40 font-mono text-xs" value={hosts} onChange={(event) => setHosts(event.target.value)} disabled={!admin} />
        </Field>
        {admin ? (
          <div>
            <Button onClick={() => void save()} loading={saving} disabled={!changed}>
              Save
            </Button>
          </div>
        ) : (
          <p className="text-xs text-ink-2">Only admins can change this.</p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-ink">Defaults{mode === 'replace' ? ' (not in use)' : ''}</span>
        <HostGroups groups={defaults} className={mode === 'replace' ? 'opacity-50' : undefined} />
        <p className="text-xs text-ink-2">Connector hosts apply to projects that use that connection.</p>
      </div>
    </div>
  )
}

export default function NetworkSettingsPage() {
  const { data, error, mutate } = useNetworkSettings()
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Network</h1>
      <p className="mb-4 text-sm text-ink-2">
        What agents can reach in projects set to Restricted. Model APIs always work. A project can add more hosts in its own settings, and an agent
        can also reach the MCP servers it was granted.
      </p>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={4} />
      ) : (
        <NetworkForm network={data.network} onSaved={(network) => void mutate({ network }, { revalidate: false })} />
      )}
    </div>
  )
}
