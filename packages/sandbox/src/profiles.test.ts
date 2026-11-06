import { describe, expect, it } from 'vitest'
import {
  agentContainerConfig,
  catalogContainerConfig,
  IMAGE_SERVICE_CAPS,
  parseStepValues,
  STEP_PROFILES,
  serviceContainerConfig,
  stepContainerConfig,
} from './profiles'
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

  it('mounts another workspace only read-only, without a token or network, and only for ops that allow it', () => {
    for (const op of ops) {
      const profile = STEP_PROFILES[op]
      if (profile.source === 'none') {
        expect(() => stepContainerConfig(workspace, { op, sourceVolume: 'fx-ws-agent' }, defaults), op).toThrow(/must not mount/)
        continue
      }
      expect(profile, op).toMatchObject({ source: 'ro', token: false, network: 'none' })
    }
  })

  it('cuts network access from steps that run agent-controlled git config without a token', () => {
    expect(stepContainerConfig(workspace, { op: 'bundle' }, defaults).HostConfig?.NetworkMode).toBe('none')
    expect(stepContainerConfig(workspace, { op: 'diff' }, defaults).HostConfig?.NetworkMode).toBe('none')
  })
})

describe('clear-cache', () => {
  it('runs with no token, no mirror, and no network', () => {
    expect(STEP_PROFILES['clear-cache']).toEqual({ workspace: 'rw', mirror: 'none', network: 'none', token: false, source: 'none' })
    const config = stepContainerConfig(workspace, { op: 'clear-cache' }, defaults)
    expect(config.HostConfig?.NetworkMode).toBe('none')
    expect(config.HostConfig?.Mounts?.map((mount) => mount.Source)).toEqual(['fx-ws-k'])
  })
})

describe('export', () => {
  it('copies code into a preview with no token and no network, reading the mirror only', () => {
    expect(STEP_PROFILES.export).toEqual({ workspace: 'rw', mirror: 'ro', network: 'none', token: false, source: 'ro' })
    const config = stepContainerConfig({ ...workspace, volume: 'fx-envsrc-p' }, { op: 'export' }, defaults)
    expect(config.HostConfig?.NetworkMode).toBe('none')
    expect(config.HostConfig?.Mounts).toEqual([
      expect.objectContaining({ Source: 'fx-envsrc-p', Target: '/workspace', ReadOnly: false }),
      expect.objectContaining({ Source: 'fx-mirror-k', Target: '/mirror', ReadOnly: true }),
    ])
  })

  it('reads an agent’s working copy read-only at /source', () => {
    const config = stepContainerConfig({ ...workspace, volume: 'fx-envsrc-p' }, { op: 'export', sourceVolume: 'fx-ws-agent' }, defaults)
    expect(config.HostConfig?.NetworkMode).toBe('none')
    expect(config.Env?.join()).not.toContain('GIT_TOKEN')
    expect(config.HostConfig?.Mounts).toContainEqual(expect.objectContaining({ Source: 'fx-ws-agent', Target: '/source', ReadOnly: true }))
  })
})

describe('serviceContainerConfig', () => {
  const environment = { key: 'p1', network: 'fx-env-p1', sourceVolume: 'fx-envsrc-p1' }

  it('runs repository code as uid 1000 with no capabilities, on the preview network only', () => {
    const config = serviceContainerConfig(
      environment,
      {
        service: 'api',
        repoCode: true,
        script: 'exec yarn dev',
        workdir: '/workspace/repos/app',
        env: { A: '1' },
        mounts: [{ volume: 'fx-envsrc-p1', target: '/workspace', readOnly: false }],
      },
      defaults,
    )
    expect(config).toMatchObject({ name: 'fx-env-p1-api', Image: 'img', User: '1000:1000', Entrypoint: ['/bin/sh', '-c'], Cmd: ['exec yarn dev'] })
    expect(config.HostConfig).toMatchObject({ CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: 'fx-env-p1', Init: true })
    expect(config.HostConfig?.CapAdd).toBeUndefined()
    expect(config.HostConfig?.Privileged).toBeUndefined()
    expect(config.HostConfig?.Binds).toBeUndefined()
    expect(config.HostConfig?.Mounts?.map((mount) => mount.Source)).toEqual(['fx-envsrc-p1'])
    expect(config.NetworkingConfig?.EndpointsConfig).toEqual({ 'fx-env-p1': { Aliases: ['api'] } })
    expect(config.Labels).toMatchObject({ 'factorix.kind': 'env', 'factorix.env': 'p1', 'factorix.service': 'api' })
  })

  it('lets an image keep its user and gives it only the capabilities it needs to start', () => {
    const config = serviceContainerConfig(
      environment,
      {
        service: 'db',
        image: 'postgres:17',
        repoCode: false,
        env: {},
        healthcheck: 'pg_isready',
        mounts: [{ volume: 'fx-envsrc-p1', target: '/docker-entrypoint-initdb.d', readOnly: true, subpath: 'repos/app/db' }],
      },
      defaults,
    )
    expect(config.User).toBeUndefined()
    expect(config.Cmd).toBeUndefined()
    expect(config.HostConfig?.CapAdd).toEqual(IMAGE_SERVICE_CAPS)
    expect(IMAGE_SERVICE_CAPS).not.toContain('SYS_ADMIN')
    expect(config.HostConfig?.Mounts).toEqual([
      expect.objectContaining({ Target: '/docker-entrypoint-initdb.d', ReadOnly: true, VolumeOptions: { Subpath: 'repos/app/db' } }),
    ])
    expect(config.Healthcheck?.Test).toEqual(['CMD-SHELL', 'pg_isready'])
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
