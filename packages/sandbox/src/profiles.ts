import type { ContainerCreateOptions, MountConfig } from 'dockerode'
import type { ResourceLimits, StartAgentOptions, StepOp, StepRequest, Workspace } from './provider'

export type MountAccess = 'rw' | 'ro' | 'none'

export interface StepProfile {
  workspace: MountAccess
  mirror: MountAccess
  network: 'step' | 'agent' | 'none'
  token: boolean
}

/**
 * The credential boundary, as data. A token-holding op must never mount the workspace read-write or
 * run git in it, and no op that touches agent-controlled state with write access may hold a token.
 */
export const STEP_PROFILES: Record<StepOp, StepProfile> = {
  'mirror-fetch': { workspace: 'none', mirror: 'rw', network: 'step', token: true },
  checkout: { workspace: 'rw', mirror: 'ro', network: 'agent', token: false },
  bundle: { workspace: 'rw', mirror: 'none', network: 'none', token: false },
  push: { workspace: 'ro', mirror: 'rw', network: 'step', token: true },
  diff: { workspace: 'ro', mirror: 'none', network: 'none', token: false },
  docs: { workspace: 'ro', mirror: 'none', network: 'none', token: false },
}

export const DEFAULT_LIMITS: ResourceLimits = { memoryBytes: 4 * 1024 ** 3, cpus: 2, pids: 1024 }

export interface ContainerDefaults {
  image: string
  stepNetwork?: string
  agentNetwork?: string
  extraStepMounts?: MountConfig
  extraAgentEnv?: Record<string, string>
}

function toEnv(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`)
}

function volumeMount(source: string, target: string, access: 'rw' | 'ro'): MountConfig[number] {
  return { Type: 'volume', Source: source, Target: target, ReadOnly: access === 'ro' }
}

function hardening(limits: ResourceLimits): NonNullable<ContainerCreateOptions['HostConfig']> {
  return {
    Memory: limits.memoryBytes,
    NanoCpus: limits.cpus * 1e9,
    PidsLimit: limits.pids,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1g' },
  }
}

function networkFor(kind: StepProfile['network'], defaults: ContainerDefaults): string | undefined {
  if (kind === 'none') return 'none'
  return kind === 'step' ? defaults.stepNetwork : defaults.agentNetwork
}

export function stepContainerConfig(workspace: Workspace, request: StepRequest, defaults: ContainerDefaults): ContainerCreateOptions {
  const profile = STEP_PROFILES[request.op]
  if (request.gitToken && !profile.token) throw new Error(`Step ${request.op} must not receive a git token`)

  const env = { ...request.env }
  if (profile.token && request.gitToken) env.GIT_TOKEN = request.gitToken

  const mounts: MountConfig = []
  if (profile.workspace !== 'none') mounts.push(volumeMount(workspace.volume, '/workspace', profile.workspace))
  if (profile.mirror !== 'none') mounts.push(volumeMount(workspace.mirrorVolume, '/mirror', profile.mirror))
  if (profile.token || profile.mirror !== 'none') mounts.push(...(defaults.extraStepMounts ?? []))

  return {
    Image: defaults.image,
    Cmd: ['/opt/factorix/bin/factorix-git', request.op],
    Env: toEnv(env),
    WorkingDir: '/',
    Labels: {
      'factorix.managed': 'true',
      'factorix.kind': 'step',
      'factorix.step': request.op,
      'factorix.workspace': workspace.key,
      ...request.labels,
    },
    HostConfig: { ...hardening(DEFAULT_LIMITS), Mounts: mounts, NetworkMode: networkFor(profile.network, defaults) },
  }
}

/** Lists what the SDKs offer. It needs no credentials, so it gets no network, no volumes, and no token. */
export function catalogContainerConfig(defaults: ContainerDefaults): ContainerCreateOptions {
  return {
    Image: defaults.image,
    Cmd: ['node', '/opt/factorix/runner/index.mjs', '--models'],
    Env: toEnv({ HOME: '/tmp/home' }),
    WorkingDir: '/tmp',
    Labels: { 'factorix.managed': 'true', 'factorix.kind': 'catalog' },
    HostConfig: { ...hardening(DEFAULT_LIMITS), NetworkMode: 'none' },
  }
}

export function agentContainerConfig(workspace: Workspace, options: StartAgentOptions, defaults: ContainerDefaults): ContainerCreateOptions {
  const mounts: MountConfig = [volumeMount(workspace.volume, '/workspace', 'rw')]
  if (options.readOnlyRepo) {
    mounts.push({
      ...volumeMount(workspace.volume, '/workspace/repos', 'ro'),
      VolumeOptions: { Subpath: 'repos' } as unknown as NonNullable<MountConfig[number]['VolumeOptions']>,
    })
  }
  return {
    Image: options.image ?? defaults.image,
    Cmd: ['node', '/opt/factorix/runner/index.mjs'],
    Env: toEnv({ ...defaults.extraAgentEnv, ...options.env }),
    WorkingDir: '/workspace',
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Labels: {
      'factorix.managed': 'true',
      'factorix.kind': 'agent',
      'factorix.run': options.runId,
      'factorix.issue': options.issueKey,
      'factorix.workspace': workspace.key,
    },
    HostConfig: { ...hardening({ ...DEFAULT_LIMITS, ...options.limits }), Mounts: mounts, NetworkMode: networkFor('agent', defaults) },
  }
}

export function parseStepValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const match = /^FX_([A-Z_]+)=(.*)$/.exec(line)
    if (match?.[1]) values[match[1]] = match[2] ?? ''
  }
  return values
}
