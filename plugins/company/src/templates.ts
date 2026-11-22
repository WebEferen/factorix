import type { Definition } from './model'

export interface Template {
  key: string
  name: string
  description: string
  definition: Definition
}

const field = (key: string, label: string, type: Definition['form'][number]['type'] = 'text', required = true, options: string[] = []) => ({
  key,
  label,
  type,
  required,
  options,
})

/** Processes to start from. They use only people, so they publish without picking an agent or a project first. */
export const TEMPLATES: Template[] = [
  {
    key: 'purchase',
    name: 'Purchase request',
    description: 'Someone asks to buy something, the owner approves it, and the requester orders it.',
    definition: {
      form: [field('item', 'What to buy'), field('amount', 'Cost', 'number'), field('reason', 'Why it is needed', 'longtext')],
      steps: [
        {
          id: 'approve',
          kind: 'approval',
          name: 'Approve the purchase',
          dueHours: 48,
          assignee: { kind: 'owner' },
          instructions: '{{requester.name}} asks for {{form.item}} at {{form.amount}}.\n\n{{form.reason}}',
          onReject: 'end',
        },
        {
          id: 'order',
          kind: 'task',
          name: 'Place the order',
          dueHours: 72,
          assignee: { kind: 'requester' },
          instructions: 'Approved by {{steps.approve.by}}. Order {{form.item}} and note the order number here.',
        },
      ],
    },
  },
  {
    key: 'onboarding',
    name: 'Employee onboarding',
    description: 'Gets a new person their accounts, their equipment, and a first-week plan.',
    definition: {
      form: [
        field('name', 'Name of the new person'),
        field('role', 'Role'),
        field('start', 'First day', 'date'),
        field('notes', 'Anything to prepare', 'longtext', false),
      ],
      steps: [
        {
          id: 'accounts',
          kind: 'task',
          name: 'Create accounts and order equipment',
          dueHours: 72,
          assignee: { kind: 'owner' },
          instructions: '{{form.name}} starts as {{form.role}} on {{form.start}}.\n\n{{form.notes}}',
        },
        {
          id: 'plan',
          kind: 'task',
          name: 'Write the first-week plan',
          dueHours: 72,
          assignee: { kind: 'requester' },
          instructions: 'Write what {{form.name}} does in the first week, and who they meet.',
        },
        {
          id: 'ready',
          kind: 'approval',
          name: 'Confirm everything is ready',
          dueHours: 24,
          assignee: { kind: 'owner' },
          instructions: 'Accounts: {{steps.accounts.note}}\n\nPlan: {{steps.plan.note}}',
          onReject: 'plan',
        },
      ],
    },
  },
  {
    key: 'timeoff',
    name: 'Time off request',
    description: 'A person asks for days off, and the owner approves or rejects.',
    definition: {
      form: [
        field('from', 'First day off', 'date'),
        field('to', 'Last day off', 'date'),
        field('kind', 'Kind', 'select', true, ['Vacation', 'Sick leave', 'Other']),
        field('note', 'Note', 'longtext', false),
      ],
      steps: [
        {
          id: 'approve',
          kind: 'approval',
          name: 'Approve the time off',
          dueHours: 48,
          assignee: { kind: 'owner' },
          instructions: '{{requester.name}}: {{form.kind}} from {{form.from}} to {{form.to}}.\n\n{{form.note}}',
          onReject: 'end',
        },
      ],
    },
  },
]
