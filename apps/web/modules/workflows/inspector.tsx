'use client'

import {
  type BlockField,
  blockSpec,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  NOTIFICATION_KINDS,
  WORKFLOW_VARIABLES,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowNode,
} from '@factorix/schemas'
import { Braces, CircleAlert, Plus, Trash2, X } from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, type RefObject, useId, useMemo, useRef } from 'react'
import { useAgents, useConnections, useIssueFilterSpecs, useNotificationChannels, useProjects } from '../lib/data'
import { cn } from '../lib/format'
import { Button, Field, Input, Menu, MenuContent, MenuItem, MenuTrigger, type Option, Select, Textarea } from '../ui'
import { BLOCK_ICONS, CATEGORY_TONES } from './blocks'

const NONE = '__none__'

function withNone(options: Option[], required: boolean | undefined, label = 'None'): Option[] {
  return required ? options : [{ value: NONE, label }, ...options]
}

/** A value picked earlier stays visible after its option disappears, so nothing changes silently. */
function keepCurrent(options: Option[], value: string, label = value): Option[] {
  return value && !options.some((option) => option.value === value) ? [{ value, label, hint: 'No longer listed' }, ...options] : options
}

function SuggestInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  options: Option[]
  placeholder?: string
}) {
  const listId = useId()
  return (
    <>
      <Input list={listId} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.value} value={option.value} />
        ))}
      </datalist>
    </>
  )
}

function useTrackerOptions(projectId: string | null) {
  const { data } = useIssueFilterSpecs(projectId ?? undefined, 'all')
  return useMemo(() => {
    const of = (key: string): Option[] =>
      (data?.filters.find((filter) => filter.key === key)?.options ?? []).map((option) => ({ value: option.value, label: option.label }))
    return { statuses: of('status'), labels: of('label') }
  }, [data])
}

interface Variable {
  path: string
  label: string
}

function upstreamVariables(nodeId: string, definition: WorkflowDefinition): Variable[] {
  const seen = new Set<string>()
  const walk = (id: string) => {
    for (const edge of definition.edges) {
      if (edge.target === id && !seen.has(edge.source)) {
        seen.add(edge.source)
        walk(edge.source)
      }
    }
  }
  walk(nodeId)
  return definition.nodes
    .filter((node) => seen.has(node.id))
    .flatMap((node) => {
      const spec = blockSpec(node.type)
      return (spec?.provides ?? []).map((item) => ({ path: `steps.${node.id}.${item.key}`, label: `${spec?.title}: ${item.label}` }))
    })
}

