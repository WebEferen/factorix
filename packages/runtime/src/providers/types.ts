/** The API a provider speaks. A runtime runs on any provider that speaks its dialect. */
export interface ModelDialectSpec {
  /** Where the SDKs of this dialect read the address and the key from. In a run they hold the egress proxy's route and the run's token. */
  env: { baseUrl: string; apiKeys: string[] }
  /** Appended to the proxy's route in `baseUrl`, for SDKs that expect the version in the address. */
  basePath: string
  /** The smallest call that proves a key can run a model, and has the credit to. */
  ping(model: string): { path: string; body: Record<string, unknown> }
}

/**
 * A model provider: where its API lives and how a key reaches it. Its id is the kind of the connection that holds an
 * organization's key, and the egress proxy's route `/<id>/`, where a run's token is swapped for that key.
 */
export interface ModelProviderSpec {
  label: string
  dialect: 'anthropic' | 'openai'
  upstream: string
  /** How the key travels to the upstream. */
  auth: 'x-api-key' | 'bearer'
  /** Sent with Factorix's own calls to it, which the SDKs otherwise add. */
  headers?: Record<string, string>
  /** Where it lists the models a key can use, and which of their ids an agent can work with. */
  models: { path: string; ids: RegExp }
  /** The installation's variable that holds a fallback key, for its first organization only. */
  installationKey?: string
  keyPlaceholder?: string
}
