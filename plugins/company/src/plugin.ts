import { randomBytes, randomUUID } from 'node:crypto'
import { type Agent, definePlugin, type Member, type PageContext, type Plugin, type TicketProject } from '@moxxylabs/factorix-plugin-sdk'
import {
  type Actor,
  CASE_FINISHED,
  CompanyError,
  cancelCase,
  type Deps,
  decide,
  mayAct,
  refreshOrg,
  retryCase,
  startCase,
  startForWorkflow,
} from './engine'
import {
  type Assignee,
  type Definition,
  EMPTY,
  FIELD_TYPES,
  type FieldType,
  keyFrom,
  MAX_FIELDS,
  MAX_STEPS,
  type Process,
  problemsOf,
  readForm,
  STEP_KINDS,
  type Step,
  type StepKind,
} from './model'
import { TEMPLATES } from './templates'
import { casesView, caseView, companyView, editView, NOTICES, page, processesView, type Shell, startView, workView } from './view'

export const VERSION = '0.2.0'
const LIST = 100
const STATUSES = ['running', 'completed', 'rejected', 'cancelled', 'failed'] as const

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

function html(body: string, nonce: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      // Everything people and agents wrote is escaped, and this keeps a slip from running anything.
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'`,
    },
  })
}

const actorOf = (context: PageContext): Actor => ({ id: context.account.id, name: context.account.name, admin: context.account.role === 'admin' })

/** Asks Factorix for a list a view needs. A refusal becomes a warning on the page, and the list stays empty. */
async function listed<T>(ask: () => Promise<T[]>, what: string, warnings: string[]): Promise<T[]> {
  try {
    return await ask()
  } catch (error) {
    warnings.push(`Factorix did not list the ${what}: ${messageOf(error)}`)
    return []
  }
}

async function render(deps: Deps, context: PageContext, request: Request, token: string): Promise<Response> {
  const { store } = deps
  const orgId = context.org.id
  const actor = actorOf(context)
  await store.rememberPlugin(orgId, context.plugin.id)
  const fx = deps.factorix(context.plugin.id)
  const url = new URL(request.url)
  const param = (name: string) => url.searchParams.get(name) ?? ''
  const nonce = randomBytes(16).toString('base64')
  const shell: Shell = {
    token,
    exp: context.exp,
    nonce,
    admin: actor.admin,
    accountId: actor.id,
    now: deps.now?.() ?? new Date(),
    notice: NOTICES[param('notice')] ?? null,
    error: param('error').slice(0, 300) || null,
  }
  const show = (view: string, body: string, options?: { waiting?: boolean }) => html(page(shell, view, body, options), nonce)
  const view = param('view') || 'work'

  if (view === 'processes') return show('processes', processesView(shell, await store.processes(orgId)))

  if (view === 'start') {
    const process = await store.process(orgId, param('process'))
    if (process?.published && !process.archived) return show('processes', startView(shell, process))
  }

  if (view === 'edit' && actor.admin) {
    const process = await store.process(orgId, param('process'))
    if (process && !process.archived) {
      const warnings: string[] = []
      const members = await listed<Member>(() => fx.members(orgId), 'people', warnings)
      return show(
        'processes',
        editView(shell, {
          process,
          people: members.filter((member) => member.kind === 'person' && member.status === 'active'),
          agents: await listed<Agent>(() => fx.agents(orgId), 'agents', warnings),
          projects: await listed<TicketProject>(() => fx.projects(orgId), 'projects', warnings),
          departments: await store.departments(orgId),
          warnings,
        }),
      )
    }
  }

  if (view === 'case') {
    let item = await store.case(orgId, param('id'))
    if (item) {
      // A case whose run or ticket finished shows now, without waiting for the sweep.
      if (item.status === 'running' && item.phase !== 'todo') {
        await refreshOrg(deps, orgId)
        item = (await store.case(orgId, item.id)) ?? item
      }
      const waiting = item.status === 'running' && item.phase !== 'todo'
      return show(
        'cases',
        caseView(shell, {
          item,
          events: await store.events(orgId, item.id),
          mayAct: mayAct(item, actor),
          mayCancel: actor.admin || actor.id === item.requesterId,
        }),
        { waiting },
      )
    }
  }

  if (view === 'cases') {
    const status = STATUSES.find((candidate) => candidate === param('status'))
    return show(
      'cases',
      casesView(shell, { cases: await store.cases(orgId, { status, limit: LIST }), counts: await store.counts(orgId), status: status ?? '' }),
    )
  }

  if (view === 'company') {
    const warnings: string[] = []
    const members = await listed<Member>(() => fx.members(orgId), 'people and agents', warnings)
    return show(
      'company',
      companyView(shell, {
        departments: await store.departments(orgId),
        placements: await store.placements(orgId),
        members,
        warning: warnings[0] ?? null,
      }),
    )
  }

  await refreshOrg(deps, orgId)
  return show(
    'work',
    workView(shell, {
      mine: await store.cases(orgId, { assigneeId: actor.id, limit: LIST }),
      unassigned: actor.admin ? await store.cases(orgId, { unassigned: true, limit: LIST }) : [],
      requested: await store.cases(orgId, { requesterId: actor.id, limit: 30 }),
    }),
  )
}

