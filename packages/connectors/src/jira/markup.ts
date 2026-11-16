import { linearMarkup } from '../linear/markup'
import type { IssueFilterSpec, IssueSortSpec, SourceMarkup, TrackerSource } from '../source'

const HOLD = '\u0001'

/** Runs a transform over everything except the spans a pattern matches, which come back as they were written. */
function outside(text: string, protect: RegExp, keep: (span: string) => string, transform: (text: string) => string): string {
  const kept: string[] = []
  const held = text.replace(protect, (span) => `${HOLD}${kept.push(keep(span)) - 1}${HOLD}`)
  return transform(held).replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_whole, index: string) => kept[Number(index)] as string)
}

function inlineToMarkdown(line: string): string {
  return outside(
    line,
    /\{\{.+?\}\}/g,
    (span) => `\`${span.slice(2, -2)}\``,
    (text) =>
      text
        .replace(/\{color(?::[^}]*)?\}/g, '')
        .replace(/!([^!|\s]+)(?:\|[^!]*)?!/g, (_whole, target: string) => (/^https?:\/\//.test(target) ? `![](${target})` : `[${target}]`))
        .replace(/\[~(?:accountid:)?([^\]]+)\]/g, '@$1')
        .replace(/\[([^\]|\n]+)\|([^\]|\s]+)(?:\|[^\]]*)?\]/g, '[$1]($2)')
        .replace(/\[(https?:\/\/[^\]\s|]+)\]/g, '$1')
        .replace(/(?<![\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])/g, `${HOLD}b$1${HOLD}b`)
        .replace(/(?<![\w_])_(\S(?:[^_\n]*\S)?)_(?![\w_])/g, '*$1*')
        .replace(/(?<![\w-])-(\S(?:[^-\n]*\S)?)-(?![\w-])/g, '~~$1~~')
        .replace(/(?<![\w+])\+(\S(?:[^+\n]*\S)?)\+(?![\w+])/g, '$1')
        .replace(/\?\?(.+?)\?\?/g, '*$1*')
        .replace(new RegExp(`${HOLD}b`, 'g'), '**')
        .replace(/\\\\\s*$/g, '  ')
        .replace(/\\([[\]])/g, '$1'),
  )
}

function tableRow(line: string): string[] | null {
  const header = line.startsWith('||')
  if (!header && !/^\|.*\|\s*$/.test(line)) return null
  const cells = line
    .trim()
    .replace(header ? /^\|\||\|\|$/g : /^\||\|$/g, '')
    .split(header ? '||' : '|')
    .map((cell) => inlineToMarkdown(cell.trim()))
  const row = `| ${cells.join(' | ')} |`
  return header ? [row, `| ${cells.map(() => '---').join(' | ')} |`] : [row]
}

/** Jira's REST API version 2 reads and writes wiki markup, on Cloud and on Data Center alike. */
export function jiraToMarkdown(text: string): string {
  const output: string[] = []
  let code = false
  let quote = false
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const fence = /^\s*\{(code|noformat)(?::([^}|]*))?[^}]*\}\s*$/.exec(line)
    if (fence) {
      output.push(code ? '```' : `\`\`\`${fence[1] === 'code' && fence[2] && !fence[2].includes('=') ? fence[2] : ''}`)
      code = !code
      continue
    }
    if (code) {
      output.push(line)
      continue
    }
    if (/^\s*\{quote\}\s*$/.test(line)) {
      quote = !quote
      continue
    }
    const prefix = quote ? '> ' : ''
    const heading = /^h([1-6])\.\s+(.*)$/.exec(line)
    const item = /^\s*([*#-]+)\s+(.*)$/.exec(line)
    const row = tableRow(line)
    if (heading) output.push(`${prefix}${'#'.repeat(Number(heading[1]))} ${inlineToMarkdown(heading[2] as string)}`)
    else if (/^\s*-{4,}\s*$/.test(line)) output.push(`${prefix}---`)
    else if (line.startsWith('bq. ')) output.push(`> ${inlineToMarkdown(line.slice(4))}`)
    else if (item && (item[1] === '-' || !item[1]?.includes('-'))) {
      const marks = item[1] as string
      output.push(`${prefix}${'  '.repeat(marks.length - 1)}${marks.endsWith('#') ? '1.' : '-'} ${inlineToMarkdown(item[2] as string)}`)
    } else if (row) output.push(...row.map((cells) => prefix + cells))
    else output.push(prefix + inlineToMarkdown(line))
  }
  return output.join('\n')
}

