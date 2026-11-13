import { z } from 'zod'
import { egressHost } from './egress'

const handle = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits, and hyphens')

export const setupInput = z.object({
  orgName: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  email: z.email(),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
})
export type SetupInput = z.infer<typeof setupInput>

export const loginInput = z.object({ email: z.email(), password: z.string().min(1).max(200) })
export type LoginInput = z.infer<typeof loginInput>

/**
 * What an API token may change. Every token can read what its account can, and nothing here reaches an admin action.
 * A request that changes something and names no scope is refused for every token.
 */
export const API_TOKEN_SCOPES = [
  { id: 'runs', label: 'Runs', description: 'Start runs, message them, and cancel them.' },
  { id: 'issues', label: 'Issues', description: 'Assign issues to agents, leave instructions, retry and cancel them.' },
  { id: 'approvals', label: 'Approvals', description: 'Approve and reject what waits for a decision, merges included.' },
  {
    id: 'previews',
    label: 'Previews',
    description: 'Start, stop, and open previews. An open preview is the running app, with the secrets its project gives it.',
  },
] as const
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number]['id']
const SCOPE_IDS = API_TOKEN_SCOPES.map((scope) => scope.id) as [ApiTokenScope, ...ApiTokenScope[]]
export const DEFAULT_API_TOKEN_SCOPES: ApiTokenScope[] = ['runs', 'issues', 'approvals']

export const createApiTokenInput = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z
    .array(z.enum(SCOPE_IDS))
    .max(SCOPE_IDS.length)
    .default(DEFAULT_API_TOKEN_SCOPES)
    .transform((scopes) => [...new Set(scopes)]),
  /** Left out, the token lasts until it is revoked. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
})
export type CreateApiTokenInput = z.infer<typeof createApiTokenInput>

export const createRunnerInput = z.object({ name: z.string().trim().min(1).max(80) })
export type CreateRunnerInput = z.infer<typeof createRunnerInput>

export const createMemberInput = z.object({
  name: z.string().min(1).max(120),
  email: z.email(),
  password: z.string().min(10).max(200),
  role: z.enum(['admin', 'member']).default('member'),
})
export type CreateMemberInput = z.infer<typeof createMemberInput>

export const permissionPolicyInput = z.object({
  mode: z.enum(['read_only', 'edit', 'full']),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  requireApproval: z.array(z.string()).default([]),
  networkAccess: z.boolean().default(true),
})

export const agentInput = z.object({
  handle,
  displayName: z.string().min(1).max(120),
  archetypeId: z.uuid(),
  description: z.string().max(2000).default(''),
  systemPrompt: z.string().max(40_000).default(''),
  runtime: z.enum(['claude', 'codex', 'scripted']),
  model: z.string().max(120).nullable().default(null),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  maxBudgetUsd: z.number().positive().nullable().default(null),
  maxTurns: z.number().int().positive().nullable().default(null),
  policy: permissionPolicyInput,
  skillIds: z.array(z.uuid()).default([]),
  connectionIds: z.array(z.uuid()).default([]),
  status: z.enum(['active', 'disabled']).default('active'),
})
export type AgentInput = z.infer<typeof agentInput>

/** A pipeline step wants a role, and any agent whose archetype works as that role can take it. Other stays out of those steps. */
export const ARCHETYPE_ROLES = [
  { value: 'engineer', label: 'Engineer', hint: 'Plans, changes code, opens merge requests, and addresses review.' },
  { value: 'reviewer', label: 'Reviewer', hint: 'Reads merge requests and gives a verdict. Never changes code.' },
  {
    value: 'other',
    label: 'Other',
    hint: 'Researcher, security, and the like. Works on tickets it is assigned and posts a report. Never changes code.',
  },
] as const

export const archetypeInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).default(''),
  role: z.enum(['engineer', 'reviewer', 'other']),
  systemPrompt: z.string().max(40_000).default(''),
})
export type ArchetypeInput = z.infer<typeof archetypeInput>

export const skillInput = z.object({
  slug: handle,
  name: z.string().min(1).max(120),
  markdown: z.string().min(1).max(100_000),
})
export type SkillInput = z.infer<typeof skillInput>

/**
 * For update bodies. Zod's `.partial()` still applies `.default()` to a missing key, so a body that
 * changes one field would silently reset every defaulted field to its default.
 */
function updateOf<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>): z.ZodType<Partial<z.output<z.ZodObject<Shape>>>> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      ((field instanceof z.ZodDefault ? field.removeDefault() : field) as z.ZodType).optional(),
    ]),
  )
  return z.object(shape) as unknown as z.ZodType<Partial<z.output<z.ZodObject<Shape>>>>
}

export const CONNECTION_KINDS = ['linear', 'gitlab', 'anthropic', 'openai', 'mcp_stdio', 'mcp_http', 'generic', 'slack', 'doppler'] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

export const connectionInput = z.object({
  kind: z.enum(CONNECTION_KINDS),
  name: z.string().min(1).max(120),
  config: z
    .looseObject({
      botName: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .refine((name) => !/[\p{Cc}<>]/u.test(name) && !name.startsWith('-'), 'Use a plain name')
        .optional(),
      botEmail: z.email('Use an email address').max(254).optional(),
    })
    .default({}),
  /** A token for most kinds, an env map for generic and MCP kinds. Never returned by the API. */
  secret: z.union([z.string().min(1), z.record(z.string(), z.string())]).optional(),
})
export type ConnectionInput = z.infer<typeof connectionInput>