function VariableMenu({ variables, onPick }: { variables: Variable[]; onPick: (path: string) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm text-xs text-ink-2 transition-colors duration-100 hover:text-ink [&_svg]:size-3"
        >
          <Braces />
          Insert value
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-72 overflow-y-auto" onCloseAutoFocus={(event) => event.preventDefault()}>
        {variables.map((variable) => (
          <MenuItem key={variable.path} onSelect={() => onPick(variable.path)}>
            {variable.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

function TemplateField({
  field,
  value,
  onChange,
  variables,
  long,
}: {
  field: BlockField
  value: string
  onChange: (value: string) => void
  variables: Variable[]
  long?: boolean
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const id = useId()
  const insert = (path: string) => {
    const element = ref.current
    const token = `{{${path}}}`
    const start = element?.selectionStart ?? value.length
    const end = element?.selectionEnd ?? value.length
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const control = { id, value, placeholder: field.placeholder, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm text-ink">
          {field.label}
        </label>
        <VariableMenu variables={variables} onPick={insert} />
      </div>
      {long ? (
        <Textarea ref={ref as RefObject<HTMLTextAreaElement>} rows={5} {...control} />
      ) : (
        <Input ref={ref as RefObject<HTMLInputElement>} {...control} />
      )}
      {field.hint ? <span className="text-xs text-ink-2">{field.hint}</span> : null}
    </div>
  )
}

function ChannelField({
  field,
  connectionId,
  config,
  onConfig,
}: {
  field: BlockField
  connectionId: string
  config: Record<string, unknown>
  onConfig: (patch: Record<string, unknown>) => void
}) {
  const { data, error, isLoading } = useNotificationChannels(connectionId || null)
  const value = String(config.channel ?? '')
  const channels = data?.channels ?? []
  const options = keepCurrent(
    channels.map((channel) => ({ value: channel.id, label: `#${channel.name}`, hint: channel.private ? 'Private' : undefined })),
    value,
    config.channelName ? `#${config.channelName}` : value,
  )
  return (
    <Field
      label={field.label}
      error={error ? `Could not list channels: ${(error as Error).message}` : undefined}
      hint={connectionId ? 'Private channels show up after you invite the bot to them.' : 'Pick a connection first.'}
    >
      <Select
        value={value}
        disabled={!connectionId}
        placeholder={isLoading ? 'Loading channels' : 'Select a channel'}
        options={options}
        onChange={(channel) => onConfig({ channel, channelName: channels.find((item) => item.id === channel)?.name ?? config.channelName })}
      />
    </Field>
  )
}

interface Rule {
  field: string
  operator: string
  value?: string
}

function RulesField({
  rules,
  onChange,
  statuses,
  labels,
}: {
  rules: Rule[]
  onChange: (rules: Rule[]) => void
  statuses: Option[]
  labels: Option[]
}) {
  const update = (index: number, patch: Partial<Rule>) => onChange(rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)))
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-ink">Rules</span>
      {rules.map((rule, index) => {
        const operator = CONDITION_OPERATORS.find((item) => item.value === rule.operator)
        const kind = CONDITION_FIELDS.find((item) => item.value === rule.field)?.kind
        const suggestions = kind === 'status' ? statuses : kind === 'label' ? labels : []
        return (
          <div key={index} data-testid="rule" className="flex flex-col gap-1.5 rounded-md border border-divider p-2">
            <div className="grid grid-cols-2 gap-1.5">
              <Select
                value={rule.field}
                options={CONDITION_FIELDS.map(({ value, label }) => ({ value, label }))}
                onChange={(field) => update(index, { field })}
              />
              <Select
                value={rule.operator}
                options={CONDITION_OPERATORS.map(({ value, label }) => ({ value, label }))}
                onChange={(next) => update(index, { operator: next })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                {operator?.takesValue !== false ? (
                  <SuggestInput value={rule.value ?? ''} onChange={(value) => update(index, { value })} options={suggestions} placeholder="Value" />
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove rule"
                onClick={() => onChange(rules.filter((_, position) => position !== index))}
              >
                <X />
              </Button>
            </div>
          </div>
        )
      })}
      <Button size="sm" className="self-start" onClick={() => onChange([...rules, { field: 'title', operator: 'contains', value: '' }])}>
        <Plus />
        Add rule
      </Button>
    </div>
  )
}

function ConfigField({
  field,
  node,
  definition,
  projectId,
  onConfig,
}: {
  field: BlockField
  node: WorkflowNode
  definition: WorkflowDefinition
  projectId: string | null
  onConfig: (patch: Record<string, unknown>) => void
}) {
  const { data: agents } = useAgents()
  const { data: projects } = useProjects()
  const { data: connections } = useConnections()
  const { statuses, labels } = useTrackerOptions(projectId)
  const raw = node.config[field.key]
  const value = raw === undefined || raw === null ? '' : String(raw)
  const set = (next: unknown) => onConfig({ [field.key]: next })
  const variables = useMemo<Variable[]>(() => [...WORKFLOW_VARIABLES, ...upstreamVariables(node.id, definition)], [node.id, definition])
  const pick = (next: string) => set(next === NONE ? undefined : next)

  switch (field.kind) {
    case 'template':
      return <TemplateField field={field} value={value} onChange={set} variables={variables} />
    case 'longTemplate':
      return <TemplateField long field={field} value={value} onChange={set} variables={variables} />
    case 'rules':
      return <RulesField rules={(raw ?? []) as Rule[]} onChange={set} statuses={statuses} labels={labels} />
    case 'channel':
      return <ChannelField field={field} connectionId={String(node.config.connectionId ?? '')} config={node.config} onConfig={onConfig} />
    case 'number':
      return (
        <Field label={field.label} hint={field.hint}>
          <Input
            type="number"
            min={field.min}
            max={field.max}
            value={value}
            onChange={(event) => set(event.target.value === '' ? undefined : Number(event.target.value))}
          />
        </Field>
      )
    case 'status':
      return (
        <Field label={field.label} hint={field.hint}>
          <SuggestInput value={value} onChange={set} options={statuses} placeholder="Status name" />
        </Field>
      )
    case 'label':
      return (
        <Field label={field.label} hint={field.hint ?? 'A label that does not exist yet is created when it is added.'}>
          <SuggestInput value={value} onChange={set} options={labels} placeholder="Label name" />
        </Field>
      )
    case 'select':
      return (
        <Field label={field.label} hint={field.hint}>
          <Select value={value} options={withNone(field.options ?? [], field.required || field.initial !== undefined)} onChange={pick} />
        </Field>
      )
    case 'agent':
      return (
        <Field label={field.label} hint={field.hint}>
          <Select
            value={value || NONE}
            options={keepCurrent(
              withNone(
                (agents?.agents ?? []).map((agent) => ({ value: agent.id, label: agent.displayName, hint: agent.handle })),
                field.required,
              ),
              value,
            )}
            onChange={pick}
          />
        </Field>
      )
    case 'project':
      return (
        <Field label={field.label} hint={field.hint}>
          <Select
            value={value || NONE}
            options={keepCurrent(
              withNone(
                (projects?.projects ?? []).map((project) => ({ value: project.id, label: project.name })),
                field.required,
              ),
              value,
            )}
            onChange={pick}
          />
        </Field>
      )
    case 'connection': {
      const usable = (connections?.connections ?? []).filter((connection) => (NOTIFICATION_KINDS as readonly string[]).includes(connection.kind))
      return (
        <Field
          label={field.label}
          hint={
            usable.length === 0 ? (
              <>
                None yet. Add a Slack connection in{' '}
                <Link href="/settings/connections" className="text-link hover:underline">
                  Settings
                </Link>
                .
              </>
            ) : undefined
          }
        >
          <Select
            value={value}
            placeholder="Select a connection"
            options={keepCurrent(
              usable.map((connection) => ({ value: connection.id, label: connection.name })),
              value,
            )}
            onChange={(connectionId) => onConfig({ connectionId, channel: undefined, channelName: undefined })}
          />
        </Field>
      )
    }
    default:
      return (
        <Field label={field.label} hint={field.hint}>
          <Input value={value} placeholder={field.placeholder} onChange={(event) => set(event.target.value)} />
        </Field>
      )
  }
}

function ProblemList({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null
  return (
    <ul className="flex flex-col gap-1 rounded-md bg-danger-soft px-2.5 py-2 text-xs text-danger-ink">
      {messages.map((message) => (
        <li key={message} className="flex items-start gap-1.5">
          <CircleAlert className="mt-px size-3 shrink-0" />
          {message}
        </li>
      ))}
    </ul>
  )
}

export function BlockInspector({
  node,
  definition,
  projectId,
  problems,
  readOnly,
  onConfig,
  onDelete,
}: {
  node: WorkflowNode
  definition: WorkflowDefinition
  projectId: string | null
  problems: string[]
  readOnly: boolean
  onConfig: (patch: Record<string, unknown>) => void
  onDelete: () => void
}) {
  const spec = blockSpec(node.type)
  if (!spec) return null
  const fields = spec.fields.filter((field) => !field.when || field.when.in.includes(String(node.config[field.when.key] ?? '')))
  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex items-start gap-2.5">
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-4', CATEGORY_TONES[spec.category])}>
          {BLOCK_ICONS[node.type]}
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{spec.title}</h2>
          <p className="text-xs text-ink-2">{spec.description}</p>
        </div>
      </div>
      <ProblemList messages={problems} />
      {fields.map((field) => (
        <ConfigField key={field.key} field={field} node={node} definition={definition} projectId={projectId} onConfig={onConfig} />
      ))}
      {readOnly ? null : (
        <Button size="sm" variant="ghost" className="self-start" onClick={onDelete}>
          <Trash2 />
          Delete block
        </Button>
      )}
    </fieldset>
  )
}

export function WorkflowPanel({
  name,
  description,
  projectId,
  issues,
  readOnly,
  onChange,
  onShowProblem,
  footer,
}: {
  name: string
  description: string
  projectId: string | null
  issues: WorkflowIssue[]
  readOnly: boolean
  onChange: (patch: { name?: string; description?: string; projectId?: string | null }) => void
  onShowProblem: (nodeId: string) => void
  footer?: ReactNode
}) {
  const { data: projects } = useProjects()
  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4 p-4">
      <Field label="Name" error={name.trim() ? undefined : 'A workflow needs a name'}>
        <Input value={name} onChange={(event) => onChange({ name: event.target.value })} />
      </Field>
      <Field label="Description">
        <Textarea rows={2} value={description} placeholder="What this is for" onChange={(event) => onChange({ description: event.target.value })} />
      </Field>
      <Field label="Works on" hint="Limits which tickets it can start on and run against.">
        <Select
          value={projectId ?? NONE}
          options={[
            { value: NONE, label: 'All projects' },
            ...(projects?.projects ?? []).map((project) => ({ value: project.id, label: project.name })),
          ]}
          onChange={(next) => onChange({ projectId: next === NONE ? null : next })}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-ink">{issues.length === 0 ? 'Ready to publish' : `${issues.length} to fix before publishing`}</span>
        {issues.length === 0 ? (
          <span className="text-xs text-ink-2">Nothing is missing. Click a block to change it.</span>
        ) : (
          <ul data-testid="problems" className="flex flex-col gap-0.5">
            {issues.map((issue, index) => (
              <li key={`${issue.nodeId}-${index}`}>
                <button
                  type="button"
                  disabled={!issue.nodeId}
                  onClick={() => issue.nodeId && onShowProblem(issue.nodeId)}
                  className="flex w-full items-start gap-1.5 rounded-sm px-1 py-1 text-left text-xs text-danger-ink transition-colors duration-100 enabled:hover:bg-danger-soft disabled:cursor-default"
                >
                  <CircleAlert className="mt-px size-3 shrink-0" />
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {footer}
    </fieldset>
  )
}
