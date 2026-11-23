import type { Migration } from '@moxxy/factorix-plugin-sdk'
import type { Case, CaseEvent, CaseStatus, Definition, Department, Placement, Process, StepPhase } from './model'

export interface CaseFilter {
  status?: CaseStatus
  /** Cases whose current step waits for this person. */
  assigneeId?: string
  requesterId?: string
  /** Running cases whose current step waits for a person and has nobody on it. */
  unassigned?: boolean
  limit: number
}

export type CaseChange = Partial<
  Pick<
    Case,
    'status' | 'outputs' | 'current' | 'phase' | 'assigneeId' | 'assigneeName' | 'ref' | 'refUrl' | 'stepAt' | 'dueAt' | 'error' | 'finishedAt'
  >
>

/** Everything the plugin keeps. One plugin serves every organization that turned it on, so every row has its organization. */
export interface Store {
  /** Records the plugin id an organization's pages came with, which the sweep needs to call Factorix. */
  rememberPlugin(orgId: string, pluginId: string): Promise<void>
  pluginOf(orgId: string): Promise<string | null>
  departments(orgId: string): Promise<Department[]>
  saveDepartment(department: Department): Promise<void>
  removeDepartment(orgId: string, id: string): Promise<void>
  placements(orgId: string): Promise<Placement[]>
  savePlacement(placement: Placement): Promise<void>
  processes(orgId: string): Promise<Process[]>
  process(orgId: string, id: string): Promise<Process | null>
  saveProcess(process: Process): Promise<void>
  /** Stores a new case under the organization's next number, and returns it. */
  insertCase(item: Omit<Case, 'number'>): Promise<Case>
  case(orgId: string, id: string): Promise<Case | null>
  cases(orgId: string, filter: CaseFilter): Promise<Case[]>
  /** How many cases an organization has in each status. */
  counts(orgId: string): Promise<Record<string, number>>
  /**
   * Changes a case only if it is still at the step and phase the caller saw, so a click and the sweep, or two people at
   * once, never both move it.
   */
  updateCase(item: Pick<Case, 'id' | 'current' | 'phase' | 'status'>, change: CaseChange, now: Date): Promise<boolean>
  /** Running cases that wait for the plugin or for Factorix, not for a person. */
  unsettled(): Promise<Case[]>
  /** Closed cases Factorix has not heard about yet: neither the workflow that started one nor the workflows built on its closing. */
  unreported(): Promise<Case[]>
  markReported(orgId: string, id: string, now: Date): Promise<void>
  addEvent(event: CaseEvent): Promise<void>
  events(orgId: string, caseId: string): Promise<CaseEvent[]>
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_company',
    up: `
CREATE TABLE company_orgs (
  org_id text PRIMARY KEY,
  plugin_id text NOT NULL,
  next_case integer NOT NULL DEFAULT 1
);
CREATE TABLE departments (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  lead_id text
);
CREATE INDEX departments_org ON departments (org_id);
CREATE TABLE placements (
  org_id text NOT NULL,
  member_id text NOT NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, member_id)
);
CREATE TABLE processes (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id text,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  draft jsonb NOT NULL,
  published jsonb,
  version integer NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processes_org ON processes (org_id) WHERE NOT archived;
CREATE TABLE cases (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  process_id uuid NOT NULL REFERENCES processes(id),
  process_name text NOT NULL,
  owner_id text,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'rejected', 'cancelled', 'failed')),
  data jsonb NOT NULL,
  outputs jsonb NOT NULL DEFAULT '{}',
  requester_id text NOT NULL,
  requester_name text NOT NULL,
  current text,
  phase text CHECK (phase IN ('pending', 'entering', 'todo', 'waiting')),
  assignee_id text,
  assignee_name text,
  ref text,
  ref_url text,
  step_at timestamptz,
  due_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (org_id, number)
);
CREATE INDEX cases_org_created ON cases (org_id, created_at DESC);
CREATE INDEX cases_todo ON cases (org_id, assignee_id) WHERE status = 'running' AND phase = 'todo';
CREATE INDEX cases_unsettled ON cases (updated_at) WHERE status = 'running' AND phase IN ('pending', 'entering', 'waiting');
CREATE TABLE case_events (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  text text NOT NULL
);
CREATE INDEX case_events_case ON case_events (case_id, at);`,
    down: 'DROP TABLE case_events; DROP TABLE cases; DROP TABLE processes; DROP TABLE placements; DROP TABLE departments; DROP TABLE company_orgs;',
  },
  {
    id: '0002_workflow_cases',
    up: `
ALTER TABLE cases ADD COLUMN workflow_run_id text, ADD COLUMN workflow_node_id text, ADD COLUMN workflow_reported_at timestamptz;
CREATE INDEX cases_unreported ON cases (updated_at)
  WHERE workflow_run_id IS NOT NULL AND workflow_reported_at IS NULL AND status IN ('completed', 'rejected', 'cancelled');`,
    down: 'DROP INDEX cases_unreported; ALTER TABLE cases DROP COLUMN workflow_run_id, DROP COLUMN workflow_node_id, DROP COLUMN workflow_reported_at;',
  },
  {
    // Every closed case now tells Factorix, to start the workflows built on it. Those closed before are left alone.
    id: '0003_closed_cases',
    up: `
UPDATE cases SET workflow_reported_at = updated_at WHERE workflow_reported_at IS NULL AND status IN ('completed', 'rejected', 'cancelled');
DROP INDEX cases_unreported;
CREATE INDEX cases_unreported ON cases (updated_at) WHERE workflow_reported_at IS NULL AND status IN ('completed', 'rejected', 'cancelled');`,
    down: `
DROP INDEX cases_unreported;
CREATE INDEX cases_unreported ON cases (updated_at)
  WHERE workflow_run_id IS NOT NULL AND workflow_reported_at IS NULL AND status IN ('completed', 'rejected', 'cancelled');`,
  },
]

