import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, connect, isIP, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'

export interface ProxyGrant {
  runId?: string
  /** Where denials are published. Without one they go to the run's own channel. */
  channel?: string
  /** Exact hostnames, `*.suffix` wildcards, or `*` for any public host. */
  allow: string[]
  anthropicKey?: string | null
  openaiKey?: string | null
}

export interface ProxyStore {
  grant(token: string): Promise<ProxyGrant | null>
  denied(grant: ProxyGrant, denial: { host: string; reason: string }): void
}

export interface ProxyOptions {
  store: ProxyStore
  anthropicUpstream?: string
  openaiUpstream?: string
  resolve?: (host: string) => Promise<string[]>
  log?: (message: string) => void
  /** Factorix's own services. No grant reaches them, or anything on the networks they share with the proxy. */
  protectedHosts?: string[]
  /** The proxy's own networks, as CIDRs. Defaults to its interfaces. */
  ownNetworks?: () => string[]
}

const FENCE_TTL_MS = 30_000

function interfaceNetworks(): string[] {
  return Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.cidr ?? '').filter(Boolean))
}

/** Link-local holds cloud metadata services, and 0.0.0.0 means this machine, so no allowlist entry may point there. */
export function isUnreachable(address: string): boolean {
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address
  if (isIP(mapped) === 4) {
    const [a = 0, b = 0] = mapped.split('.').map(Number)
    return a === 0 || (a === 169 && b === 254)
  }
  const lower = mapped.toLowerCase()
  return lower === '::' || /^fe[89ab]/.test(lower)
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export function matchHost(host: string, allow: string[]): 'exact' | 'wildcard' | null {
  const name = host.toLowerCase()
  let wildcard = false
  for (const entry of allow) {
    const rule = entry.toLowerCase()
    if (rule === name) return 'exact'
    if (rule === '*') wildcard = true
    else if (rule.startsWith('*.') && name.endsWith(rule.slice(1))) wildcard = true
  }
  return wildcard ? 'wildcard' : null
}

export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address
  if (isIP(mapped) === 4) {
    const [a = 0, b = 0] = mapped.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  const lower = mapped.toLowerCase()
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower) || lower.startsWith('ff')
}

function tokenFrom(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'basic' || !value) return null
  const decoded = Buffer.from(value, 'base64').toString('utf8')
  return decoded.split(':')[0] || null
}

function send(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  response.end(JSON.stringify({ error: { type: 'factorix_egress', message } }))
}

function forwardHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) result[name] = value
  }
  return result
}

