/** A person's own model plan. Only runs they started use it, in place of the organization's key. */
export const MODEL_PLAN_IDS = ['chatgpt', 'claude'] as const

export type ModelPlanId = (typeof MODEL_PLAN_IDS)[number]

export interface ModelPlanSpec {
  label: string
  dialect: 'anthropic' | 'openai'
  /**
   * `proxy`: Factorix holds the plan's token and the egress proxy swaps the run's token for it, as it does a key.
   * `cli`: the vendor's terms keep the login in its own CLI's store, so the run talks to `hosts` through a plain tunnel.
   */
  via: 'proxy' | 'cli'
  /** Where a `proxy` plan's calls go, at the proxy's route `/<plan id>/`. */
  upstream?: string
  hosts?: string[]
}

export const MODEL_PLANS: Record<ModelPlanId, ModelPlanSpec> = {
  chatgpt: { label: 'ChatGPT', dialect: 'openai', via: 'proxy', upstream: 'https://api.openai.com' },
  // The CLI signs in and renews at platform.claude.com, and calls the model at api.anthropic.com.
  claude: { label: 'Claude', dialect: 'anthropic', via: 'cli', hosts: ['api.anthropic.com', 'platform.claude.com'] },
}

export function isModelPlan(value: string): value is ModelPlanId {
  return (MODEL_PLAN_IDS as readonly string[]).includes(value)
}
