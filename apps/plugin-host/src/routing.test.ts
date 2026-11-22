import { describe, expect, it } from 'vitest'
import { routeOf } from './routing'

const names = new Set(['digest', 'board-2'])
const route = (method: string, host: string | undefined, url: string) => routeOf({ method, host, url }, 'plugins.localhost', names)

describe('routeOf', () => {
  it('sends a plugin subdomain to that plugin with the request as it came', () => {
    expect(route('GET', 'digest.plugins.localhost:4110', '/factorix/pages/digest?factorix=t')).toEqual({
      kind: 'plugin',
      name: 'digest',
      path: '/factorix/pages/digest?factorix=t',
    })
    expect(route('POST', 'Board-2.Plugins.Localhost', '/factorix/pages/board')).toMatchObject({ kind: 'plugin', name: 'board-2' })
    expect(route('GET', 'digest.plugins.localhost', '/__plugins')).toMatchObject({ kind: 'plugin', name: 'digest', path: '/__plugins' })
  })

  it('refuses a subdomain that is no plugin', () => {
    expect(route('GET', 'other.plugins.localhost:4110', '/')).toEqual({ kind: 'none' })
    expect(route('GET', 'a.digest.plugins.localhost', '/')).toEqual({ kind: 'none' })
  })

  it('takes signed calls by path on any other host, and only as POST', () => {
    expect(route('POST', 'plugins:4110', '/digest/factorix')).toEqual({ kind: 'plugin', name: 'digest', path: '/factorix' })
    expect(route('POST', 'plugins:4110', '/digest?x=1')).toEqual({ kind: 'plugin', name: 'digest', path: '/?x=1' })
    expect(route('POST', 'plugins.localhost:4110', '/board-2/factorix/pages/board?factorix=t')).toEqual({
      kind: 'plugin',
      name: 'board-2',
      path: '/factorix/pages/board?factorix=t',
    })
    expect(route('GET', 'plugins:4110', '/digest/factorix/pages/digest')).toEqual({ kind: 'none' })
    expect(route('POST', 'plugins:4110', '/unknown/factorix')).toEqual({ kind: 'none' })
    expect(route('POST', undefined, '/')).toEqual({ kind: 'none' })
  })

  it('lists the plugins on the host itself', () => {
    expect(route('GET', 'plugins:4110', '/__plugins')).toEqual({ kind: 'list' })
    expect(route('GET', 'plugins:4110', '/__plugins?x')).toEqual({ kind: 'list' })
    expect(route('POST', 'plugins:4110', '/__plugins')).toEqual({ kind: 'none' })
  })
})
