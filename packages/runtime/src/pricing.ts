import type { UsageSnapshot } from './events'

export interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

/** First-party list prices. A model that is not listed reports tokens only and no estimated cost. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.025, cacheWritePerMTok: 0.25 },
  'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0.75 },
  'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, cacheWritePerMTok: 5 },
  'gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.1 },
  'gpt-6-sol': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2 },
  'gpt-6-astra': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 10 },
  'gpt-6.1-terra': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.05, cacheWritePerMTok: 1 },
  'gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2 },
  'gpt-6.2-sol': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2 },
  'gpt-6.2-astra': { inputPerMTok: 8, outputPerMTok: 40, cacheReadPerMTok: 0.4, cacheWritePerMTok: 8 },
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

/** Prices each model's share when a run used several, and says nothing when one of them has no known price. */
export function estimateRunCostUsd(
  model: string | undefined,
  usage: UsageSnapshot,
  prices: Record<string, ModelPrice> = MODEL_PRICES,
): number | undefined {
  if (!usage.byModel) return estimateCostUsd(model, usage, prices)
  let total = 0
  for (const [name, spent] of Object.entries(usage.byModel)) {
    const cost = spent.costUsd ?? estimateCostUsd(name, { ...spent, turns: 0 }, prices)
    if (cost === undefined) return undefined
    total += cost
  }
  return total
}