/** A `pg` Pool, or anything else that runs one statement with numbered parameters. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)))
const dateOrNull = (value: unknown) => (value ? date(value) : null)
const orNull = <T>(value: unknown) => (value ?? null) as T | null

const departmentOf = (row: Record<string, unknown>): Department => ({
  id: String(row.id),
  orgId: String(row.org_id),
  name: String(row.name),
  leadId: orNull<string>(row.lead_id),
})

const placementOf = (row: Record<string, unknown>): Placement => ({
  orgId: String(row.org_id),
  memberId: String(row.member_id),
  departmentId: orNull<string>(row.department_id),
  title: String(row.title),
})

const processOf = (row: Record<string, unknown>): Process => ({
  id: String(row.id),
  orgId: String(row.org_id),
  name: String(row.name),
  description: String(row.description),
  ownerId: orNull<string>(row.owner_id),
  departmentId: orNull<string>(row.department_id),
  draft: row.draft as Definition,
  published: orNull<Definition>(row.published),
  version: Number(row.version),
  archived: Boolean(row.archived),
  createdAt: date(row.created_at),
  updatedAt: date(row.updated_at),
})

const caseOf = (row: Record<string, unknown>): Case => ({
  id: String(row.id),
  orgId: String(row.org_id),
  processId: String(row.process_id),
  processName: String(row.process_name),
  ownerId: orNull<string>(row.owner_id),
  version: Number(row.version),
  definition: row.definition as Definition,
  number: Number(row.number),
  title: String(row.title),
  status: row.status as CaseStatus,
  data: row.data as Record<string, string>,
  outputs: row.outputs as Case['outputs'],
  requesterId: String(row.requester_id),
  requesterName: String(row.requester_name),
  current: orNull<string>(row.current),
  phase: orNull<StepPhase>(row.phase),
  assigneeId: orNull<string>(row.assignee_id),
  assigneeName: orNull<string>(row.assignee_name),
  ref: orNull<string>(row.ref),
  refUrl: orNull<string>(row.ref_url),
  stepAt: dateOrNull(row.step_at),
  dueAt: dateOrNull(row.due_at),
  error: orNull<string>(row.error),
  createdAt: date(row.created_at),
  updatedAt: date(row.updated_at),
  finishedAt: dateOrNull(row.finished_at),
  workflow: row.workflow_run_id ? { runId: String(row.workflow_run_id), nodeId: String(row.workflow_node_id) } : null,
})

const eventOf = (row: Record<string, unknown>): CaseEvent => ({
  id: String(row.id),
  caseId: String(row.case_id),
  orgId: String(row.org_id),
  at: date(row.at),
  actor: String(row.actor),
  text: String(row.text),
})

const CHANGE_COLUMNS: Record<keyof CaseChange, string> = {
  status: 'status',
  outputs: 'outputs',
  current: 'current',
  phase: 'phase',
  assigneeId: 'assignee_id',
  assigneeName: 'assignee_name',
  ref: 'ref',
  refUrl: 'ref_url',
  stepAt: 'step_at',
  dueAt: 'due_at',
  error: 'error',
  finishedAt: 'finished_at',
}

const UNSETTLED: (StepPhase | null)[] = ['pending', 'entering', 'waiting']

export function pgStore(db: Queryable): Store {
  const one = async <T>(sql: string, params: unknown[], map: (row: Record<string, unknown>) => T) => {
    const row = (await db.query(sql, params)).rows[0]
    return row ? map(row) : null
  }
  const many = async <T>(sql: string, params: unknown[], map: (row: Record<string, unknown>) => T) => (await db.query(sql, params)).rows.map(map)
  return {
    async rememberPlugin(orgId, pluginId) {
      await db.query(
        `INSERT INTO company_orgs (org_id, plugin_id) VALUES ($1, $2)
         ON CONFLICT (org_id) DO UPDATE SET plugin_id = $2 WHERE company_orgs.plugin_id IS DISTINCT FROM $2`,
        [orgId, pluginId],
      )
    },
    pluginOf: (orgId) => one('SELECT plugin_id FROM company_orgs WHERE org_id = $1', [orgId], (row) => String(row.plugin_id)),
    departments: (orgId) => many('SELECT * FROM departments WHERE org_id = $1 ORDER BY name', [orgId], departmentOf),
    async saveDepartment(d) {
      await db.query(
        `INSERT INTO departments (id, org_id, name, lead_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = $3, lead_id = $4 WHERE departments.org_id = $2`,
        [d.id, d.orgId, d.name, d.leadId],
      )
    },
    async removeDepartment(orgId, id) {
      if (UUID.test(id)) await db.query('DELETE FROM departments WHERE org_id = $1 AND id = $2', [orgId, id])
    },
    placements: (orgId) => many('SELECT * FROM placements WHERE org_id = $1', [orgId], placementOf),
    async savePlacement(p) {
      await db.query(
        `INSERT INTO placements (org_id, member_id, department_id, title) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, member_id) DO UPDATE SET department_id = $3, title = $4`,
        [p.orgId, p.memberId, p.departmentId, p.title],
      )
    },
    processes: (orgId) => many('SELECT * FROM processes WHERE org_id = $1 AND NOT archived ORDER BY name', [orgId], processOf),
    process: (orgId, id) =>
      UUID.test(id) ? one('SELECT * FROM processes WHERE org_id = $1 AND id = $2', [orgId, id], processOf) : Promise.resolve(null),
    async saveProcess(p) {
      await db.query(
        `INSERT INTO processes (id, org_id, name, description, owner_id, department_id, draft, published, version, archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET name = $3, description = $4, owner_id = $5, department_id = $6, draft = $7, published = $8,
           version = $9, archived = $10, updated_at = $12 WHERE processes.org_id = $2`,
        [
          p.id,
          p.orgId,
          p.name,
          p.description,
          p.ownerId,
          p.departmentId,
          JSON.stringify(p.draft),
          p.published ? JSON.stringify(p.published) : null,
          p.version,
          p.archived,
          p.createdAt,
          p.updatedAt,
        ],
      )
    },
    async insertCase(c) {
      const row = (
        await db.query(
          `WITH numbered AS (UPDATE company_orgs SET next_case = next_case + 1 WHERE org_id = $2 RETURNING next_case - 1 AS number)
           INSERT INTO cases (id, org_id, process_id, process_name, owner_id, version, definition, number, title, status, data, outputs,
             requester_id, requester_name, current, phase, step_at, created_at, updated_at, workflow_run_id, workflow_node_id)
           SELECT $1, $2, $3, $4, $5, $6, $7, numbered.number, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, $18, $19 FROM numbered
           RETURNING *`,
          [
            c.id,
            c.orgId,
            c.processId,
            c.processName,
            c.ownerId,
            c.version,
            JSON.stringify(c.definition),
            c.title,
            c.status,
            JSON.stringify(c.data),
            JSON.stringify(c.outputs),
            c.requesterId,
            c.requesterName,
            c.current,
            c.phase,
            c.stepAt,
            c.createdAt,
            c.workflow?.runId ?? null,
            c.workflow?.nodeId ?? null,
          ],
        )
      ).rows[0]
      if (!row) throw new Error('The organization has not opened the plugin yet, so it has no case numbers')
      return caseOf(row)
    },
    case: (orgId, id) => (UUID.test(id) ? one('SELECT * FROM cases WHERE org_id = $1 AND id = $2', [orgId, id], caseOf) : Promise.resolve(null)),
    cases(orgId, filter) {
      const where = ['org_id = $1']
      const params: unknown[] = [orgId]
      const add = (sql: string, value: unknown) => {
        params.push(value)
        where.push(sql.replace('?', `$${params.length}`))
      }
      if (filter.status) add('status = ?', filter.status)
      if (filter.assigneeId) add("status = 'running' AND phase = 'todo' AND assignee_id = ?", filter.assigneeId)
      if (filter.unassigned) where.push("status = 'running' AND phase = 'todo' AND assignee_id IS NULL")
      if (filter.requesterId) add('requester_id = ?', filter.requesterId)
      params.push(filter.limit)
      return many(`SELECT * FROM cases WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`, params, caseOf)
    },
    async counts(orgId) {
      const rows = (await db.query('SELECT status, count(*) AS count FROM cases WHERE org_id = $1 GROUP BY status', [orgId])).rows
      return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]))
    },
    async updateCase(item, change, now) {
      const entries = Object.entries(change).filter(([, value]) => value !== undefined) as [keyof CaseChange, unknown][]
      const sets = entries.map(([key], index) => `${CHANGE_COLUMNS[key]} = $${index + 6}`)
      const values = entries.map(([key, value]) => (key === 'outputs' ? JSON.stringify(value) : value))
      const result = await db.query(
        `UPDATE cases SET ${[...sets, 'updated_at = $5'].join(', ')}
         WHERE id = $1 AND status = $2 AND current IS NOT DISTINCT FROM $3 AND phase IS NOT DISTINCT FROM $4`,
        [item.id, item.status, item.current, item.phase, now, ...values],
      )
      return (result.rowCount ?? 0) > 0
    },
    unsettled: () =>
      many("SELECT * FROM cases WHERE status = 'running' AND phase IN ('pending', 'entering', 'waiting') ORDER BY updated_at", [], caseOf),
    unreported: () =>
      many(
        `SELECT * FROM cases WHERE workflow_reported_at IS NULL AND status IN ('completed', 'rejected', 'cancelled')
         ORDER BY updated_at LIMIT 100`,
        [],
        caseOf,
      ),
    async markReported(orgId, id, now) {
      await db.query('UPDATE cases SET workflow_reported_at = $3 WHERE org_id = $1 AND id = $2', [orgId, id, now])
    },
    async addEvent(e) {
      await db.query('INSERT INTO case_events (id, case_id, org_id, at, actor, text) VALUES ($1, $2, $3, $4, $5, $6)', [
        e.id,
        e.caseId,
        e.orgId,
        e.at,
        e.actor,
        e.text,
      ])
    },
    events: (orgId, caseId) =>
      UUID.test(caseId)
        ? many('SELECT * FROM case_events WHERE org_id = $1 AND case_id = $2 ORDER BY at, id', [orgId, caseId], eventOf)
        : Promise.resolve([]),
  }
}

/** The same store in memory, for tests and for trying the plugin without a database. */
export function memoryStore(): Store & { rows: Case[] } {
  const plugins = new Map<string, { pluginId: string; next: number }>()
  const departments: Department[] = []
  const placements: Placement[] = []
  const processes: Process[] = []
  const rows: Case[] = []
  const events: CaseEvent[] = []
  const reported = new Set<string>()
  const copy = <T>(value: T): T => structuredClone(value)
  const newestFirst = (list: Case[]) => [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.number - a.number)
  return {
    rows,
    async rememberPlugin(orgId, pluginId) {
      plugins.set(orgId, { next: 1, ...plugins.get(orgId), pluginId })
    },
    async pluginOf(orgId) {
      return plugins.get(orgId)?.pluginId ?? null
    },
    async departments(orgId) {
      return copy(departments.filter((d) => d.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name)))
    },
    async saveDepartment(department) {
      const at = departments.findIndex((d) => d.id === department.id)
      if (at < 0) departments.push(copy(department))
      else if (departments[at]?.orgId === department.orgId) departments[at] = copy(department)
    },
    async removeDepartment(orgId, id) {
      const at = departments.findIndex((d) => d.id === id && d.orgId === orgId)
      if (at < 0) return
      departments.splice(at, 1)
      for (const placement of placements) if (placement.departmentId === id) placement.departmentId = null
      for (const process of processes) if (process.departmentId === id) process.departmentId = null
    },
    async placements(orgId) {
      return copy(placements.filter((p) => p.orgId === orgId))
    },
    async savePlacement(placement) {
      const at = placements.findIndex((p) => p.orgId === placement.orgId && p.memberId === placement.memberId)
      if (at < 0) placements.push(copy(placement))
      else placements[at] = copy(placement)
    },
    async processes(orgId) {
      return copy(processes.filter((p) => p.orgId === orgId && !p.archived).sort((a, b) => a.name.localeCompare(b.name)))
    },
    async process(orgId, id) {
      return copy(processes.find((p) => p.orgId === orgId && p.id === id) ?? null)
    },
    async saveProcess(process) {
      const at = processes.findIndex((p) => p.id === process.id)
      if (at < 0) processes.push(copy(process))
      else if (processes[at]?.orgId === process.orgId) processes[at] = copy(process)
    },
    async insertCase(item) {
      const org = plugins.get(item.orgId)
      if (!org) throw new Error('The organization has not opened the plugin yet, so it has no case numbers')
      const stored: Case = { ...copy(item), number: org.next }
      org.next += 1
      rows.push(stored)
      return copy(stored)
    },
    async case(orgId, id) {
      return copy(rows.find((row) => row.orgId === orgId && row.id === id) ?? null)
    },
    async cases(orgId, filter) {
      const todo = (row: Case) => row.status === 'running' && row.phase === 'todo'
      return copy(
        newestFirst(
          rows.filter(
            (row) =>
              row.orgId === orgId &&
              (!filter.status || row.status === filter.status) &&
              (!filter.assigneeId || (todo(row) && row.assigneeId === filter.assigneeId)) &&
              (!filter.unassigned || (todo(row) && !row.assigneeId)) &&
              (!filter.requesterId || row.requesterId === filter.requesterId),
          ),
        ).slice(0, filter.limit),
      )
    },
    async counts(orgId) {
      const counts: Record<string, number> = {}
      for (const row of rows) if (row.orgId === orgId) counts[row.status] = (counts[row.status] ?? 0) + 1
      return counts
    },
    async updateCase(item, change, now) {
      const found = rows.find((row) => row.id === item.id)
      if (!found || found.status !== item.status || found.current !== item.current || found.phase !== item.phase) return false
      Object.assign(found, copy(Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined))), { updatedAt: now })
      return true
    },
    async unsettled() {
      return copy(rows.filter((row) => row.status === 'running' && UNSETTLED.includes(row.phase)))
    },
    async unreported() {
      return copy(rows.filter((row) => !reported.has(row.id) && ['completed', 'rejected', 'cancelled'].includes(row.status)))
    },
    async markReported(orgId, id) {
      if (rows.some((row) => row.orgId === orgId && row.id === id)) reported.add(id)
    },
    async addEvent(event) {
      events.push(copy(event))
    },
    async events(orgId, caseId) {
      return copy(events.filter((event) => event.orgId === orgId && event.caseId === caseId))
    },
  }
}
