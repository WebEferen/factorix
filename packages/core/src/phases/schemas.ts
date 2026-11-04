import type { JsonSchema } from '@factorix/runtime'

const object = (properties: Record<string, unknown>): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})
const string = { type: 'string' }
const strings = { type: 'array', items: string }

export const PLAN_SCHEMA = object({ summary: string, steps: strings, filesTouched: strings, risks: strings, questions: strings })

export const IMPLEMENT_SCHEMA = object({ summary: string, approach: string, testing: string, notes: string, mergeOrder: strings })

export const REVIEW_SCHEMA = object({
  verdict: { type: 'string', enum: ['approve', 'request_changes'] },
  summary: string,
  comments: {
    type: 'array',
    items: object({
      repo: string,
      path: string,
      line: { type: 'integer' },
      side: { type: 'string', enum: ['new', 'old'] },
      body: string,
      severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
    }),
  },
})

export const ADDRESS_SCHEMA = object({
  summary: string,
  mergeOrder: strings,
  threads: {
    type: 'array',
    items: object({ discussionId: string, reply: string, resolved: { type: 'boolean' } }),
  },
})

export interface PlanOutput {
  summary: string
  steps: string[]
  filesTouched: string[]
  risks: string[]
  questions: string[]
}

export interface ImplementOutput {
  summary: string
  approach: string
  testing: string
  notes: string
  /** The folders it changed, in the order they must merge. */
  mergeOrder?: string[]
}

export interface ReviewComment {
  /** The folder of the repository it belongs to. */
  repo?: string
  path: string
  line: number
  side: 'new' | 'old'
  body: string
  severity: 'blocker' | 'major' | 'minor' | 'nit'
}

export interface ReviewOutput {
  verdict: 'approve' | 'request_changes'
  summary: string
  comments: ReviewComment[]
}

export interface AddressOutput {
  summary: string
  mergeOrder?: string[]
  threads: { discussionId: string; reply: string; resolved: boolean }[]
}

export const TASK_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', description: 'Your report in Markdown: what you found, the evidence, and what you recommend.' },
  },
}

export interface TaskOutput {
  summary: string
}
