import { type MarkupContext, mapInline, mapProse, type ScmSource, type SourceMarkup, splitHtmlBreaks } from '../source'

const RELATIVE_UPLOAD = /(\]\()(\/uploads\/[^\s)]+)(\))/g

function convert(lines: string[], context: MarkupContext): string[] {
  const base = context.baseUrl?.replace(/\/$/, '')
  return splitHtmlBreaks(lines).map((line) => (base ? line.replace(RELATIVE_UPLOAD, `$1${base}$2$3`) : line))
}

const PROJECT_PATH = '[\\w.-]+(?:\\/[\\w.-]+)*'
const MERGE_REQUEST = new RegExp(`(?<![\\w/&#!.-])(${PROJECT_PATH})?!(\\d+)\\b`, 'g')
const ISSUE = new RegExp(`(?<![\\w/&#!.-])(${PROJECT_PATH})?#(\\d+)\\b`, 'g')
const USER = /(?<![\w/.@-])@([a-zA-Z0-9_][\w.-]*\w|[a-zA-Z0-9_])/g
const RESOURCE_URL = /^(https?:\/\/[^/]+)\/(.+?)\/-\/(merge_requests|issues)\/(\d+)(?:[/?#].*)?$/

function projectUrl(base: URL, path: string | undefined): string {
  const current = base.pathname.replace(/^\/|\/$/g, '')
  if (!path) return `${base.origin}/${current}`
  if (path.includes('/')) return `${base.origin}/${path}`
  return `${base.origin}/${current.split('/').slice(0, -1).concat(path).join('/')}`
}

function linkReferences(markdown: string, context: MarkupContext): string {
  if (!context.baseUrl) return markdown
  const base = new URL(context.baseUrl)
  const current = base.pathname.replace(/^\/|\/$/g, '')
  // A lone word before ! in another source's text is usually a sentence, such as "done!12". Only a full path is certain.
  const certain = (path: string | undefined) => !context.foreign || !path || path.includes('/') || Boolean(context.siblings?.includes(path))
  return mapInline(markdown, {
    text: (text) => {
      let linked = text.replace(MERGE_REQUEST, (whole, path: string | undefined, number: string) => {
        if (!certain(path)) return whole
        const known = path ? undefined : context.mergeRequestUrl?.(number)
        return `[${whole}](${known ?? `${projectUrl(base, path)}/-/merge_requests/${number}`})`
      })
      // A bare #12 elsewhere is just a number, and a name after @ belongs to that source.
      if (context.foreign)
        return linked.replace(ISSUE, (whole, path: string | undefined, number: string) =>
          path?.includes('/') ? `[${whole}](${projectUrl(base, path)}/-/issues/${number})` : whole,
        )
      linked = linked.replace(ISSUE, (whole, path: string | undefined, number: string) => `[${whole}](${projectUrl(base, path)}/-/issues/${number})`)
      return linked.replace(USER, (whole, user: string) => `[${whole}](${base.origin}/${user})`)
    },
    bareUrl: (url) => {
      const match = RESOURCE_URL.exec(url)
      if (!match || match[1] !== base.origin) return url
      const prefix = match[2] === current ? '' : match[2]
      return `[${prefix}${match[3] === 'issues' ? '#' : '!'}${match[4]}](${url})`
    },
  })
}

/** GitLab keeps single newlines inside one paragraph and writes uploads relative to the project, unlike Linear. */
export const gitlabMarkup: SourceMarkup = {
  isMediaUrl: () => false,
  toMarkdown: (text, context = {}) => mapProse(text, (lines) => convert(lines, context)),
  linkReferences,
  issueReferences: () => [],
}

export const gitlabSource: ScmSource = {
  markup: gitlabMarkup,
  egressHosts: (config) => {
    try {
      return [new URL(String(config.host || 'https://gitlab.com')).hostname]
    } catch {
      return []
    }
  },
}
