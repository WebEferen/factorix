import { describe, expect, it } from 'vitest'
import { parsePluginBlockAnswer, parsePluginManifest, parsePluginToolAnswer, parsePluginTriggerEvent } from './protocol'

const base = { protocol: 1, name: 'Chat', version: '1.0.0', permissions: ['workflows:blocks'] }
const post = {
  key: 'post',
  title: 'Post',
  description: 'Posts a message.',
  fields: [{ key: 'channel', label: 'Channel', kind: 'select', dynamic: true, options: [] }],
  outputs: [
    { id: 'sent', label: 'Sent' },
    { id: 'muted', label: 'Muted' },
  ],
}

describe('plugin blocks in a manifest', () => {
  it('reads a block and gives it one output when it names none', () => {
    const { blocks } = parsePluginManifest({ ...base, blocks: [post, { key: 'wait', title: 'Wait', description: 'Waits.' }] })
    expect(blocks[0]?.fields[0]).toEqual({ key: 'channel', label: 'Channel', kind: 'select', options: [], dynamic: true })
    expect(blocks[1]).toMatchObject({ outputs: [{ id: 'next', label: 'Next' }], fields: [], provides: [] })
  })

  it('refuses blocks without the permission, a shared key, or an output called failed', () => {
    expect(() => parsePluginManifest({ ...base, permissions: [], blocks: [post] })).toThrow('workflows:blocks')
    expect(() => parsePluginManifest({ ...base, blocks: [post, post] })).toThrow('a key of its own')
    expect(() => parsePluginManifest({ ...base, blocks: [{ ...post, outputs: [{ id: 'failed', label: 'Failed' }] }] })).toThrow('other than failed')
    expect(() => parsePluginManifest({ ...base, blocks: [{ ...post, fields: [{ key: 'x', label: 'X', kind: 'html' }] }] })).toThrow('unknown kind')
  })

  it('keeps dynamic only on a select', () => {
    const { blocks } = parsePluginManifest({
      ...base,
      blocks: [{ ...post, fields: [{ key: 'text', label: 'Text', kind: 'template', dynamic: true }] }],
    })
    expect(blocks[0]?.fields[0]).toEqual({ key: 'text', label: 'Text', kind: 'template' })
  })
})

describe('plugin triggers in a manifest', () => {
  const closed = {
    key: 'closed',
    title: 'Closed',
    description: 'A case closed.',
    fields: [{ key: 'status', label: 'Status', kind: 'select', options: [{ value: 'done', label: 'Done' }] }],
    provides: [{ key: 'title', label: 'Title' }],
  }

  it('reads a trigger, and keeps only the declared keys of an event', () => {
    const [trigger] = parsePluginManifest({ ...base, triggers: [closed] }).triggers
    expect(trigger).toMatchObject({ key: 'closed', provides: [{ key: 'title', label: 'Title' }] })
    expect(parsePluginTriggerEvent(trigger!, { status: 'done', title: 7, secret: 'x' })).toEqual({ status: 'done', title: '7' })
  })

  it('refuses a trigger without the permission, with a block key, or a field it cannot compare', () => {
    expect(() => parsePluginManifest({ ...base, permissions: [], triggers: [closed] })).toThrow('workflows:blocks')
    expect(() => parsePluginManifest({ ...base, blocks: [{ ...post, key: 'closed' }], triggers: [closed] })).toThrow('no block')
    expect(() => parsePluginManifest({ ...base, triggers: [{ ...closed, fields: [{ key: 'note', label: 'Note', kind: 'template' }] }] })).toThrow(
      'text or select',
    )
  })
})

describe('plugin tools in a manifest', () => {
  const tools = { ...base, permissions: ['agents:tools'] }
  const search = {
    key: 'search_docs',
    description: 'Searches the docs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }

  it('reads a tool, and takes an input of no fields when it names none', () => {
    const parsed = parsePluginManifest({ ...tools, tools: [search, { key: 'ping', description: 'Pings.' }] }).tools
    expect(parsed).toEqual([search, { key: 'ping', description: 'Pings.', inputSchema: { type: 'object', properties: {} } }])
    expect(parsePluginManifest(base).tools).toEqual([])
  })

  it('refuses tools without the permission, with a shared key, or with an input that is not an object', () => {
    expect(() => parsePluginManifest({ ...base, tools: [search] })).toThrow('agents:tools')
    expect(() => parsePluginManifest({ ...tools, tools: [search, search] })).toThrow('a key of its own')
    expect(() => parsePluginManifest({ ...tools, tools: [{ ...search, key: 'Search' }] })).toThrow('a key of its own')
    expect(() => parsePluginManifest({ ...tools, tools: [{ ...search, inputSchema: { type: 'string' } }] })).toThrow('of an object')
    expect(() => parsePluginManifest({ ...tools, tools: [{ ...search, description: '' }] })).toThrow('needs a description')
    const huge = { type: 'object', properties: { query: { type: 'string', description: 'x'.repeat(9000) } } }
    expect(() => parsePluginManifest({ ...tools, tools: [{ ...search, inputSchema: huge }] })).toThrow('too large')
  })

  it('turns an answer into the text the agent reads, and cuts a long one', () => {
    expect(parsePluginToolAnswer('found 2')).toBe('found 2')
    expect(parsePluginToolAnswer({ hits: [1] })).toBe('{\n  "hits": [\n    1\n  ]\n}')
    expect(parsePluginToolAnswer(undefined)).toBe('null')
    const long = parsePluginToolAnswer('a'.repeat(200_000))
    expect(long).toHaveLength(100_000 + '\n[The answer was cut at 100000 characters.]'.length)
  })
})

describe('a block answer', () => {
  const block = parsePluginManifest({ ...base, blocks: [post] }).blocks[0]!

  it('leaves through the first output unless it names one the block has', () => {
    expect(parsePluginBlockAnswer(block, {})).toEqual({ handle: 'sent', output: {} })
    expect(parsePluginBlockAnswer(block, { handle: 'muted' })).toEqual({ handle: 'muted', output: {} })
    expect(() => parsePluginBlockAnswer(block, { handle: 'failed' })).toThrow('does not have')
  })

  it('keeps the output as short texts under plain keys, and can hold the step', () => {
    const answer = parsePluginBlockAnswer(block, { wait: true, output: { ts: 15, long: 'x'.repeat(5000), 'bad key': 'y' } })
    expect(answer).toEqual({ wait: true, output: { ts: '15', long: 'x'.repeat(4000) } })
    expect(() => parsePluginBlockAnswer(block, { output: ['a'] })).toThrow('object of texts')
  })
})
