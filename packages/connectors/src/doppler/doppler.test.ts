import { describe, expect, it, vi } from 'vitest'
import { DopplerConnector } from './client'

function connector(handler: (url: URL) => Response) {
  const calls: { url: URL; auth: string | null }[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return handler(url)
  })
  return { doppler: new DopplerConnector({ token: 'dp.st.x', apiUrl: 'https://doppler.test/', fetch: fetchMock as typeof fetch }), calls }
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('DopplerConnector', () => {
  it('downloads one config as plain strings with the token as a bearer', async () => {
    const { doppler, calls } = connector(() => reply({ API_KEY: 'abc', PORT: 3000, EMPTY: '' }))
    expect(await doppler.fetch({ project: 'backend', config: 'dev' })).toEqual({ API_KEY: 'abc', PORT: '3000', EMPTY: '' })
    expect(calls[0]?.url.pathname).toBe('/v3/configs/config/secrets/download')
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ format: 'json', project: 'backend', config: 'dev' })
    expect(calls[0]?.auth).toBe('Bearer dp.st.x')
  })

  it('leaves project and config out for a token scoped to one config', async () => {
    const { doppler, calls } = connector(() => reply({ A: '1' }))
    await doppler.fetch({})
    expect([...(calls[0]?.url.searchParams.keys() ?? [])]).toEqual(['format'])
  })

  it('pages through projects and configs', async () => {
    const projects = Array.from({ length: 150 }, (_, index) => ({ slug: `p${index}`, name: `Project ${index}` }))
    const { doppler } = connector((url) => {
      const page = Number(url.searchParams.get('page'))
      if (url.pathname === '/v3/projects') return reply({ projects: projects.slice((page - 1) * 100, page * 100) })
      return reply({
        configs: [
          { name: 'dev', environment: 'dev' },
          { name: 'prd', environment: 'prd' },
        ],
      })
    })
    const listed = await doppler.listProjects()
    expect(listed).toHaveLength(150)
    expect(listed?.[149]).toEqual({ id: 'p149', name: 'Project 149' })
    expect(await doppler.listConfigs('p1')).toEqual([
      { name: 'dev', environment: 'dev' },
      { name: 'prd', environment: 'prd' },
    ])
  })

  it('reports nothing to pick when the token cannot list', async () => {
    const { doppler } = connector(() => reply({ messages: ['forbidden'] }, 403))
    expect(await doppler.listProjects()).toBeNull()
    expect(await doppler.listConfigs('p')).toBeNull()
  })

  it('explains a rejected token', async () => {
    const { doppler } = connector(() => reply({ messages: ['Invalid Auth token'] }, 401))
    await expect(doppler.fetch({ project: 'a', config: 'b' })).rejects.toThrow('Doppler rejected the token.')
  })

  it('names the token and its workplace', async () => {
    const { doppler } = connector(() => reply({ name: 'previews', type: 'service_token', workplace: { name: 'Acme' } }))
    expect(await doppler.viewer()).toEqual({ name: 'previews in Acme' })
  })
})