export const connectionUpdateInput = updateOf(connectionInput.omit({ kind: true }))
export type ConnectionUpdateInput = z.infer<typeof connectionUpdateInput>

const repoCommands = z.array(z.string().trim().min(1).max(2000)).max(20).default([])

export const projectRepoInput = z.object({
  scmRepoId: z.string().min(1),
  scmRepoPath: z.string().min(1),
  scmCloneUrl: z.url(),
  defaultBranch: z.string().min(1).default('main'),
  setupCommands: repoCommands,
  checkCommands: repoCommands,
})
export type ProjectRepoInput = z.infer<typeof projectRepoInput>

export const projectInput = z.object({
  name: z.string().min(1).max(120),
  trackerConnectionId: z.uuid(),
  trackerTeamId: z.string().min(1),
  trackerProjectId: z.string().min(1).nullable().default(null),
  scmConnectionId: z.uuid(),
  repos: z
    .array(projectRepoInput)
    .min(1, 'Pick at least one repository')
    .max(10)
    .refine((repos) => new Set(repos.map((repo) => repo.scmRepoId)).size === repos.length, 'A repository can only be added once'),
  autonomy: z.enum(['plan_first', 'human_merge', 'full_auto']).default('human_merge'),
  stateMap: z.record(z.string(), z.string()).default({}),
  trigger: z.object({ states: z.array(z.string()).min(1) }).default({ states: ['Todo'] }),
  sandboxImage: z.string().max(300).nullable().default(null),
  networkPolicy: z.enum(['restricted', 'open', 'none']).default('restricted'),
  networkAllowlist: z.array(egressHost).default([]),
  networkBypass: z.array(egressHost).max(100).default([]),
  reviewComments: z.enum(['inline', 'summary']).default('inline'),
  runnerId: z.uuid().nullable().default(null),
  runTimeoutMinutes: z.number().int().min(1).max(1440).default(90),
  monthlyBudgetUsd: z.number().positive().nullable().default(null),
  defaultEngineerAgentId: z.uuid().nullable().default(null),
  defaultReviewerAgentId: z.uuid().nullable().default(null),
})
export type ProjectInput = z.infer<typeof projectInput>

export const projectUpdateInput = updateOf(projectInput)
export const archetypeUpdateInput = updateOf(archetypeInput)
export type ProjectUpdateInput = z.infer<typeof projectUpdateInput>

export const createIssueInput = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(100_000).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assignAgentId: z.uuid().nullable().optional(),
})
export type CreateIssueInput = z.infer<typeof createIssueInput>

const many = z.preprocess(
  (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
  z.array(z.string().min(1).max(300)).max(200),
)

/** Each field with the direction people want first when they pick it. */
export const ISSUE_SORTS = {
  updated: 'desc',
  created: 'desc',
  priority: 'asc',
  status: 'asc',
  title: 'asc',
  identifier: 'desc',
  assignee: 'asc',
  author: 'asc',
} as const
export type IssueSort = keyof typeof ISSUE_SORTS
export type IssueSortDirection = 'asc' | 'desc'

export const issueListQuery = z.object({
  projectId: z.uuid().optional(),
  q: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  status: many,
  priority: many,
  assignee: many,
  author: many,
  label: many,
  factoryState: many,
  agentId: many,
  scope: z.enum(['open', 'closed', 'all']).default('all'),
  group: z.enum(['state']).optional(),
  sort: z.enum(Object.keys(ISSUE_SORTS) as [IssueSort, ...IssueSort[]]).default('updated'),
  direction: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type IssueListQuery = z.infer<typeof issueListQuery>

/** The filter value that means "has none", in fields where a real value could be any name. */
export const NO_VALUE = '__none__'

export const assignIssueInput = z.object({ agentId: z.uuid().nullable() })
export type AssignIssueInput = z.infer<typeof assignIssueInput>

export const adHocRunInput = z.object({
  agentId: z.uuid(),
  prompt: z.string().min(1).max(100_000),
  gitUrl: z.string().min(1).max(1000),
  ref: z.string().max(200).optional(),
  /** Pushes what the run commits to a branch of its own, so it can be fetched. Left out, the run pushes nothing. */
  push: z.boolean().optional(),
  scmConnectionId: z.uuid().optional(),
})
export type AdHocRunInput = z.infer<typeof adHocRunInput>

export const decideApprovalInput = z.object({
  decision: z.enum(['approved', 'rejected']),
  /** Gates with more than two ways forward name the one taken. */
  choice: z.enum(['retry', 'revert', 'keep']).optional(),
  message: z.string().max(20_000).optional(),
  updatedInput: z.unknown().optional(),
})
export type DecideApprovalInput = z.infer<typeof decideApprovalInput>

export const runMessageInput = z.object({ text: z.string().min(1).max(20_000) })
export type RunMessageInput = z.infer<typeof runMessageInput>

export const cancelRunInput = z.object({ discard: z.boolean().default(false) })
export type CancelRunInput = z.infer<typeof cancelRunInput>
