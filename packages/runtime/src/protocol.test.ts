import { describe, expect, it } from 'vitest'
import { decodeEvent, LineSplitter } from './protocol'

describe('LineSplitter', () => {
  it('keeps fragments across chunks', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(splitter.push(':2}\n\n')).toEqual(['{"b":2}'])
    expect(splitter.flush()).toBeNull()
  })

  it('returns the trailing fragment on flush', () => {
    const splitter = new LineSplitter()
    splitter.push('partial')
    expect(splitter.flush()).toBe('partial')
  })
})

describe('decodeEvent', () => {
  it('rejects lines that are not events', () => {
    expect(decodeEvent('not json')).toBeNull()
    expect(decodeEvent('{"type":"message"}')).toBeNull()
    expect(decodeEvent('{"seq":1,"type":"status","state":"running"}')).not.toBeNull()
  })
})
