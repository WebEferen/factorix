'use client'

import type { PluginFieldDto } from '@factorix/schemas'
import { Field, Input } from '@/modules/ui'

/** The fields a plugin's manifest asks for. A stored secret is never sent back, so a blank one means keep it. */
export function PluginFields({
  fields,
  values,
  stored = [],
  onChange,
}: {
  fields: PluginFieldDto[]
  values: Record<string, string>
  stored?: string[]
  onChange: (values: Record<string, string>) => void
}) {
  return fields.map((field) => {
    const kept = field.type === 'secret' && stored.includes(field.key)
    return (
      <Field key={field.key} label={field.label} hint={kept ? 'A value is stored. Leave this blank to keep it.' : field.hint}>
        <Input
          type={field.type === 'secret' ? 'password' : field.type === 'url' ? 'url' : 'text'}
          autoComplete="off"
          required={field.required && !kept}
          placeholder={field.placeholder}
          value={values[field.key] ?? ''}
          onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
        />
      </Field>
    )
  })
}
