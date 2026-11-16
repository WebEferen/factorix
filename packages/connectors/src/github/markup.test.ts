import { describe, expect, it } from 'vitest'
import { egressHostsOf, scmServerOf } from '../index'
import { githubMarkup } from './markup'

describe('GitHub markup', () => {
  it('keeps single newlines as line breaks, and leaves code alone', () => {
    expect(githubMarkup.toMarkdown('one\ntwo\n\nthree')).toBe('one  \ntwo\n\nthree')
    expect(githubMarkup.toMarkdown('```\none\ntwo\n```')).toBe('```\none\ntwo\n```')
  })

  describe('references', () => {
    const baseUrl = 'https://github.com/acme/web'

    it('links pull requests, issues, and people in its own text', () => {
      expect(githubMarkup.linkReferences('#12 by @sam, see acme/billing#7', { baseUrl })).toBe(
        `[#12](${baseUrl}/issues/12) by [@sam](https://github.com/sam), see [acme/billing#7](https://github.com/acme/billing/issues/7)`,
      )
    })

    it('in text from another source, links only what cannot mean anything else', () => {
      const context = { baseUrl, foreign: true, mergeRequestUrl: (iid: string) => (iid === '12' ? `${baseUrl}/pull/12` : undefined) }
      expect(githubMarkup.linkReferences('#12 and #13 and @sam and a/b#14', context)).toBe(
        `[#12](${baseUrl}/pull/12) and #13 and @sam and [a/b#14](https://github.com/a/b/issues/14)`,
      )
    })

    it('names bare links to pull requests and issues', () => {
      expect(githubMarkup.linkReferences(`see ${baseUrl}/pull/7`, { baseUrl })).toBe(`see [#7](${baseUrl}/pull/7)`)
      expect(githubMarkup.linkReferences('https://github.com/a/b/issues/7#issuecomment-1', { baseUrl })).toBe(
        '[a/b#7](https://github.com/a/b/issues/7#issuecomment-1)',
      )
      expect(githubMarkup.linkReferences('https://evil.example/a/b/pull/7', { baseUrl })).toBe('https://evil.example/a/b/pull/7')
    })

    it('leaves code, finished links, images, and entities alone', () => {
      for (const text of ['`#12`', '[#12](https://x.example)', '![image](https://x.example/a.png)', '&#123;', '```\n#12\n```', 'sam@acme.dev']) {
        expect(githubMarkup.linkReferences(text, { baseUrl })).toBe(text)
      }
    })
  })

  it('opens the public GitHub hosts, or only its own host when self-hosted', () => {
    expect(egressHostsOf('github', {})).toContain('codeload.github.com')
    expect(egressHostsOf('github', { host: 'https://git.acme.dev' })).toEqual(['git.acme.dev'])
    expect(egressHostsOf('github', { host: 'not a url' })).toEqual([])
    expect(scmServerOf('github', {})).toBe('https://github.com')
  })
})
