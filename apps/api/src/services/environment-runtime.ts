import { type Environment, type SandboxProvider, serviceContainerName } from '@factorix/sandbox'
import { noProxyHost } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { previewKeys, proxyTokenKey } from '../lib/channels'
import { randomToken } from '../lib/crypto'

/** How services in an environment reach the egress proxy, which joins their network under this name. */
export const EGRESS_ALIAS = 'factorix-egress'
/** An agent attached to its issue's preview reaches each service as `<name>.preview.internal`, which its NO_PROXY leaves out. */
export const PREVIEW_DOMAIN = 'preview.internal'
const POLL_MS = 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class Aborted extends Error {}

/** A service that will not become ready. The message says why, in words for the person reading the log. */
export class ServiceNotReady extends Error {}

export function noProxyFor(key: string, services: string[], bypass: string[] = []): string {
  return ['localhost', '127.0.0.1', ...services, ...services.map((name) => serviceContainerName(key, name)), ...bypass.map(noProxyHost)].join(',')
}

/**
 * Proxy settings for an environment's containers, with a grant that holds no model key. Denials go to the grant's run or channel.
 * Throws when the proxy cannot join the network, since the services would then have no way out at all.
 */
export async function environmentProxyEnv(
  deps: Pick<AppDeps, 'env' | 'redis'> & { sandbox: SandboxProvider },
  input: {
    environment: Environment
    services: string[]
    bypass: string[]
    grant: { runId?: string; channel?: string }
    allow: string[]
    ttlSeconds: number
  },
): Promise<Record<string, string>> {
  const { env, redis, sandbox } = deps
  const noProxy = noProxyFor(input.environment.key, input.services, input.bypass)
  if (!env.FACTORIX_PROXY_URL) return { NO_PROXY: noProxy, no_proxy: noProxy }
  const token = (await redis.get(previewKeys.grant(input.environment.key))) ?? randomToken(24)
  await redis
    .multi()
    .set(proxyTokenKey(token), JSON.stringify({ ...input.grant, allow: input.allow, anthropicKey: null, openaiKey: null }), 'EX', input.ttlSeconds)
    .set(previewKeys.grant(input.environment.key), token, 'EX', input.ttlSeconds)
    .exec()
  if (!(await sandbox.joinEnvironment(input.environment, 'egress', EGRESS_ALIAS))) {
    throw new Error(
      'The egress proxy is not running, or lacks the factorix.role=egress label, so the services would have no network. Unset FACTORIX_PROXY_URL for local development without it.',
    )
  }
  const proxy = new URL(env.FACTORIX_PROXY_URL)
  const authed = `${proxy.protocol}//${token}:x@${EGRESS_ALIAS}:${proxy.port || '80'}`
  return {
    HTTP_PROXY: authed,
    HTTPS_PROXY: authed,
    http_proxy: authed,
    https_proxy: authed,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: '1',
  }
}

export async function revokeProxyGrant(redis: AppDeps['redis'], key: string): Promise<void> {
  const token = await redis.get(previewKeys.grant(key))
  await redis.del(previewKeys.grant(key), ...(token ? [proxyTokenKey(token)] : []))
}

/** Waits for Docker's health check, or for the container to stay up a couple of seconds when there is none. */
export async function waitUntilReady(
  sandbox: SandboxProvider,
  containerId: string,
  options: { name: string; timeoutSeconds: number; signal?: AbortSignal; everyFewPolls?: () => Promise<void> },
): Promise<void> {
  const { name, timeoutSeconds } = options
  const deadline = Date.now() + timeoutSeconds * 1000
  let runningSince: number | null = null
  for (let poll = 0; ; poll += 1) {
    if (options.signal?.aborted) throw new Aborted()
    const { state, exitCode } = await sandbox.serviceState(containerId)
    if (state === 'healthy') return
    if (state === 'running') {
      runningSince ??= Date.now()
      if (Date.now() - runningSince >= 2000) return
    }
    const failure =
      state === 'exited'
        ? `${name} exited with code ${exitCode} before it was ready. Its log says why.`
        : state === 'unhealthy'
          ? `${name} failed its ready check.`
          : state === 'missing'
            ? `${name} disappeared while it was starting.`
            : Date.now() > deadline
              ? `${name} was not ready within ${timeoutSeconds} seconds. Raise ready.timeoutSeconds if it needs longer.`
              : null
    if (failure) throw new ServiceNotReady(failure)
    if (poll % 5 === 4) await options.everyFewPolls?.()
    await sleep(POLL_MS)
  }
}
