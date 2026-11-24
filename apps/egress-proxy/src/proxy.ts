import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse, STATUS_CODES } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, connect, isIP, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'

export interface McpGrant {
  url: string
  /** Sent to the server in place of the run token, so the agent never holds them. */
  headers: Record<string, string>
}

/** Where a run's calls to one model provider go, and the key that replaces the run's token there. */
export interface ModelGrant {
  upstream: string
  auth: 'x-api-key' | 'bearer'
  key: string
}

export interface ProxyGrant {
  /** The organization the grant was made for. A runner is only told about grants of its own. */
  orgId?: string
  runId?: string
  /** Where denials are published. Without one they go to the run's own channel. */
  channel?: string
  /** Exact hostnames, `*.suffix` wildcards, or `*` for any public host. */
  allow: string[]
  /** The run's model providers by id, reached at /<id>/. */
  models?: Record<string, ModelGrant>
  /** All a grant from an older worker holds about models, and what an older proxy reads. */
  anthropicKey?: string | null
  openaiKey?: string | null
  /** The run's MCP servers by name, reached at /mcp/<name>. */
  mcp?: Record<string, McpGrant>
}

export interface ProxyStore {
  grant(token: string): Promise<ProxyGrant | null>
  denied(grant: ProxyGrant, denial: { host: string; reason: string }): void
}

export interface ProxyOptions {
  store: ProxyStore
  /** Replaces a model provider's upstream, by its id. For tests. */
  upstreams?: Record<string, string>
  resolve?: (host: string) => Promise<string[]>
  log?: (message: string) => void
  /** Factorix's own services. No grant reaches them, or anything on the networks they share with the proxy. */
  protectedHosts?: string[]
  /** The proxy's own networks, as CIDRs. Defaults to its interfaces. */
  ownNetworks?: () => string[]
}

const FENCE_TTL_MS = 30_000
const MCP_ROUTE = /^\/mcp\/([A-Za-z0-9_-]+)(\/[^?]*)?(\?.*)?$/
/** A model provider's route, `/<provider id>/<path at its upstream>`. */
const MODEL_ROUTE = /^\/([a-z][a-z0-9_]{0,39})\/(.*)$/s

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

const LEGACY_MODELS: Record<string, { field: 'anthropicKey' | 'openaiKey'; upstream: string; auth: ModelGrant['auth'] }> = {
  anthropic: { field: 'anthropicKey', upstream: 'https://api.anthropic.com', auth: 'x-api-key' },
  openai: { field: 'openaiKey', upstream: 'https://api.openai.com', auth: 'bearer' },
}

function modelGrant(grant: ProxyGrant, id: string): ModelGrant | null {
  if (grant.models && Object.hasOwn(grant.models, id)) return grant.models[id] ?? null
  const legacy = Object.hasOwn(LEGACY_MODELS, id) ? LEGACY_MODELS[id] : undefined
  const key = legacy ? grant[legacy.field] : null
  return legacy && key ? { upstream: legacy.upstream, auth: legacy.auth, key } : null
}

