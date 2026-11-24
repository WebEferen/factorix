/** A model a provider lists for a key, as the runtimes take its id: `claude-fable-5-2`, `gpt-6.2-sol`. */
export interface ProviderModel {
  id: string
  label: string
}

/** What Factorix needs of a provider in `MODEL_PROVIDERS` to call it with an organization's key. */
export interface ModelSource {
  label: string
  upstream: string
  auth: 'x-api-key' | 'bearer'
  headers?: Record<string, string>
  models: { path: string; ids: RegExp }
}

const TIMEOUT_MS = 10_000

function call(source: ModelSource, key: string, path: string, fetchImpl: typeof fetch, body?: unknown): Promise<Response> {
  return fetchImpl(`${source.upstream.replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      ...source.headers,
      ...(source.auth === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** The provider's own reason, which tells a revoked key from one without credit. */
async function refusal(source: ModelSource, response: Response, doing: string): Promise<Error> {
  const text = await response.text().catch(() => '')
  let reason = ''
  try {
    const error = (JSON.parse(text) as { error?: { message?: unknown } | string }).error
    reason = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
  } catch {}
  return new Error(`${source.label} answered ${response.status} ${doing}${reason ? `: ${reason.slice(0, 300)}` : ''}`)
}

/** Asks the provider which models the key can use. The answer is the provider's, so only ids of the shape it declares are kept. */
export async function listProviderModels(source: ModelSource, key: string, fetchImpl: typeof fetch = fetch): Promise<ProviderModel[]> {
  const response = await call(source, key, source.models.path, fetchImpl)
  if (!response.ok) throw await refusal(source, response, 'when asked for its models')
  const body = (await response.json()) as { data?: { id?: unknown; display_name?: unknown }[] }
  return (Array.isArray(body.data) ? body.data : []).flatMap((model) =>
    typeof model?.id === 'string' && source.models.ids.test(model.id)
      ? [{ id: model.id, label: typeof model.display_name === 'string' && model.display_name ? model.display_name.slice(0, 80) : model.id }]
      : [],
  )
}

/** Runs the smallest call its dialect has, so a key that lists models but cannot run them still fails. */
export async function pingProviderModel(
  source: ModelSource,
  key: string,
  request: { path: string; body: Record<string, unknown> },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await call(source, key, request.path, fetchImpl, request.body)
  if (!response.ok) throw await refusal(source, response, `when ${String(request.body.model)} was asked to answer`)
  await response.body?.cancel()
}
