export interface MarkupContext {
  /** Rewrites an upload that needs the connection's credentials to a URL the browser can load. */
  media?: (url: string) => string
  /** The web URL of the repository or workspace, for dialects that write relative links. */
  baseUrl?: string
  /** The text was written in another source, where only references that cannot mean anything else count. */
  foreign?: boolean
  /** Merge requests already linked to this text's issue, since a bare number could belong to any of its repositories. */
  mergeRequestUrl?: (iid: string) => string | undefined
  /** Short names of the other repositories in the project, so a reference like billing!12 is certain. */
  siblings?: string[]
  /** Prefixes that really are this source's issues, since UTF-8 and SHA-256 look just like ABC-123. */
  issueKeys?: string[]
  /** Where an issue lives, for references this source can resolve. */
  issueUrl?: (identifier: string) => string | undefined
}

/** Each source writes its own dialect and its own short references, and carries the helpers to read both. */
export interface SourceMarkup {
  /** Turns the dialect into the portable GitHub-flavored Markdown the web renders. */
  toMarkdown(text: string, context?: MarkupContext): string
  isMediaUrl(url: string): boolean
  /** Links this source's references in Markdown from any source, leaving code and existing links alone. */
  linkReferences(markdown: string, context: MarkupContext): string
  /** The issues the text refers to, so a caller can look them up before linking. */
  issueReferences(text: string): string[]
}

export type IssueFilterKey = 'title' | 'status' | 'priority' | 'assignee' | 'author' | 'label'

export interface IssueFilterSpec {
  key: IssueFilterKey
  label: string
  kind: 'text' | 'multi'
}

export type IssueSortKey = 'updated' | 'created' | 'priority' | 'status' | 'title' | 'identifier' | 'assignee' | 'author'

export interface IssueSortSpec {
  key: IssueSortKey
  label: string
  /** What each direction reads as for this field, since ascending means nothing next to a priority. */
  asc: string
  desc: string
}

/** Hosts an agent can use without this connection's credentials. Each one is also somewhere it could send data, so declare only what works without them. */
export type EgressHosts = (config: Record<string, unknown>) => string[]

/** What a tracker contributes to the UI beyond its API: how its text reads and how its issues are filtered and sorted. */
export interface TrackerSource {
  markup: SourceMarkup
  issueFilters: IssueFilterSpec[]
  issueSorts: IssueSortSpec[]
  priorityLabels: Record<number, string>
  egressHosts: EgressHosts
}

export interface ScmSource {
  markup: SourceMarkup
  egressHosts: EgressHosts
}

const FENCE = /^\s*(```|~~~)/

/** Code stays verbatim in every dialect, so transforms only ever see the lines between fences. */
export function mapProse(text: string, transform: (lines: string[]) => string[]): string {
  const output: string[] = []
  let prose: string[] = []
  let fence: string | null = null
  const flush = () => {
    output.push(...transform(prose))
    prose = []
  }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      output.push(line)
      if (marker === fence) fence = null
    } else if (marker) {
      flush()
      output.push(line)
      fence = marker
    } else {
      prose.push(line)
    }
  }
  flush()
  return output.join('\n')
}

const OPAQUE = /(`+)[^`\n]*?\1|!?\[(?:[^\][]|\[[^\]]*\])*\]\([^)\n]*\)|<[^>\n]+>|(https?:\/\/[^\s)>\]]+)/g

export interface InlineTransforms {
  text: (text: string) => string
  bareUrl?: (url: string) => string
}

/** Rewrites running text only. Fences, inline code, finished links, and HTML pass through, and bare URLs get their own hook. */
export function mapInline(markdown: string, transforms: InlineTransforms): string {
  return mapProse(markdown, (lines) =>
    lines.map((line) => {
      let output = ''
      let last = 0
      for (const match of line.matchAll(OPAQUE)) {
        output += transforms.text(line.slice(last, match.index))
        output += match[2] && transforms.bareUrl ? transforms.bareUrl(match[0]) : match[0]
        last = match.index + match[0].length
      }
      return output + transforms.text(line.slice(last))
    }),
  )
}

export function splitHtmlBreaks(lines: string[]): string[] {
  return lines.flatMap((line) => line.split(/<br\s*\/?>/i))
}