function inlineToJira(line: string): string {
  return outside(
    line,
    /(`+)[^`\n]*?\1/g,
    (span) => `{{${span.replace(/^`+|`+$/g, '')}}}`,
    (text) =>
      text
        // Square brackets start a link in wiki markup, so the ones that are just text are escaped.
        .replace(/(?<!!)\[([^\]\n]*)\](?!\()/g, '\\[$1\\]')
        .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '!$1!')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '[$1|$2]')
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_whole, stars: string, bars: string) => `${HOLD}b${stars ?? bars}${HOLD}b`)
        .replace(/(?<![\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])/g, '_$1_')
        .replace(/~~(.+?)~~/g, '-$1-')
        .replace(new RegExp(`${HOLD}b`, 'g'), '*'),
  )
}

/** What the factory and people in Factorix write is Markdown, so it is turned into wiki markup on the way out. */
export function markdownToJira(markdown: string): string {
  const output: string[] = []
  let fence: string | null = null
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const marker = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line)
    if (fence) {
      if (marker?.[1] === fence) {
        output.push('{code}')
        fence = null
      } else output.push(line)
      continue
    }
    if (marker) {
      fence = marker[1] as string
      output.push(marker[2] ? `{code:${marker[2]}}` : '{code}')
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const item = /^(\s*)(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line)
    if (heading) output.push(`h${heading[1]?.length}. ${inlineToJira(heading[2] as string)}`)
    else if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) output.push('----')
    else if (item) output.push(`${(item[2] ? '*' : '#').repeat(Math.floor((item[1] as string).length / 2) + 1)} ${inlineToJira(item[3] as string)}`)
    else if (/^>\s?/.test(line)) output.push(`bq. ${inlineToJira(line.replace(/^>\s?/, ''))}`)
    else output.push(inlineToJira(line))
  }
  return output.join('\n')
}

/** Attachments are served by the site itself. The connector also checks the host before it sends credentials. */
function isMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && /\/(?:secure\/attachment|rest\/api\/[23]\/attachment\/content)\//.test(parsed.pathname)
  } catch {
    return false
  }
}

export const jiraMarkup: SourceMarkup = {
  isMediaUrl,
  toMarkdown: (text) => jiraToMarkdown(text),
  linkReferences: linearMarkup.linkReferences,
  issueReferences: linearMarkup.issueReferences,
}

const FILTERS: IssueFilterSpec[] = [
  { key: 'title', label: 'Summary', kind: 'text' },
  { key: 'status', label: 'Status', kind: 'multi' },
  { key: 'priority', label: 'Priority', kind: 'multi' },
  { key: 'assignee', label: 'Assignee', kind: 'multi' },
  { key: 'author', label: 'Reporter', kind: 'multi' },
  { key: 'label', label: 'Label', kind: 'multi' },
]

const SORTS: IssueSortSpec[] = [
  { key: 'updated', label: 'Updated', asc: 'Oldest first', desc: 'Newest first' },
  { key: 'created', label: 'Created', asc: 'Oldest first', desc: 'Newest first' },
  { key: 'priority', label: 'Priority', asc: 'Highest first', desc: 'Lowest first' },
  { key: 'status', label: 'Status', asc: 'Not started first', desc: 'Finished first' },
  { key: 'title', label: 'Summary', asc: 'A to Z', desc: 'Z to A' },
  { key: 'identifier', label: 'Key', asc: 'Lowest first', desc: 'Highest first' },
  { key: 'assignee', label: 'Assignee', asc: 'A to Z', desc: 'Z to A' },
  { key: 'author', label: 'Reporter', asc: 'A to Z', desc: 'Z to A' },
]

export const jiraSource: TrackerSource = {
  markup: jiraMarkup,
  issueFilters: FILTERS,
  issueSorts: SORTS,
  priorityLabels: { 0: 'No priority', 1: 'Highest', 2: 'High', 3: 'Medium', 4: 'Low' },
  egressHosts: () => [],
}
