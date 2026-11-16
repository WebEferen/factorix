import { type MarkupContext, mapInline, mapProse, type ScmSource, type SourceMarkup, splitHtmlBreaks } from '../source'
import { githubEndpoints } from './client'

const REPO_PATH = '[\\w.-]+\\/[\\w.-]+'
const REFERENCE = new RegExp(`(?<![\\w/&#.-])(${REPO_PATH})?#(\\d+)\\b`, 'g')
const USER = /(?<![\w/.@-])@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)/g
const RESOURCE_URL = /^(https?:\/\/[^/]+)\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/

/** GitHub keeps single newlines in a comment as line breaks, unlike CommonMark, so they become explicit hard breaks. */
function withHardBreaks(lines: string[]): string[] {
  return lines.map((line, index) => {
    const next = lines[index + 1]
    return line.trim() && next?.trim() ? `${line.trimEnd()}  ` : line
  })
}

function linkReferences(markdown: string, context: MarkupContext): string {
  if (!context.baseUrl) return markdown
  const base = new URL(context.baseUrl)
  const current = base.pathname.replace(/^\/|\/$/g, '')
  return mapInline(markdown, {
    text: (text) => {
      // Issues and pull requests share one sequence, and GitHub sends an issue link to the pull request when it is one.
      const linked = text.replace(REFERENCE, (whole, path: string | undefined, number: string) => {
        if (path) return `[${whole}](${base.origin}/${path}/issues/${number})`
        const known = context.mergeRequestUrl?.(number)
        // A bare #12 in another source's text is just a number, unless it is a pull request of this very issue.
        if (context.foreign && !known) return whole
        return `[${whole}](${known ?? `${base.origin}/${current}/issues/${number}`})`
      })
      return context.foreign ? linked : linked.replace(USER, (whole, user: string) => `[${whole}](${base.origin}/${user})`)
    },
    bareUrl: (url) => {
      const match = RESOURCE_URL.exec(url)
      if (!match || match[1] !== base.origin) return url
      return `[${match[2] === current ? '' : match[2]}#${match[3]}](${url})`
    },
  })
}

export const githubMarkup: SourceMarkup = {
  isMediaUrl: () => false,
  toMarkdown: (text) => mapProse(text, (lines) => withHardBreaks(splitHtmlBreaks(lines))),
  linkReferences,
  issueReferences: () => [],
}

/* What public packages and installs fetch from GitHub.com. A GitHub Enterprise Server serves all of it from its one host. */
const PUBLIC_HOSTS = ['github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com']

export const githubSource: ScmSource = {
  markup: githubMarkup,
  server: (config) => {
    try {
      return githubEndpoints(config.host as string | undefined).web
    } catch {
      return null
    }
  },
  egressHosts: (config) => {
    try {
      const host = new URL(githubEndpoints(config.host as string | undefined).web).hostname
      return host === 'github.com' ? PUBLIC_HOSTS : [host]
    } catch {
      return []
    }
  },
}
