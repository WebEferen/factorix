import type { ModelProviderSpec } from './types'

export const openai: ModelProviderSpec = {
  label: 'OpenAI',
  dialect: 'openai',
  upstream: 'https://api.openai.com',
  auth: 'bearer',
  models: { path: '/v1/models', ids: /^gpt-\d+(?:\.\d+)?(?:-[a-z]+)?$/ },
  installationKey: 'OPENAI_API_KEY',
  keyPlaceholder: 'sk-...',
}