const stepId = () => `s${randomBytes(4).toString('hex')}`

function newStep(kind: StepKind, name: string): Step {
  const base = { id: stepId(), name, dueHours: null }
  if (kind === 'approval') return { ...base, kind, assignee: { kind: 'owner' }, instructions: '', onReject: 'end' }
  if (kind === 'agent') return { ...base, kind, agentId: '', prompt: '' }
  if (kind === 'ticket') return { ...base, kind, projectId: '', title: '', description: '', agentId: null, wait: false }
  return { ...base, kind: 'task', assignee: { kind: 'owner' }, instructions: '' }
}

function assigneeFrom(value: string): Assignee {
  const [kind, id] = value.split(':')
  if ((kind === 'member' || kind === 'department') && id) return { kind, id }
  return { kind: kind === 'requester' ? 'requester' : 'owner' }
}

/** A form on the page. The answer is always a redirect back to a view, with what happened. */
async function act(deps: Deps, context: PageContext, request: Request, token: string): Promise<Response> {
  const { store } = deps
  const orgId = context.org.id
  const actor = actorOf(context)
  const back = (view: string, params: Record<string, string> = {}) =>
    new Response(null, { status: 303, headers: { location: `?${new URLSearchParams({ factorix: token, view, ...params })}` } })
  const form = await request.formData()
  const field = (name: string) => String(form.get(name) ?? '').trim()
  const intent = field('intent')
  await store.rememberPlugin(orgId, context.plugin.id)
  /** An id a form names is only kept when Factorix has that member. */
  const member = async (id: string, kind?: Member['kind']) => {
    if (!id) return null
    const found = (await deps.factorix(context.plugin.id).members(orgId)).find(
      (candidate) => candidate.id === id && (!kind || candidate.kind === kind),
    )
    if (!found) throw new CompanyError('That person is not in this organization')
    return found.id
  }

  try {
    if (intent === 'case.start') {
      const process = await store.process(orgId, field('process'))
      if (!process?.published) throw new CompanyError('That process is not published')
      const { values, problems } = readForm(process.published.form, (key) => field(`f_${key}`))
      if (problems.length > 0) return back('start', { process: process.id, error: problems.join('. ') })
      const item = await startCase(deps, process, { title: field('title'), values }, actor)
      return back('case', { id: item.id, notice: 'started' })
    }

    if (intent.startsWith('case.')) {
      const item = await store.case(orgId, field('id'))
      if (!item) throw new CompanyError('That case does not exist')
      try {
        if (intent === 'case.decide') await decide(deps, item, actor, { decision: field('decision'), note: field('note') })
        else if (intent === 'case.cancel') await cancelCase(deps, item, actor)
        else if (intent === 'case.retry') await retryCase(deps, item, actor)
        else throw new CompanyError('The page sent something it should not have')
      } catch (error) {
        if (error instanceof CompanyError) return back('case', { id: item.id, error: error.message })
        throw error
      }
      return back('case', {
        id: item.id,
        ...(intent === 'case.decide' ? { notice: 'done' } : intent === 'case.cancel' ? { notice: 'cancelled' } : {}),
      })
    }

    if (!actor.admin) throw new CompanyError('Only an admin of the organization can change this')

    if (intent === 'department.save' || intent === 'department.remove') {
      const id = field('department')
      const existing = id ? (await store.departments(orgId)).find((department) => department.id === id) : undefined
      if (id && !existing) throw new CompanyError('That department does not exist')
      if (intent === 'department.remove') await store.removeDepartment(orgId, id)
      else {
        const name = field('name').slice(0, 80)
        if (!name) throw new CompanyError('Name the department')
        await store.saveDepartment({ id: existing?.id ?? randomUUID(), orgId, name, leadId: await member(field('leadId'), 'person') })
      }
      return back('company', { notice: 'saved' })
    }

    if (intent === 'member.place') {
      const departmentId = field('departmentId') || null
      if (departmentId && !(await store.departments(orgId)).some((department) => department.id === departmentId))
        throw new CompanyError('That department does not exist')
      const memberId = await member(field('member'))
      if (!memberId) throw new CompanyError('The page sent something it should not have')
      await store.savePlacement({ orgId, memberId, departmentId, title: field('title').slice(0, 80) })
      return back('company', { notice: 'saved' })
    }

    if (intent === 'process.create') {
      const template = TEMPLATES.find((candidate) => candidate.key === field('template'))
      const name = (template?.name ?? field('name')).slice(0, 120)
      if (!name) throw new CompanyError('Name the process')
      const now = deps.now?.() ?? new Date()
      const process: Process = {
        id: randomUUID(),
        orgId,
        name,
        description: template?.description ?? '',
        ownerId: actor.id,
        departmentId: null,
        draft: structuredClone(template?.definition ?? EMPTY),
        published: null,
        version: 0,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      await store.saveProcess(process)
      return back('edit', { process: process.id })
    }

    const process = await store.process(orgId, field('process'))
    if (!process || process.archived) throw new CompanyError('That process does not exist')
    const edit = (params: Record<string, string> = {}) => back('edit', { process: process.id, ...params })
    const save = async (change: Partial<Process>) => store.saveProcess({ ...process, ...change, updatedAt: deps.now?.() ?? new Date() })
    const draft: Definition = structuredClone(process.draft)

    if (intent === 'process.save') {
      const name = field('name').slice(0, 120)
      if (!name) return edit({ error: 'Name the process' })
      const departmentId = field('departmentId') || null
      if (departmentId && !(await store.departments(orgId)).some((department) => department.id === departmentId))
        return edit({ error: 'That department does not exist' })
      try {
        await save({ name, description: field('description').slice(0, 500), ownerId: await member(field('ownerId'), 'person'), departmentId })
      } catch (error) {
        return edit({ error: messageOf(error) })
      }
      return edit({ notice: 'saved' })
    }
    if (intent === 'process.publish') {
      const problems = problemsOf(draft)
      if (problems.length > 0) return edit({ error: problems.join('. ') })
      await save({ published: draft, version: process.version + 1 })
      return edit({ notice: 'published' })
    }
    if (intent === 'process.archive') {
      await save({ archived: true })
      return back('processes', { notice: 'archived' })
    }

    if (intent === 'field.add' || intent === 'field.save' || intent === 'field.remove') {
      const at = draft.form.findIndex((item) => item.key === field('field'))
      if (intent !== 'field.add' && at < 0) return edit({ error: 'That field does not exist' })
      if (intent === 'field.remove') draft.form.splice(at, 1)
      else {
        const label = field('label').slice(0, 80)
        if (!label) return edit({ error: 'Give the field a label' })
        const type = (Object.hasOwn(FIELD_TYPES, field('type')) ? field('type') : 'text') as FieldType
        const options = [
          ...new Set(
            field('options')
              .split(',')
              .map((item) => item.trim().slice(0, 80))
              .filter(Boolean),
          ),
        ].slice(0, 50)
        if (intent === 'field.add') {
          if (draft.form.length >= MAX_FIELDS) return edit({ error: `A form holds at most ${MAX_FIELDS} fields` })
          draft.form.push({
            key: keyFrom(
              label,
              draft.form.map((item) => item.key),
            ),
            label,
            type,
            required: true,
            options: [],
          })
        } else draft.form[at] = { key: field('field'), label, type, required: field('required') === 'on', options: type === 'select' ? options : [] }
      }
      await save({ draft })
      return edit()
    }

    if (intent === 'step.add') {
      const kind = (Object.hasOwn(STEP_KINDS, field('kind')) ? field('kind') : 'task') as StepKind
      const name = field('name').slice(0, 120)
      if (!name) return edit({ error: 'Name the step' })
      if (draft.steps.length >= MAX_STEPS) return edit({ error: `A process holds at most ${MAX_STEPS} steps` })
      draft.steps.push(newStep(kind, name))
      await save({ draft })
      return edit()
    }

    if (intent.startsWith('step.')) {
      const at = draft.steps.findIndex((item) => item.id === field('step'))
      const step = draft.steps[at]
      if (!step) return edit({ error: 'That step does not exist' })
      if (intent === 'step.remove') {
        draft.steps.splice(at, 1)
        for (const other of draft.steps) if (other.kind === 'approval' && other.onReject === step.id) other.onReject = 'end'
      } else if (intent === 'step.up' || intent === 'step.down') {
        const to = intent === 'step.up' ? at - 1 : at + 1
        const other = draft.steps[to]
        if (other) {
          draft.steps[to] = step
          draft.steps[at] = other
        }
      } else if (intent === 'step.save') {
        const hours = Number(field('dueHours'))
        step.name = field('name').slice(0, 120) || step.name
        step.dueHours = Number.isInteger(hours) && hours >= 1 && hours <= 8760 ? hours : null
        const long = (name: string) => String(form.get(name) ?? '').slice(0, 4000)
        if (step.kind === 'task' || step.kind === 'approval') {
          step.assignee = assigneeFrom(field('assignee'))
          step.instructions = long('instructions')
        }
        if (step.kind === 'approval') step.onReject = field('onReject') || 'end'
        if (step.kind === 'agent') {
          step.agentId = field('agentId')
          step.prompt = long('prompt')
        }
        if (step.kind === 'ticket') {
          step.projectId = field('projectId')
          step.agentId = field('agentId') || null
          step.title = field('title').slice(0, 255)
          step.description = long('description')
          step.wait = field('wait') === 'on'
        }
      } else return edit({ error: 'The page sent something it should not have' })
      await save({ draft })
      return edit()
    }

    throw new CompanyError('The page sent something it should not have. Open Company again in the sidebar')
  } catch (error) {
    if (!(error instanceof CompanyError)) deps.log?.(`Company page action ${intent} failed for ${orgId}: ${messageOf(error)}`)
    return back(intent.startsWith('department.') || intent === 'member.place' ? 'company' : intent.startsWith('case.') ? 'work' : 'processes', {
      error: messageOf(error),
    })
  }
}

export function companyPlugin(deps: Deps): Plugin {
  return definePlugin({
    name: 'Company',
    version: VERSION,
    description:
      'Processes for the whole company: a form starts a case, and people, approvals, agents, and tickets take it step by step. Keeps who is in which department too',
    permissions: ['members:read', 'agents:run', 'tickets:write'],
    pages: [
      {
        key: 'company',
        label: 'Company',
        placement: 'sidebar',
        render: (context, request, token) => render(deps, context, request, token),
        action: (context, request, token) => act(deps, context, request, token),
      },
    ],
    blocks: [
      {
        key: 'start_case',
        title: 'Start a company process',
        description: 'Starts a case of a Company process and waits until it is completed or rejected.',
        fields: [
          { key: 'process', label: 'Process', kind: 'select', dynamic: true, required: true },
          { key: 'title', label: 'Case title', kind: 'template', required: true, initial: '{{issue.identifier}} {{issue.title}}' },
          {
            key: 'form',
            label: 'Form',
            kind: 'longTemplate',
            placeholder: 'amount: 120',
            hint: "One line per field of the process's form, as key: value. The process editor shows each key as {{form.key}}.",
          },
        ],
        outputs: [
          { id: 'completed', label: 'Completed' },
          { id: 'rejected', label: 'Rejected' },
        ],
        provides: [
          { key: 'case', label: 'Case number' },
          { key: 'status', label: 'How the case closed' },
        ],
        run: (call) => startForWorkflow(deps, call),
        options: ({ org }) => publishedProcesses(deps, org.id),
      },
    ],
    triggers: [
      {
        key: CASE_FINISHED,
        title: 'Company case closed',
        description: 'Starts when a case someone started in Company is completed, rejected, or cancelled.',
        fields: [
          { key: 'process', label: 'Process', kind: 'select', dynamic: true, hint: 'Leave empty for any process.' },
          {
            key: 'status',
            label: 'How it closed',
            kind: 'select',
            hint: 'Leave empty for any.',
            options: [
              { value: 'completed', label: 'Completed' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'cancelled', label: 'Cancelled' },
            ],
          },
        ],
        provides: [
          { key: 'case', label: 'Case number' },
          { key: 'title', label: 'Case title' },
          { key: 'status', label: 'How the case closed' },
          { key: 'processName', label: 'Process' },
          { key: 'requester', label: 'Started by' },
        ],
        options: ({ org }) => publishedProcesses(deps, org.id),
      },
    ],
  })
}

async function publishedProcesses(deps: Deps, orgId: string) {
  return (await deps.store.processes(orgId)).filter((process) => process.published).map((process) => ({ value: process.id, label: process.name }))
}
