import { describe, expect, it } from 'vitest'
import { branchNameFor, fingerprint, formatScmBody, formatTrackerComment, isFactoryScmBody, isFactoryTrackerComment } from './markers'

describe('factory comment markers', () => {
  it('recognises its own tracker comments and not human ones', () => {
    expect(isFactoryTrackerComment(formatTrackerComment('engineer-1', 'Started', 'abcd1234-rest'))).toBe(true)
    expect(isFactoryTrackerComment('Looks good, ship it')).toBe(false)
    expect(isFactoryTrackerComment('quoting **[Factorix · engineer-1]** in a sentence')).toBe(false)
  })

  it('recognises its own SCM bodies and not human ones', () => {
    expect(isFactoryScmBody(formatScmBody('Summary', 'run-1', 'reviewer-1'))).toBe(true)
    expect(isFactoryScmBody('please fix this')).toBe(false)
  })
})

describe('fingerprint', () => {
  it('is stable across line endings and surrounding whitespace', () => {
    expect(fingerprint('comment', 'a\r\nb\n')).toBe(fingerprint('comment', 'a\nb'))
  })

  it('differs by field', () => {
    expect(fingerprint('state', 'x')).not.toBe(fingerprint('title', 'x'))
  })
})

describe('branchNameFor', () => {
  it.each([
    ['ENG-123', 'Add rate limit!', 'factorix/eng-123-add-rate-limit'],
    ['ABC-9', '***', 'factorix/abc-9'],
    ['ENG-1', `${'a'.repeat(39)} b c`, `factorix/eng-1-${'a'.repeat(39)}`],
  ])('%s %s', (identifier, title, expected) => {
    expect(branchNameFor(identifier, title)).toBe(expected)
  })
})
