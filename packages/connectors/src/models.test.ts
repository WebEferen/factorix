import { describe, expect, it } from 'vitest'
import { listProviderModels, pingProviderModel } from './models'

const anthropic = {
  label: 'Anthropic',
  upstream: 'https://api.anthropic.com',
  auth: 'x-api-key' as const,
  headers: { 'anthropic-version': '2023-06-01' },
  models: { path: '/v1/models?limit=100', ids: /^claude-[a-z]+-\d+(?:-\d{1,2})?$/ },
}
const openai = {
  label: 'OpenAI',
  upstream: 'https://api.openai.com/',
  auth: 'bearer' as const,
  models: { path: '/v1/models', ids: /^gpt-\d+(?:\.\d+)?(?:-[a-z]+)?$/ },
}

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('listing a provider’s models', () => {
  it('keeps only models an agent can work with', async () => {
    const listed = answer({
      data: [
        { id: 'gpt-6.2-sol' },
        { id: 'gpt-6.2-sol-2026-11-01' },
        { id: 'gpt-image-2' },
        { id: 'text-embedding-4' },
        { id: 'gpt-6-sol-realtime' },
        { id: 7 },
      ],
    })
    expect(await listProviderModels(openai, 'sk-test', listed)).toEqual([{ id: 'gpt-6.2-sol', label: 'gpt-6.2-sol' }])
    const named = answer({
      data: [
        { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2' },
        { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
      ],
    })
    expect(await listProviderModels(anthropic, 'sk-ant', named)).toEqual([{ id: 'claude-fable-5-2', label: 'Claude Fable 5.2' }])
  })

  it('sends the key the way each provider wants it, and says why the provider refused', async () => {
    const seen: [string, Record<string, string>][] = []
    const record = (async (url: string, init: RequestInit) => {
      seen.push([url, init.headers as Record<string, string>])
      return new Response(JSON.stringify({ data: [] }))
    }) as unknown as typeof fetch
    await listProviderModels(anthropic, 'sk-ant', record)
    await listProviderModels(openai, 'sk-oai', record)
    expect(seen).toEqual([
      ['https://api.anthropic.com/v1/models?limit=100', { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant' }],
      ['https://api.openai.com/v1/models', { authorization: 'Bearer sk-oai' }],
    ])
    await expect(listProviderModels(openai, 'bad', answer({ error: { message: 'Incorrect API key provided' } }, 401))).rejects.toThrow(
      'OpenAI answered 401 when asked for its models: Incorrect API key provided',
    )
  })
})

describe('pinging a provider’s model', () => {
  it('posts the dialect’s smallest call and passes on success', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const record = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response('{"id":"msg"}')
    }) as unknown as typeof fetch
    await pingProviderModel(anthropic, 'sk-ant', { path: '/v1/messages', body: { model: 'claude-fable-5-2', max_tokens: 1 } }, record)
    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen[0]?.init.method).toBe('POST')
    expect(seen[0]?.init.headers).toMatchObject({ 'x-api-key': 'sk-ant', 'content-type': 'application/json' })
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ model: 'claude-fable-5-2', max_tokens: 1 })
  })

  it('fails with the provider’s reason when the key cannot run the model', async () => {
    const noCredit = answer({ error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } }, 429)
    await expect(pingProviderModel(openai, 'sk-oai', { path: '/v1/responses', body: { model: 'gpt-6.2-sol' } }, noCredit)).rejects.toThrow(
      'OpenAI answered 429 when gpt-6.2-sol was asked to answer: You exceeded your current quota',
    )
  })
})