export function createEgressProxy(options: ProxyOptions): Server {
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

  /** Where a call on a model route goes, or why it is refused. The key replaces the run's token in `headers`. */
  const modelTarget = async (
    request: IncomingMessage,
    provider: string,
    path: string,
    headers: Record<string, string | string[]>,
  ): Promise<{ target: URL } | { status: number; message: string }> => {
    const token = ((request.headers['x-api-key'] as string | undefined) ?? request.headers.authorization)?.replace(/^Bearer\s+/i, '')
    const grant = token ? await options.store.grant(token) : null
    if (!grant) return { status: 401, message: 'Unknown run token' }
    const model = modelGrant(grant, provider)
    if (!model) return { status: 401, message: 'No API key is configured for this provider' }
    const upstream = options.upstreams?.[provider] ?? model.upstream
    const target = new URL(path, upstream.endsWith('/') ? upstream : `${upstream}/`)
    delete headers.authorization
    delete headers['x-api-key']
    headers.host = target.host
    if (model.auth === 'x-api-key') headers['x-api-key'] = model.key
    else headers.authorization = `Bearer ${model.key}`
    return { target }
  }

  const reverse = async (request: IncomingMessage, response: ServerResponse, provider: string, path: string) => {
    const headers = forwardHeaders(request.headers)
    const resolved = await modelTarget(request, provider, path, headers)
    if ('status' in resolved) return send(response, resolved.status, resolved.message)
    const { target } = resolved
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

  /** An MCP server of the run's agent. The agent sends its run token, and the server gets the connection's headers instead. */
  const mcp = async (request: IncomingMessage, response: ServerResponse, name: string, path: string, query: string) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
    const grant = token ? await options.store.grant(token) : null
    if (!grant) return send(response, 401, 'Unknown run token')
    const server = grant.mcp?.[name]
    if (!server) return send(response, 404, `This run has no MCP server called ${name}`)
    const target = new URL(server.url)
    if (path) target.pathname = `${target.pathname.replace(/\/$/, '')}${path}`
    if (query) target.search = query
    // An admin chose the address, but it still must not be Factorix itself.
    const decision = await authorize({ ...grant, allow: [target.hostname] }, target.hostname)
    if ('denied' in decision) {
      reject(grant, target.hostname, decision.denied)
      return send(response, 403, `Egress to ${target.hostname} is blocked: ${decision.denied}`)
    }
    const headers = forwardHeaders(request.headers)
    delete headers.authorization
    headers.host = target.host
    for (const [header, value] of Object.entries(server.headers)) headers[header.toLowerCase()] = value
    const https = target.protocol === 'https:'
    const connection = {
      host: decision.address,
      port: target.port || (https ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers,
      ...(https && !isIP(target.hostname) ? { servername: target.hostname } : {}),
    }
    const outbound = (https ? httpsRequest : httpRequest)(connection, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, forwardHeaders(upstreamResponse.headers))
      upstreamResponse.pipe(response)
    })
    outbound.on('error', (error) => {
      log(`MCP server ${target.host} failed: ${error.message}`)
      if (!response.headersSent) send(response, 502, 'The MCP server could not be reached')
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
      const route = MCP_ROUTE.exec(url)
      if (route) return mcp(request, response, route[1] ?? '', route[2] ?? '', route[3] ?? '')
      const model = MODEL_ROUTE.exec(url)
      if (model) return reverse(request, response, model[1] ?? '', model[2] ?? '')
      if (/^https?:\/\//i.test(url)) return forward(request, response)
      send(response, 404, 'Not a proxy route')
    }
    handle().catch((error: Error) => {
      log(`request failed: ${error.message}`)
      if (!response.headersSent) send(response, 500, 'The proxy failed')
      else response.destroy()
    })
  })

  // The Codex CLI streams its model calls over a WebSocket on the model route, so the upgrade goes through with the key swapped.
  server.on('upgrade', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => undefined)
    let upgraded = false
    const answer = (status: number, headers: string[], body = '') =>
      client.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n${[...headers, 'Connection: close'].join('\r\n')}\r\n\r\n${body}`)
    const refuse = (status: number, message: string) => {
      const body = JSON.stringify({ error: { type: 'factorix_egress', message } })
      answer(status, ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`], body)
    }
    const url = request.url ?? ''
    const route = MCP_ROUTE.test(url) ? null : MODEL_ROUTE.exec(url)
    if (!route) return refuse(404, 'Only model routes take a WebSocket')
    const run = async () => {
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !['keep-alive', 'proxy-authorization', 'proxy-connection'].includes(name)) headers[name] = value
      }
      const resolved = await modelTarget(request, route[1] ?? '', route[2] ?? '', headers)
      if ('status' in resolved) return refuse(resolved.status, resolved.message)
      const { target } = resolved
      const outbound = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: request.method, headers })
      outbound.on('upgrade', (upstreamResponse: IncomingMessage, upstream: Socket, upstreamHead: Buffer) => {
        upgraded = true
        const lines = [`HTTP/1.1 101 ${upstreamResponse.statusMessage || 'Switching Protocols'}`]
        for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
          lines.push(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`)
        }
        client.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (upstreamHead.length > 0) client.write(upstreamHead)
        if (head.length > 0) upstream.write(head)
        upstream.on('error', () => client.destroy())
        upstream.pipe(client)
        client.pipe(upstream)
        client.on('close', () => upstream.destroy())
        upstream.on('close', () => client.destroy())
      })
      // The upstream turned the upgrade down, so the agent sees its answer, such as a refused key.
      outbound.on('response', (upstreamResponse: IncomingMessage) => {
        const chunks: Buffer[] = []
        upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
        upstreamResponse.on('end', () => {
          const body = Buffer.concat(chunks)
          const type = upstreamResponse.headers['content-type']
          answer(
            upstreamResponse.statusCode ?? 502,
            [...(type ? [`Content-Type: ${type}`] : []), `Content-Length: ${body.length}`],
            body.toString('utf8'),
          )
        })
      })
      outbound.on('error', (error) => {
        log(`upstream ${target.host} failed: ${error.message}`)
        if (upgraded) client.destroy()
        else refuse(502, 'The upstream API could not be reached')
      })
      client.on('close', () => {
        if (!upgraded) outbound.destroy()
      })
      outbound.end()
    }
    run().catch((error: Error) => {
      log(`upgrade failed: ${error.message}`)
      if (upgraded) client.destroy()
      else refuse(500, 'The proxy failed')
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
