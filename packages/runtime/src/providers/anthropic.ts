import type { ModelProviderSpec } from './types'

export const anthropic: ModelProviderSpec = {
  label: 'Anthropic',
  dialect: 'anthropic',
  upstream: 'https://api.anthropic.com',
  auth: 'x-api-key',
  headers: { 'anthropic-version': '2023-06-01' },
  models: { path: '/v1/models?limit=100', ids: /^claude-[a-z]+-\d+(?:-\d{1,2})?$/ },
  installationKey: 'ANTHROPIC_API_KEY',
  keyPlaceholder: 'sk-ant-...',
}