export function createEgressProxy(options: ProxyOptions): Server {
  const anthropicUpstream = options.anthropicUpstream ?? 'https://api.anthropic.com'
  const openaiUpstream = options.openaiUpstream ?? 'https://api.openai.com'
  const log = options.log ?? (() => undefined)
  const resolve = options.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address))
  const protectedHosts = new Set((options.protectedHosts ?? []).map((host) => host.toLowerCase()))
  const ownNetworks = options.ownNetworks ?? interfaceNetworks
  let fence: { list: BlockList; at: number } | null = null

  /** The protected services' addresses, and every network the proxy shares with them, looked up again every so often. */
  const fenced = async (): Promise<BlockList> => {
    if (fence && Date.now() - fence.at < FENCE_TTL_MS) return fence.list
    const list = new BlockList()
    const addresses = (await Promise.all([...protectedHosts].map((host) => resolve(host).catch(() => [] as string[])))).flat()
    for (const address of addresses) list.addAddress(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
    for (const cidr of addresses.length > 0 ? ownNetworks() : []) {
      const [network = '', prefix = ''] = cidr.split('/')
      const family = isIP(network) === 6 ? 'ipv6' : 'ipv4'
      try {
        const subnet = new BlockList()
        subnet.addSubnet(network, Number(prefix), family)
        if (addresses.some((address) => subnet.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4'))) list.addSubnet(network, Number(prefix), family)
      } catch {}
    }
    fence = { list, at: Date.now() }
    return list
  }

  /**
   * Resolves once and connects to that exact address, so a name cannot rebind to an internal one after the check.
   * This proxy shares a network with Postgres and Redis, so `*` must never reach a private address.
   */
  const authorize = async (grant: ProxyGrant, host: string): Promise<{ address: string } | { denied: string }> => {
    if (protectedHosts.has(host.toLowerCase())) return { denied: 'is part of Factorix' }
    const match = matchHost(host, grant.allow)
    if (!match) return { denied: 'not on the allowlist' }
    let addresses: string[]
    try {
      addresses = isIP(host) ? [host] : await resolve(host)
    } catch {
      return { denied: 'could not resolve the host' }
    }
    if (addresses.some(isUnreachable)) return { denied: 'resolves to a link-local or unspecified address' }
    const list = await fenced()
    if (addresses.some((address) => list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4'))) return { denied: 'is part of Factorix' }
    const usable = match === 'exact' ? addresses : addresses.filter((address) => !isPrivateAddress(address))
    if (match === 'wildcard' && usable.length !== addresses.length) return { denied: 'resolves to a private address' }
    const address = usable[0]
    if (!address) return { denied: 'could not resolve the host' }
    return { address }
  }

  const reject = (grant: ProxyGrant, host: string, reason: string) => {
    log(`denied ${host} for ${grant.channel ?? `run ${grant.runId}`}: ${reason}`)
    options.store.denied(grant, { host, reason })
  }

  const reverse = async (
    request: IncomingMessage,
    response: ServerResponse,
    upstream: string,
    path: string,
    keyOf: (grant: ProxyGrant) => string | null | undefined,
    apply: (headers: Record<string, string | string[]>, key: string) => void,
    tokenHeader: string | undefined,
  ) => {
    const token = tokenHeader?.replace(/^Bearer\s+/i, '')
    const grant = token ? await options.store.grant(token) : null
    if (!grant) return send(response, 401, 'Unknown run token')
    const key = keyOf(grant)
    if (!key) return send(response, 401, 'No API key is configured for this provider')
    const target = new URL(path, upstream.endsWith('/') ? upstream : `${upstream}/`)
    const headers = forwardHeaders(request.headers)
    delete headers.authorization
    delete headers['x-api-key']
    headers.host = target.host
    apply(headers, key)
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
    const outbound = transport(target, { method: request.method, headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, forwardHeaders(upstreamResponse.headers))
      upstreamResponse.pipe(response)
    })
    outbound.on('error', (error) => {
      log(`upstream ${target.host} failed: ${error.message}`)
      if (!response.headersSent) send(response, 502, 'The upstream API could not be reached')
      else response.destroy()
    })
    request.pipe(outbound)
    response.on('close', () => outbound.destroy())
  }

  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const token = tokenFrom(request.headers['proxy-authorization'])
    const grant = token ? await options.store.grant(token) : null
    if (!grant) {
      response.setHeader('proxy-authenticate', 'Basic realm="factorix"')
      return send(response, 407, 'Proxy authentication required')
    }
    let target: URL
    try {
      target = new URL(request.url ?? '')
    } catch {
      return send(response, 400, 'Expected an absolute URL')
    }
    if (target.protocol !== 'http:') return send(response, 400, 'Only http URLs can be forwarded')
    const decision = await authorize(grant, target.hostname)
    if ('denied' in decision) {
      reject(grant, target.hostname, decision.denied)
      return send(response, 403, `Egress to ${target.hostname} is blocked: ${decision.denied}`)
    }
    const outbound = httpRequest(
      {
        host: decision.address,
        port: target.port || 80,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...forwardHeaders(request.headers), host: target.host },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, forwardHeaders(upstreamResponse.headers))
        upstreamResponse.pipe(response)
      },
    )
    outbound.on('error', () => {
      if (!response.headersSent) send(response, 502, `Could not reach ${target.hostname}`)
      else response.destroy()
    })
    request.pipe(outbound)
    response.on('close', () => outbound.destroy())
  }

  const server = createServer((request, response) => {
    const url = request.url ?? ''
    const handle = async () => {
      if (url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' })
        return void response.end('{"ok":true}')
      }
      if (url.startsWith('/anthropic/')) {
        const header = (request.headers['x-api-key'] as string | undefined) ?? request.headers.authorization
        return reverse(
          request,
          response,
          anthropicUpstream,
          url.slice('/anthropic/'.length),
          (grant) => grant.anthropicKey,
          (headers, key) => {
            headers['x-api-key'] = key
          },
          header,
        )
      }
      if (url.startsWith('/openai/')) {
        return reverse(
          request,
          response,
          openaiUpstream,
          url.slice('/openai/'.length),
          (grant) => grant.openaiKey,
          (headers, key) => {
            headers.authorization = `Bearer ${key}`
          },
          request.headers.authorization,
        )
      }
      if (/^https?:\/\//i.test(url)) return forward(request, response)
      send(response, 404, 'Not a proxy route')
    }
    handle().catch((error: Error) => {
      log(`request failed: ${error.message}`)
      if (!response.headersSent) send(response, 500, 'The proxy failed')
      else response.destroy()
    })
  })

  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    const refuse = (status: string) => {
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nProxy-Authenticate: Basic realm="factorix"\r\n\r\n`)
    }
    client.on('error', () => undefined)
    const run = async () => {
      const token = tokenFrom(request.headers['proxy-authorization'])
      const grant = token ? await options.store.grant(token) : null
      if (!grant) return refuse('407 Proxy Authentication Required')
      const separator = (request.url ?? '').lastIndexOf(':')
      const host = (request.url ?? '').slice(0, separator).replace(/^\[|\]$/g, '')
      const port = Number((request.url ?? '').slice(separator + 1))
      if (!host || !port) return refuse('400 Bad Request')
      const decision = await authorize(grant, host)
      if ('denied' in decision) {
        reject(grant, host, decision.denied)
        return refuse('403 Forbidden')
      }
      const upstream: Socket = connect({ host: decision.address, port }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => refuse('502 Bad Gateway'))
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
    }
    run().catch((error: Error) => {
      log(`connect failed: ${error.message}`)
      refuse('500 Internal Server Error')
    })
  })
  return server
}
