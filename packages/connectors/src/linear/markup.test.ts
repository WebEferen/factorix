import { describe, expect, it } from 'vitest'
import { linearMarkup } from './markup'

const media = (url: string) => `/proxy?url=${encodeURIComponent(url)}`
const upload = 'https://uploads.linear.app/a/b/c'

describe('Linear markup', () => {
  it('keeps single newlines as line breaks', () => {
    expect(linearMarkup.toMarkdown('Loom for more context:\nhttps://www.loom.com/share/abc')).toBe(
      'Loom for more context:  \nhttps://www.loom.com/share/abc',
    )
  })

  it('leaves quotes and mailto links for the Markdown parser', () => {
    const text = '@eligio said:\n\n> 14093421 | [a@b.com](mailto:a@b.com)\n>\n> After adding the leads'
    expect(linearMarkup.toMarkdown(text)).toBe('@eligio said:\n\n> 14093421 | [a@b.com](mailto:a@b.com)  \n>  \n> After adding the leads')
  })

  it('points uploads at the media proxy, keeping names with parentheses', () => {
    expect(linearMarkup.toMarkdown(`![image (132).png](${upload})`, { media })).toBe(`![image (132).png](${media(upload)})`)
    expect(linearMarkup.toMarkdown(`[notes.pdf](${upload})`, { media })).toBe(`[notes.pdf](${media(upload)})`)
    expect(linearMarkup.toMarkdown(`see ${upload} here`, { media })).toBe(`see [file](${media(upload)}) here`)
  })

  it('leaves images on other hosts alone', () => {
    const text = '![x](https://evil.example/pixel.png)'
    expect(linearMarkup.toMarkdown(text, { media })).toBe(text)
  })

  it('drops the empty bullets the editor leaves behind', () => {
    expect(linearMarkup.toMarkdown('- real\n* \n\nnext')).toBe('- real\n\nnext')
  })

  it('does not treat a thematic break as an empty bullet', () => {
    expect(linearMarkup.toMarkdown('a\n\n---\n\nb')).toBe('a\n\n---\n\nb')
  })

  it('never touches code fences', () => {
    const fenced = '```\n![image](https://uploads.linear.app/a)\nline\n+++ not a section\n```'
    expect(linearMarkup.toMarkdown(fenced, { media })).toBe(fenced)
  })

  it('opens collapsible sections as a bold title', () => {
    expect(linearMarkup.toMarkdown('+++ Details\nbody\n+++')).toBe('**Details**\n\nbody')
  })

  it('names bare issue links by identifier', () => {
    const url = 'https://linear.app/acme/issue/ABC-12/some-slug'
    expect(linearMarkup.toMarkdown(`see ${url}`)).toBe(`see [ABC-12](${url})`)
    expect(linearMarkup.toMarkdown(`[custom](${url})`)).toBe(`[custom](${url})`)
  })

  describe('references', () => {
    const context = { issueKeys: ['ABC'], issueUrl: (identifier: string) => `/issues/${identifier}` }

    it('links issues whose prefix is a real team', () => {
      expect(linearMarkup.linkReferences('see ABC-12, and (ABC-13).', context)).toBe('see [ABC-12](/issues/ABC-12), and ([ABC-13](/issues/ABC-13)).')
    })

    it('leaves lookalikes such as UTF-8 and SHA-256 alone', () => {
      expect(linearMarkup.linkReferences('UTF-8 and SHA-256 and ABC-1', context)).toBe('UTF-8 and SHA-256 and [ABC-1](/issues/ABC-1)')
    })

    it('leaves code, finished links, URLs, and branch names alone', () => {
      for (const text of ['`ABC-12`', '[ABC-12](https://x.example)', 'https://x.example/ABC-12', 'factorix/ABC-12-slug', '```\nINS-12\n```']) {
        expect(linearMarkup.linkReferences(text, context)).toBe(text)
      }
    })

    it('finds what to look up, including inside links', () => {
      expect(linearMarkup.issueReferences('ABC-1 ABC-1 https://linear.app/x/issue/ENG-2/slug lowercase-3').sort()).toEqual(['ABC-1', 'ENG-2'])
    })

    it('points a bare Linear link at the mirrored issue when there is one', () => {
      const url = 'https://linear.app/acme/issue/ABC-12/some-slug'
      expect(linearMarkup.toMarkdown(`see ${url}`, context)).toBe('see [ABC-12](/issues/ABC-12)')
    })
  })

  it('accepts only https uploads on Linear hosts as media', () => {
    expect(linearMarkup.isMediaUrl(upload)).toBe(true)
    expect(linearMarkup.isMediaUrl('http://uploads.linear.app/a')).toBe(false)
    expect(linearMarkup.isMediaUrl('https://uploads.linear.app.evil.example/a')).toBe(false)
    expect(linearMarkup.isMediaUrl('not a url')).toBe(false)
  })
})
