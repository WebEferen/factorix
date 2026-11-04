import { describe, expect, it } from 'vitest'
import { EMPTY_USAGE } from './events'
import { estimateCostUsd } from './pricing'

describe('estimateCostUsd', () => {
  it('prices each token class separately', () => {
    const cost = estimateCostUsd(
      'm',
      { ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      { m: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 3, cacheWritePerMTok: 4 } },
    )
    expect(cost).toBe(10)
  })

  it('returns undefined for an unlisted model rather than guessing', () => {
    expect(estimateCostUsd('gpt-unknown', EMPTY_USAGE)).toBeUndefined()
    expect(estimateCostUsd(undefined, EMPTY_USAGE)).toBeUndefined()
  })
})
