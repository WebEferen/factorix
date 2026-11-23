import { describe, expect, it } from 'vitest'
import { routeOf } from './routing'

const names = new Set(['digest', 'board-2'])
const route = (method: string, url: string) => routeOf({ method, url }, names)

describe('routeOf', () => {
  it('sends a page under /_plugin/<name> to that plugin, with any method', () => {
    expect(route('GET', '/_plugin/digest/factorix/pages/digest?factorix=t')).toEqual({
      kind: 'plugin',
      name: 'digest',
      path: '/factorix/pages/digest?factorix=t',
      page: true,
    })
    expect(route('POST', '/_plugin/board-2/factorix/pages/board')).toMatchObject({ kind: 'plugin', name: 'board-2', page: true })
    expect(route('GET', '/_plugin/digest')).toMatchObject({ kind: 'plugin', name: 'digest', path: '/', page: true })
  })

  it('refuses a page of a plugin that is not there', () => {
    expect(route('GET', '/_plugin/other/factorix')).toEqual({ kind: 'none' })
    expect(route('GET', '/_plugin/')).toEqual({ kind: 'none' })
    expect(route('GET', '/_plugins/digest/factorix')).toEqual({ kind: 'none' })
  })

  it('takes signed calls by path, and only as POST', () => {
    expect(route('POST', '/digest/factorix')).toEqual({ kind: 'plugin', name: 'digest', path: '/factorix', page: false })
    expect(route('POST', '/digest?x=1')).toEqual({ kind: 'plugin', name: 'digest', path: '/?x=1', page: false })
    expect(route('GET', '/digest/factorix/pages/digest')).toEqual({ kind: 'none' })
    expect(route('POST', '/unknown/factorix')).toEqual({ kind: 'none' })
    expect(route('POST', '/')).toEqual({ kind: 'none' })
  })

  it('lists the plugins on the host itself', () => {
    expect(route('GET', '/__plugins')).toEqual({ kind: 'list' })
    expect(route('GET', '/__plugins?x')).toEqual({ kind: 'list' })
    expect(route('POST', '/__plugins')).toEqual({ kind: 'none' })
  })
})
