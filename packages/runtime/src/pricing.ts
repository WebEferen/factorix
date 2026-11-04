import type { UsageSnapshot } from './events'

export interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

/** First-party list prices. A model that is not listed reports tokens only and no estimated cost. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.5 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
}

export function estimateCostUsd(
  model: string | undefined,
  usage: UsageSnapshot,
  prices: Record<string, ModelPrice> = MODEL_PRICES,
): number | undefined {
  const price = model ? prices[model] : undefined
  if (!price) return undefined
  const perToken = (tokens: number, perMTok: number) => (tokens * perMTok) / 1_000_000
  return (
    perToken(usage.inputTokens, price.inputPerMTok) +
    perToken(usage.outputTokens, price.outputPerMTok) +
    perToken(usage.cacheReadTokens, price.cacheReadPerMTok) +
    perToken(usage.cacheWriteTokens, price.cacheWritePerMTok)
  )
}
