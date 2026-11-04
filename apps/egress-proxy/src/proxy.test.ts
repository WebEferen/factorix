import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createEgressProxy, isPrivateAddress, matchHost, type ProxyGrant } from './proxy'

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

describe('matchHost', () => {
  it.each([
    ['registry.npmjs.org', ['registry.npmjs.org'], 'exact'],
    ['REGISTRY.npmjs.org', ['registry.npmjs.org'], 'exact'],
    ['a.npmjs.org', ['*.npmjs.org'], 'wildcard'],
    ['npmjs.org', ['*.npmjs.org'], null],
    ['evilnpmjs.org', ['*.npmjs.org'], null],
    ['anything.example', ['*'], 'wildcard'],
    ['anything.example', [], null],
    ['gitlab.com', ['registry.npmjs.org'], null],
  ])('%s against %j is %s', (host, allow, expected) => {
    expect(matchHost(host, allow)).toBe(expected)
  })
})

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '224.0.0.1',
  ])('%s is private', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })
  it.each(['8.8.8.8', '172.32.0.1', '160.79.104.10', '2606:4700::1111'])('%s is public', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })
})

describe('egress proxy', () => {
  const grants = new Map<string, ProxyGrant>()
  const denials: { runId: string; host: string; reason: string }[] = []
  const seen: { url: string; headers: Record<string, unknown>; body: string }[] = []
  let upstream: Server
  let upstreamPort: number
  let proxy: Server
  let proxyPort: number

  beforeAll(async () => {
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        seen.push({ url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
        response.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' })
        response.write('data: one\n\n')
        setTimeout(() => response.end('data: two\n\n'), 20)
      })
    })
    upstreamPort = await listen(upstream)
    proxy = createEgressProxy({
      store: {
        grant: async (token) => grants.get(token) ?? null,
        denied: (runId, denial) => denials.push({ runId, ...denial }),
      },
      anthropicUpstream: `http://127.0.0.1:${upstreamPort}`,
      openaiUpstream: `http://127.0.0.1:${upstreamPort}/`,
      resolve: async (host) => (host.endsWith('.internal') ? ['10.0.0.5'] : host.endsWith('.public') ? ['8.8.8.8'] : ['127.0.0.1']),
    })
    proxyPort = await listen(proxy)
  })
  afterAll(() => {
    proxy.close()
    upstream.close()
  })
  beforeEach(() => {
    grants.clear()
    denials.length = 0
    seen.length = 0
    grants.set('tok', { runId: 'run-1', allow: ['allowed.test'], anthropicKey: 'real-anthropic', openaiKey: 'real-openai' })
    grants.set('open', { runId: 'run-2', allow: ['*'] })
  })

  function raw(
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: proxyPort, path, method: body ? 'POST' : 'GET', headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      })
      request.on('error', reject)
      request.end(body)
    })
  }

  const basic = (token: string) => `Basic ${Buffer.from(`${token}:x`).toString('base64')}`

  function tunnel(target: string, token: string | null): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${token ? `Proxy-Authorization: ${basic(token)}\r\n` : ''}\r\n`)
      })
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8')
        if (data.includes('\r\n\r\n')) {
          socket.destroy()
          resolve(data.split('\r\n')[0] as string)
        }
      })
      socket.on('error', reject)
    })
  }

  describe('model routes', () => {
    it('swaps the run token for the real Anthropic key and streams the response', async () => {
      const response = await raw(
        '/anthropic/v1/messages?beta=true',
        { 'x-api-key': 'tok', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        '{"model":"x"}',
      )
      expect(response.status).toBe(200)
      expect(response.body).toBe('data: one\n\ndata: two\n\n')
      expect(seen[0]?.url).toBe('/v1/messages?beta=true')
      expect(seen[0]?.headers['x-api-key']).toBe('real-anthropic')
      expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01')
      expect(seen[0]?.body).toBe('{"model":"x"}')
    })

    it('swaps the run token for the real OpenAI key', async () => {
      const response = await raw('/openai/v1/responses', { authorization: 'Bearer tok' }, '{}')
      expect(response.status).toBe(200)
      expect(seen[0]?.url).toBe('/v1/responses')
      expect(seen[0]?.headers.authorization).toBe('Bearer real-openai')
    })

    it('does not relay a token the proxy does not know', async () => {
      expect((await raw('/anthropic/v1/messages', { 'x-api-key': 'real-looking-but-unknown' }, '{}')).status).toBe(401)
      expect(seen).toHaveLength(0)
    })

    it('explains when the provider has no key', async () => {
      const response = await raw('/anthropic/v1/messages', { 'x-api-key': 'open' }, '{}')
      expect(response.status).toBe(401)
      expect(response.body).toContain('No API key')
      expect(seen).toHaveLength(0)
    })
  })

  describe('forward proxy', () => {
    it('requires proxy credentials', async () => {
      expect((await raw(`http://allowed.test:${upstreamPort}/`, {})).status).toBe(407)
      expect((await raw(`http://allowed.test:${upstreamPort}/`, { 'proxy-authorization': basic('nope') })).status).toBe(407)
      expect(seen).toHaveLength(0)
    })

    it('forwards allowed hosts and never leaks the proxy credential upstream', async () => {
      const response = await raw(`http://allowed.test:${upstreamPort}/path?q=1`, { 'proxy-authorization': basic('tok') })
      expect(response.status).toBe(200)
      expect(seen[0]?.url).toBe('/path?q=1')
      expect(seen[0]?.headers['proxy-authorization']).toBeUndefined()
      expect(seen[0]?.headers.host).toBe(`allowed.test:${upstreamPort}`)
    })

    it('denies other hosts and reports the denial on the run', async () => {
      const response = await raw(`http://evil.example:${upstreamPort}/`, { 'proxy-authorization': basic('tok') })
      expect(response.status).toBe(403)
      expect(seen).toHaveLength(0)
      expect(denials).toEqual([{ runId: 'run-1', host: 'evil.example', reason: 'not on the allowlist' }])
    })
  })

  describe('CONNECT', () => {
    it('tunnels to an allowed host', async () => {
      expect(await tunnel(`allowed.test:${upstreamPort}`, 'tok')).toContain('200')
    })

    it('needs credentials', async () => {
      expect(await tunnel(`allowed.test:${upstreamPort}`, null)).toContain('407')
    })

    it('denies a host that is not listed, and records it', async () => {
      expect(await tunnel('gitlab.com:443', 'tok')).toContain('403')
      expect(denials[0]).toMatchObject({ runId: 'run-1', host: 'gitlab.com' })
    })
  })

  describe('open policy', () => {
    it('reaches public hosts but refuses anything that resolves to a private address', async () => {
      expect(await tunnel(`redis.internal:${upstreamPort}`, 'open')).toContain('403')
      expect(denials[0]?.reason).toContain('private')
      expect(await tunnel('169.254.169.254:80', 'open')).toContain('403')
      expect(await tunnel('127.0.0.1:5432', 'open')).toContain('403')
      expect(await tunnel('[::1]:5432', 'open')).toContain('403')
      expect((await raw('http://10.0.0.1/', { 'proxy-authorization': basic('open') })).status).toBe(403)
    })
  })
})
