import { linearMarkup } from '../linear/markup'
import type { SourceMarkup, TrackerSource } from '../source'

/** Uploads are read through Trello's API. The connector also checks the host before it sends the key and token. */
function isMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'api.trello.com' && /\/attachments\/[^/]+\/download\//.test(parsed.pathname)
  } catch {
    return false
  }
}

/** Trello writes Markdown already, and its cards are named here like Linear's issues, as WA-12. */
export const trelloMarkup: SourceMarkup = {
  isMediaUrl,
  toMarkdown: (text) => text,
  linkReferences: linearMarkup.linkReferences,
  issueReferences: linearMarkup.issueReferences,
}

export const trelloSource: TrackerSource = {
  markup: trelloMarkup,
  issueFilters: [
    { key: 'title', label: 'Title', kind: 'text' },
    { key: 'status', label: 'List', kind: 'multi' },
    { key: 'assignee', label: 'Member', kind: 'multi' },
    { key: 'label', label: 'Label', kind: 'multi' },
  ],
  issueSorts: [
    { key: 'updated', label: 'Updated', asc: 'Oldest first', desc: 'Newest first' },
    { key: 'created', label: 'Created', asc: 'Oldest first', desc: 'Newest first' },
    { key: 'status', label: 'List', asc: 'Not started first', desc: 'Finished first' },
    { key: 'title', label: 'Title', asc: 'A to Z', desc: 'Z to A' },
    { key: 'identifier', label: 'Number', asc: 'Lowest first', desc: 'Highest first' },
    { key: 'assignee', label: 'Member', asc: 'A to Z', desc: 'Z to A' },
  ],
  priorityLabels: { 0: 'No priority' },
  egressHosts: () => [],
}
