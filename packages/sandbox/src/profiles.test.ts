import { describe, expect, it } from 'vitest'
import { agentContainerConfig, catalogContainerConfig, parseStepValues, STEP_PROFILES, stepContainerConfig } from './profiles'
import type { StepOp } from './provider'

const workspace = { key: 'k', volume: 'fx-ws-k', mirrorVolume: 'fx-mirror-k' }
const defaults = { image: 'img', stepNetwork: 'fx-egress', agentNetwork: 'fx-agents' }
const ops = Object.keys(STEP_PROFILES) as StepOp[]

describe('credential boundary', () => {
  it('never pairs a token with write access to the agent workspace', () => {
    for (const op of ops) {
      const profile = STEP_PROFILES[op]
      if (profile.token) expect(profile.workspace, op).not.toBe('rw')
    }
  })

  it('throws when a token is passed to an op that must not hold one', () => {
    for (const op of ops.filter((candidate) => !STEP_PROFILES[candidate].token)) {
      expect(() => stepContainerConfig(workspace, { op, gitToken: 'secret' }, defaults), op).toThrow(/must not receive/)
    }
  })

  it('puts the token only in the env of token-holding ops', () => {
    expect(stepContainerConfig(workspace, { op: 'push', gitToken: 'secret' }, defaults).Env).toContain('GIT_TOKEN=secret')
    expect(stepContainerConfig(workspace, { op: 'checkout' }, defaults).Env?.join()).not.toContain('GIT_TOKEN')
  })

  it('keeps the mirror out of agent containers, and the agents off the step network', () => {
    const config = agentContainerConfig(workspace, { runId: 'r', issueKey: 'k', readOnlyRepo: false }, defaults)
    expect(config.HostConfig?.Mounts?.map((mount) => mount.Source)).toEqual(['fx-ws-k'])
    expect(config.HostConfig?.NetworkMode).toBe('fx-agents')
  })

  it('cuts network access from steps that run agent-controlled git config without a token', () => {
    expect(stepContainerConfig(workspace, { op: 'bundle' }, defaults).HostConfig?.NetworkMode).toBe('none')
    expect(stepContainerConfig(workspace, { op: 'diff' }, defaults).HostConfig?.NetworkMode).toBe('none')
  })
})

describe('clear-cache', () => {
  it('runs with no token, no mirror, and no network', () => {
    expect(STEP_PROFILES['clear-cache']).toEqual({ workspace: 'rw', mirror: 'none', network: 'none', token: false })
    const config = stepContainerConfig(workspace, { op: 'clear-cache' }, defaults)
    expect(config.HostConfig?.NetworkMode).toBe('none')
    expect(config.HostConfig?.Mounts?.map((mount) => mount.Source)).toEqual(['fx-ws-k'])
  })
})

describe('catalogContainerConfig', () => {
  it('has no network, no volumes, and no credentials', () => {
    const config = catalogContainerConfig(defaults)
    expect(config.HostConfig?.NetworkMode).toBe('none')
    expect(config.HostConfig?.Mounts).toBeUndefined()
    expect(config.Env).toEqual(['HOME=/tmp/home'])
    expect(config.HostConfig?.CapDrop).toEqual(['ALL'])
  })
})

describe('agentContainerConfig', () => {
  it('layers a read-only repo over the writable workspace', () => {
    const mounts = agentContainerConfig(workspace, { runId: 'r', issueKey: 'k', readOnlyRepo: true }, defaults).HostConfig?.Mounts
    expect(mounts).toEqual([
      expect.objectContaining({ Target: '/workspace', ReadOnly: false }),
      expect.objectContaining({ Target: '/workspace/repos', ReadOnly: true, VolumeOptions: { Subpath: 'repos' } }),
    ])
  })

  it('applies the hardening defaults and accepts overrides', () => {
    const config = agentContainerConfig(workspace, { runId: 'r', issueKey: 'k', readOnlyRepo: false, limits: { cpus: 4 } }, defaults)
    expect(config.HostConfig).toMatchObject({ NanoCpus: 4e9, PidsLimit: 1024, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] })
  })
})

describe('parseStepValues', () => {
  it('reads FX_ lines and ignores everything else', () => {
    expect(parseStepValues('noise\nFX_HEAD=abc\nFX_CHANGED=1\nFX_lower=x\n')).toEqual({ HEAD: 'abc', CHANGED: '1' })
  })
})
