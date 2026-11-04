'use client'

import { PLATFORM_SETTINGS, type PlatformSettingDto, type PlatformSettingSpec, platformSettingSchema } from '@factorix/schemas'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useGeneralSettings, useMe } from '@/modules/lib/data'
import { Button, ErrorState, Field, Input, ListSkeleton, Toggle } from '@/modules/ui'

const GROUPS: { name: PlatformSettingSpec['group']; description: string }[] = [
  { name: 'Agents', description: 'How much runs at once, and what it may run on.' },
  { name: 'Sync', description: 'How closely Factorix follows your tracker and your code.' },
  { name: 'Disk', description: 'What stays on disk, and for how long.' },
  { name: 'Access', description: 'How people and webhooks reach this instance.' },
]

type Draft = Record<string, string | boolean>

const shown = (value: PlatformSettingDto['value']): string | boolean => (typeof value === 'boolean' ? value : String(value))

function draftOf(settings: PlatformSettingDto[]): Draft {
  return Object.fromEntries(settings.map((setting) => [setting.key, shown(setting.value)]))
}

function parsed(spec: PlatformSettingSpec, value: string | boolean): number | boolean | string {
  return spec.kind === 'integer' && value !== '' ? Number(value) : value
}

function defaultLabel(spec: PlatformSettingSpec, envValue: PlatformSettingDto['value']): string {
  const value = typeof envValue === 'boolean' ? (envValue ? 'on' : 'off') : `${envValue}${spec.unit ? ` ${spec.unit}` : ''}`
  return `${value}, from ${spec.env}`
}

function SettingRow({
  spec,
  setting,
  value,
  error,
  disabled,
  onChange,
  onReset,
}: {
  spec: PlatformSettingSpec
  setting: PlatformSettingDto
  value: string | boolean
  error?: string
  disabled: boolean
  onChange: (value: string | boolean) => void
  onReset: () => void
}) {
  const differs = value !== shown(setting.envValue)
  const reset =
    differs && !disabled ? (
      <button type="button" className="text-link hover:underline" onClick={onReset}>
        Use the default
      </button>
    ) : null
  const hint = (
    <>
      {spec.hint} Default: {defaultLabel(spec, setting.envValue)}. {reset}
    </>
  )
  if (spec.kind === 'boolean') {
    return <Toggle checked={value === true} onChange={onChange} label={spec.label} hint={hint} disabled={disabled} />
  }
  return (
    <Field label={spec.unit ? `${spec.label} (${spec.unit})` : spec.label} hint={hint} error={error}>
      <Input
        value={String(value)}
        inputMode={spec.kind === 'integer' ? 'numeric' : 'url'}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

function GeneralForm({ settings, onSaved }: { settings: PlatformSettingDto[]; onSaved: (settings: PlatformSettingDto[]) => void }) {
  const { data: me } = useMe()
  const admin = me?.account.role === 'admin'
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings))
  const [saving, setSaving] = useState(false)
  const byKey = new Map(settings.map((setting) => [setting.key, setting]))

  const errorOf = (spec: PlatformSettingSpec): string | undefined => {
    const value = draft[spec.key] as string | boolean
    const result = platformSettingSchema(spec).safeParse(value === '' ? undefined : parsed(spec, value))
    return result.success ? undefined : value === '' ? 'Enter a value' : result.error.issues[0]?.message
  }
  const invalid = PLATFORM_SETTINGS.some((spec) => errorOf(spec))
  const changed = PLATFORM_SETTINGS.filter((spec) => draft[spec.key] !== shown((byKey.get(spec.key) as PlatformSettingDto).value))

  const save = async () => {
    setSaving(true)
    try {
      // Matching the environment clears the override, so a later change to the environment takes effect again.
      const values = Object.fromEntries(
        changed.map((spec) => {
          const setting = byKey.get(spec.key) as PlatformSettingDto
          return [spec.key, draft[spec.key] === shown(setting.envValue) ? null : parsed(spec, draft[spec.key] as string | boolean)]
        }),
      )
      const saved = await api.put<{ settings: PlatformSettingDto[] }>('/api/settings/general', { values })
      onSaved(saved.settings)
      setDraft(draftOf(saved.settings))
      toast.success('Settings saved')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {GROUPS.map((group) => (
        <section
          key={group.name}
          className="grid grid-cols-1 gap-4 border-t border-divider pt-5 first:border-t-0 first:pt-0 md:grid-cols-[220px_1fr]"
        >
          <div>
            <h2 className="text-sm font-semibold">{group.name}</h2>
            <p className="mt-0.5 text-xs text-ink-2">{group.description}</p>
          </div>
          <div className="flex max-w-xl flex-col gap-4">
            {PLATFORM_SETTINGS.filter((spec) => spec.group === group.name).map((spec) => {
              const setting = byKey.get(spec.key) as PlatformSettingDto
              return (
                <SettingRow
                  key={spec.key}
                  spec={spec}
                  setting={setting}
                  value={draft[spec.key] as string | boolean}
                  error={errorOf(spec)}
                  disabled={!admin}
                  onChange={(value) => setDraft((current) => ({ ...current, [spec.key]: value }))}
                  onReset={() => setDraft((current) => ({ ...current, [spec.key]: shown(setting.envValue) }))}
                />
              )
            })}
          </div>
        </section>
      ))}
      <div className="border-t border-divider pt-5">
        {admin ? (
          <Button loading={saving} disabled={changed.length === 0 || invalid} onClick={() => void save()}>
            Save
          </Button>
        ) : (
          <p className="text-xs text-ink-2">Only admins can change these.</p>
        )}
      </div>
    </div>
  )
}

export default function GeneralSettingsPage() {
  const { data, error, mutate } = useGeneralSettings()
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold">General</h1>
      <p className="mb-6 text-sm text-ink-2">
        The environment sets the defaults, and what you save here overrides them without a restart. The database, Redis, secret key, ports, networks,
        and sandbox image are set only in the environment.
      </p>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={8} />
      ) : (
        <GeneralForm settings={data.settings} onSaved={(settings) => void mutate({ settings }, { revalidate: false })} />
      )}
    </div>
  )
}
