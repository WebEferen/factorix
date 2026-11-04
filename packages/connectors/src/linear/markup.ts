import {
  type IssueFilterSpec,
  type IssueSortSpec,
  type MarkupContext,
  mapInline,
  mapProse,
  type SourceMarkup,
  splitHtmlBreaks,
  type TrackerSource,
} from '../source'

const MEDIA_HOSTS = new Set(['uploads.linear.app', 'public.linear.app'])
const LINK = /(!?)\[((?:[^\][]|\[[^\]]*\])*)\]\((https:\/\/[^\s)]+)\)/g
const BARE_UPLOAD = /https:\/\/(?:uploads|public)\.linear\.app\/[^\s)\]]+/g
const BARE_ISSUE = /(?<!\]\()https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[\w-]*)?(?:#[\w-]*)?/g
const IDENTIFIER = /(?<![\w/-])([A-Z][A-Z0-9]{0,9})-(\d+)\b/g

function isMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && MEDIA_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

function rewriteUploads(line: string, context: MarkupContext): string {
  const media = context.media
  if (!media) return line
  return line
    .replace(LINK, (whole, bang: string, label: string, url: string) => (isMediaUrl(url) ? `${bang}[${label}](${media(url)})` : whole))
    .replace(BARE_UPLOAD, (url) => `[file](${media(url)})`)
}

/** Linear keeps single newlines as line breaks, unlike CommonMark, so they become explicit hard breaks. */
function withHardBreaks(lines: string[]): string[] {
  return lines.map((line, index) => {
    const next = lines[index + 1]
    return line.trim() && next?.trim() ? `${line.trimEnd()}  ` : line
  })
}

function convert(lines: string[], context: MarkupContext): string[] {
  const kept: string[] = []
  for (const line of splitHtmlBreaks(lines)) {
    // The editor leaves empty bullets behind that Linear itself never draws.
    if (/^\s*[-*+]\s*$/.test(line)) continue
    const section = /^\+\+\+\s*(.*)$/.exec(line)
    if (section) {
      if (section[1]) kept.push(`**${section[1].trim()}**`, '')
      continue
    }
    kept.push(
      rewriteUploads(line, context).replace(BARE_ISSUE, (url, identifier: string) => `[${identifier}](${context.issueUrl?.(identifier) ?? url})`),
    )
  }
  return withHardBreaks(kept)
}

export const linearMarkup: SourceMarkup = {
  isMediaUrl,
  toMarkdown: (text, context = {}) => mapProse(text, (lines) => convert(lines, context)),
  linkReferences: (markdown, context) =>
    mapInline(markdown, {
      text: (text) =>
        text.replace(IDENTIFIER, (whole, key: string, number: string) => {
          if (!context.issueKeys?.includes(key)) return whole
          const url = context.issueUrl?.(`${key}-${number}`)
          return url ? `[${whole}](${url})` : whole
        }),
    }),
  issueReferences: (text) => [...new Set([...text.matchAll(/\b[A-Z][A-Z0-9]{0,9}-\d+\b/g)].map((match) => match[0]))],
}

const LINEAR_FILTERS: IssueFilterSpec[] = [
  { key: 'title', label: 'Title', kind: 'text' },
  { key: 'status', label: 'Status', kind: 'multi' },
  { key: 'priority', label: 'Priority', kind: 'multi' },
  { key: 'assignee', label: 'Assignee', kind: 'multi' },
  { key: 'author', label: 'Author', kind: 'multi' },
  { key: 'label', label: 'Label', kind: 'multi' },
]

const LINEAR_SORTS: IssueSortSpec[] = [
  { key: 'updated', label: 'Updated', asc: 'Oldest first', desc: 'Newest first' },
  { key: 'created', label: 'Created', asc: 'Oldest first', desc: 'Newest first' },
  { key: 'priority', label: 'Priority', asc: 'Urgent first', desc: 'Low first' },
  { key: 'status', label: 'Status', asc: 'Not started first', desc: 'Finished first' },
  { key: 'title', label: 'Title', asc: 'A to Z', desc: 'Z to A' },
  { key: 'identifier', label: 'ID', asc: 'Lowest first', desc: 'Highest first' },
  { key: 'assignee', label: 'Assignee', asc: 'A to Z', desc: 'Z to A' },
  { key: 'author', label: 'Author', asc: 'A to Z', desc: 'Z to A' },
]

export const linearSource: TrackerSource = {
  markup: linearMarkup,
  issueFilters: LINEAR_FILTERS,
  issueSorts: LINEAR_SORTS,
  priorityLabels: { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' },
  egressHosts: () => [],
}
