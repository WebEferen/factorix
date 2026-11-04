import { describe, expect, it } from 'vitest'
import { egressGroups, networkSettingsInput, PACKAGE_REGISTRY_HOSTS } from './egress'
import { connectionInput, connectionUpdateInput, projectUpdateInput } from './inputs'

describe('update bodies', () => {
  it('leaves keys the body did not mention undefined instead of applying create defaults', () => {
    expect(projectUpdateInput.parse({ autonomy: 'full_auto' })).toEqual({ autonomy: 'full_auto' })
    expect(connectionUpdateInput.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' })
  })

  it('still validates the keys it receives', () => {
    expect(projectUpdateInput.safeParse({ autonomy: 'yolo' }).success).toBe(false)
    expect(projectUpdateInput.safeParse({ runTimeoutMinutes: 0 }).success).toBe(false)
  })
})

describe('network allowlist', () => {
  const connections = [
    { name: 'GitLab', egressHosts: ['gitlab.com'] },
    { name: 'Linear', egressHosts: [] },
  ]

  it('adds to the defaults, and lists only connections that bring a host', () => {
    expect(egressGroups({ mode: 'extend', hosts: ['a.example'] }, connections)).toEqual([
      { label: 'Package registries', hosts: PACKAGE_REGISTRY_HOSTS },
      { label: 'GitLab', hosts: ['gitlab.com'] },
      { label: 'Your organization', hosts: ['a.example'] },
    ])
  })

  it('replaces registries and connector hosts when the organization defines its own list', () => {
    expect(egressGroups({ mode: 'replace', hosts: ['a.example'] }, connections)).toEqual([{ label: 'Your organization', hosts: ['a.example'] }])
    expect(egressGroups({ mode: 'replace', hosts: [] }, connections)).toEqual([])
  })

  it('normalizes hosts and removes duplicates', () => {
    expect(networkSettingsInput.parse({ mode: 'extend', hosts: [' GitLab.com ', 'gitlab.com', '*.Example.com'] }).hosts).toEqual([
      'gitlab.com',
      '*.example.com',
    ])
  })

  it.each(['*', 'https://gitlab.com', 'gitlab.com/group', 'a b', ''])('rejects %j as a host, in settings and on a project', (host) => {
    expect(networkSettingsInput.safeParse({ mode: 'extend', hosts: [host] }).success).toBe(false)
    expect(projectUpdateInput.safeParse({ networkAllowlist: [host] }).success).toBe(false)
  })

  it('accepts an internal name and an address', () => {
    expect(projectUpdateInput.parse({ networkAllowlist: ['nexus', '10.0.0.5'] }).networkAllowlist).toEqual(['nexus', '10.0.0.5'])
  })
})

describe('connection bot identity', () => {
  const config = (values: Record<string, unknown>) => connectionInput.safeParse({ kind: 'gitlab', name: 'GitLab', config: values })

  it('keeps the other settings and tidies the name', () => {
    expect(config({ host: 'https://git.acme.dev', botName: '  Acme Bot ', botEmail: 'bot@acme.dev' }).data?.config).toEqual({
      host: 'https://git.acme.dev',
      botName: 'Acme Bot',
      botEmail: 'bot@acme.dev',
    })
    expect(config({ host: 'https://git.acme.dev' }).success).toBe(true)
  })

  it.each([['a\nb'], ['-c core.sshCommand=x'], ['a <b@c.d>'], ['']])('rejects %j as a name git would misread', (botName) => {
    expect(config({ botName }).success).toBe(false)
  })

  it('rejects a bad email, also on update', () => {
    expect(config({ botEmail: 'not an email' }).success).toBe(false)
    expect(connectionUpdateInput.safeParse({ config: { botEmail: 'not an email' } }).success).toBe(false)
  })

  it('leaves config untouched when an update does not mention it', () => {
    expect(connectionUpdateInput.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' })
  })
})
