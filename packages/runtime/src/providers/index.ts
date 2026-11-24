import { anthropic } from './anthropic'
import { openai } from './openai'
import type { ModelDialectSpec, ModelProviderSpec } from './types'

export type { ModelDialectSpec, ModelProviderSpec } from './types'

export const MODEL_DIALECTS = {
  anthropic: {
    env: { baseUrl: 'ANTHROPIC_BASE_URL', apiKeys: ['ANTHROPIC_API_KEY'] },
    basePath: '',
    ping: (model) => ({ path: '/v1/messages', body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } }),
  },
  openai: {
    // The Codex CLI reads its own variable, other OpenAI SDKs the usual one.
    env: { baseUrl: 'OPENAI_BASE_URL', apiKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
    basePath: '/v1',
    ping: (model) => ({ path: '/v1/responses', body: { model, input: 'ping', max_output_tokens: 16 } }),
  },
} as const satisfies Record<ModelProviderSpec['dialect'], ModelDialectSpec>

export type ModelDialect = keyof typeof MODEL_DIALECTS

/** Every provider Factorix can run models on. A new one is a module beside these, listed here and in `MODEL_PROVIDERS`. */
export const MODEL_PROVIDER_IDS = ['anthropic', 'openai'] as const

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number]

export const MODEL_PROVIDERS: Record<ModelProviderId, ModelProviderSpec> = { anthropic, openai }

export function isModelProvider(kind: string): kind is ModelProviderId {
  return (MODEL_PROVIDER_IDS as readonly string[]).includes(kind)
}

export function providersSpeaking(dialect: ModelDialect): ModelProviderId[] {
  return MODEL_PROVIDER_IDS.filter((id) => MODEL_PROVIDERS[id].dialect === dialect)
}
