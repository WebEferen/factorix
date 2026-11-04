import { describe, expect, it } from 'vitest'
import { egressHostsOf } from '../index'
import { gitlabMarkup } from './markup'

describe('GitLab markup', () => {
  it('keeps single newlines in one paragraph', () => {
    expect(gitlabMarkup.toMarkdown('one\ntwo')).toBe('one\ntwo')
  })

  it('resolves relative uploads against the project', () => {
    expect(gitlabMarkup.toMarkdown('![shot](/uploads/abc/shot.png)', { baseUrl: 'https://gitlab.com/g/r/' })).toBe(
      '![shot](https://gitlab.com/g/r/uploads/abc/shot.png)',
    )
  })

  describe('references', () => {
    const baseUrl = 'https://gitlab.com/acme/web'
    const mr = (path: string, number: number) => `https://gitlab.com/${path}/-/merge_requests/${number}`

    it('links merge requests', () => {
      expect(gitlabMarkup.linkReferences('split out of !6723, see !7803: chat', { baseUrl })).toBe(
        `split out of [!6723](${mr('acme/web', 6723)}), see [!7803](${mr('acme/web', 7803)}): chat`,
      )
    })

    it('links references to other projects', () => {
      expect(gitlabMarkup.linkReferences('acme/billing!12', { baseUrl })).toBe(`[acme/billing!12](${mr('acme/billing', 12)})`)
      expect(gitlabMarkup.linkReferences('search!12', { baseUrl })).toBe(`[search!12](${mr('acme/search', 12)})`)
    })

    it('links issues and people in its own text', () => {
      expect(gitlabMarkup.linkReferences('#12 by @sam', { baseUrl })).toBe(`[#12](${baseUrl}/-/issues/12) by [@sam](https://gitlab.com/sam)`)
    })

    it('in text from another source, links only what cannot mean anything else', () => {
      const foreign = { baseUrl, foreign: true }
      expect(gitlabMarkup.linkReferences('!12 and #13 and @sam and wow!14', foreign)).toBe(`[!12](${mr('acme/web', 12)}) and #13 and @sam and wow!14`)
      expect(gitlabMarkup.linkReferences('a/b#13', foreign)).toBe('[a/b#13](https://gitlab.com/a/b/-/issues/13)')
    })

    it('in a project with several repositories, a known merge request and a sibling name resolve to the right one', () => {
      const context = {
        baseUrl,
        foreign: true,
        siblings: ['search'],
        mergeRequestUrl: (iid: string) => (iid === '12' ? mr('acme/search', 12) : undefined),
      }
      expect(gitlabMarkup.linkReferences('!12 and !13', context)).toBe(`[!12](${mr('acme/search', 12)}) and [!13](${mr('acme/web', 13)})`)
      expect(gitlabMarkup.linkReferences('search!14', context)).toBe(`[search!14](${mr('acme/search', 14)})`)
    })

    it('names bare links to merge requests and issues', () => {
      const own = mr('acme/web', 7)
      expect(gitlabMarkup.linkReferences(`see ${own}`, { baseUrl })).toBe(`see [!7](${own})`)
      expect(gitlabMarkup.linkReferences(`see ${mr('a/b', 7)}`, { baseUrl })).toBe(`see [a/b!7](${mr('a/b', 7)})`)
      expect(gitlabMarkup.linkReferences('https://evil.example/a/b/-/merge_requests/7', { baseUrl })).toBe(
        'https://evil.example/a/b/-/merge_requests/7',
      )
    })

    it('leaves code, finished links, images, and entities alone', () => {
      for (const text of ['`!12`', '[!12](https://x.example)', '![image](https://x.example/a.png)', '&#123;', '```\n!12\n```']) {
        expect(gitlabMarkup.linkReferences(text, { baseUrl })).toBe(text)
      }
    })
  })

  it('never touches code fences', () => {
    const fenced = '```\n![shot](/uploads/abc/shot.png)\n```'
    expect(gitlabMarkup.toMarkdown(fenced, { baseUrl: 'https://gitlab.com/g/r' })).toBe(fenced)
  })
})

describe('egress hosts', () => {
  it('follows the connection, so a self-hosted GitLab opens its own host and not gitlab.com', () => {
    expect(egressHostsOf('gitlab', {})).toEqual(['gitlab.com'])
    expect(egressHostsOf('gitlab', { host: '' })).toEqual(['gitlab.com'])
    expect(egressHostsOf('gitlab', { host: 'https://git.acme.dev:8443/gitlab' })).toEqual(['git.acme.dev'])
    expect(egressHostsOf('gitlab', { host: 'not a url' })).toEqual([])
  })

  it('opens nothing for a source whose hosts need its credentials, or for other connection kinds', () => {
    expect(egressHostsOf('linear', {})).toEqual([])
    expect(egressHostsOf('slack', { host: 'https://slack.com' })).toEqual([])
    expect(egressHostsOf('mcp_http', { url: 'https://mcp.example' })).toEqual([])
  })
})
