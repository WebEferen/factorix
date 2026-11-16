import { linearMarkup } from '../linear/markup'
import type { SourceMarkup, TrackerSource } from '../source'
import type { TrackerState } from '../tracker'

/** Every board of built-in tickets moves through the same statuses, so they need no table. */
export const FACTORIX_STATES: TrackerState[] = [
  { id: 'backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'in_progress', name: 'In Progress', type: 'started', position: 2 },
  { id: 'in_review', name: 'In Review', type: 'started', position: 3 },
  { id: 'blocked', name: 'Blocked', type: 'started', position: 4 },
  { id: 'done', name: 'Done', type: 'completed', position: 5 },
  { id: 'canceled', name: 'Canceled', type: 'canceled', position: 6 },
]

/** Built-in tickets are written as plain Markdown and name each other like Linear's do, as ABC-123. */
export const factorixMarkup: SourceMarkup = {
  isMediaUrl: () => false,
  toMarkdown: (text) => text,
  linkReferences: linearMarkup.linkReferences,
  issueReferences: linearMarkup.issueReferences,
}

export const factorixSource: TrackerSource = {
  markup: factorixMarkup,
  issueFilters: [
    { key: 'title', label: 'Title', kind: 'text' },
    { key: 'status', label: 'Status', kind: 'multi' },
    { key: 'priority', label: 'Priority', kind: 'multi' },
    { key: 'author', label: 'Author', kind: 'multi' },
    { key: 'label', label: 'Label', kind: 'multi' },
  ],
  issueSorts: [
    { key: 'updated', label: 'Updated', asc: 'Oldest first', desc: 'Newest first' },
    { key: 'created', label: 'Created', asc: 'Oldest first', desc: 'Newest first' },
    { key: 'priority', label: 'Priority', asc: 'Urgent first', desc: 'Low first' },
    { key: 'status', label: 'Status', asc: 'Not started first', desc: 'Finished first' },
    { key: 'title', label: 'Title', asc: 'A to Z', desc: 'Z to A' },
    { key: 'identifier', label: 'ID', asc: 'Lowest first', desc: 'Highest first' },
    { key: 'author', label: 'Author', asc: 'A to Z', desc: 'Z to A' },
  ],
  priorityLabels: { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' },
  egressHosts: () => [],
}
