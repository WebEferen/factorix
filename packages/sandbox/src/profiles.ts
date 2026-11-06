import type { ContainerCreateOptions, MountConfig } from 'dockerode'
import type { Environment, ResourceLimits, ServiceSpec, StartAgentOptions, StepOp, StepRequest, Workspace } from './provider'

export type MountAccess = 'rw' | 'ro' | 'none'

export interface StepProfile {
  workspace: MountAccess
  mirror: MountAccess
  network: 'step' | 'agent' | 'none'
  token: boolean
  /** Another workspace, such as an agent's, mounted at /source to read from. */
  source: MountAccess
}

/**
 * The credential boundary, as data. A token-holding op must never mount the workspace read-write or
 * run git in it, and no op that touches agent-controlled state with write access may hold a token.
 */
export const STEP_PROFILES: Record<StepOp, StepProfile> = {
  'mirror-fetch': { workspace: 'none', mirror: 'rw', network: 'step', token: true, source: 'none' },
  checkout: { workspace: 'rw', mirror: 'ro', network: 'agent', token: false, source: 'none' },
  bundle: { workspace: 'rw', mirror: 'none', network: 'none', token: false, source: 'none' },
  push: { workspace: 'ro', mirror: 'rw', network: 'step', token: true, source: 'none' },
  diff: { workspace: 'ro', mirror: 'none', network: 'none', token: false, source: 'none' },
  docs: { workspace: 'ro', mirror: 'none', network: 'none', token: false, source: 'none' },
  'clear-cache': { workspace: 'rw', mirror: 'none', network: 'none', token: false, source: 'none' },
  // The workspace here is a preview's source volume, which preview code can write to. The source is the agent's workspace, for a
  // preview of its working copy, and stays read-only so the agent's files and index never change.
  export: { workspace: 'rw', mirror: 'ro', network: 'none', token: false, source: 'ro' },
}

export const DEFAULT_LIMITS: ResourceLimits = { memoryBytes: 4 * 1024 ** 3, cpus: 2, pids: 1024 }

export interface ContainerDefaults {
  image: string
  stepNetwork?: string
  agentNetwork?: string
  extraStepMounts?: MountConfig
  extraAgentEnv?: Record<string, string>
  /** Matches the `factorix.stack` label of the gateway and egress proxy, so stacks sharing a Docker host never join each other's previews. */
  stack?: string
}

/** Every managed object carries its stack, so cleanup in one stack never removes another's. */
export function managedLabels(defaults: ContainerDefaults): Record<string, string> {
  return { 'factorix.managed': 'true', ...(defaults.stack ? { 'factorix.stack': defaults.stack } : {}) }
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
  if (request.sourceVolume && profile.source === 'none') throw new Error(`Step ${request.op} must not mount another workspace`)

  const env = { ...request.env }
  if (profile.token && request.gitToken) env.GIT_TOKEN = request.gitToken

  const mounts: MountConfig = []
  if (profile.workspace !== 'none') mounts.push(volumeMount(workspace.volume, '/workspace', profile.workspace))
  if (profile.mirror !== 'none') mounts.push(volumeMount(workspace.mirrorVolume, '/mirror', profile.mirror))
  if (profile.source !== 'none' && request.sourceVolume) mounts.push(volumeMount(request.sourceVolume, '/source', profile.source))
  if (profile.token || profile.mirror !== 'none') mounts.push(...(defaults.extraStepMounts ?? []))

  return {
    Image: defaults.image,
    Cmd: ['/opt/factorix/bin/factorix-git', request.op],
    Env: toEnv(env),
    WorkingDir: '/',
    Labels: {
      ...managedLabels(defaults),
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
    Labels: { ...managedLabels(defaults), 'factorix.kind': 'catalog' },
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
      ...managedLabels(defaults),
      'factorix.kind': 'agent',
      'factorix.run': options.runId,
      'factorix.issue': options.issueKey,
      'factorix.workspace': workspace.key,
    },
    HostConfig: { ...hardening({ ...DEFAULT_LIMITS, ...options.limits }), Mounts: mounts, NetworkMode: networkFor('agent', defaults) },
  }
}

/** What official database and cache images need to drop to their own user and own their data folder. */
export const IMAGE_SERVICE_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'NET_BIND_SERVICE']

export const environmentNetwork = (key: string) => `fx-env-${key}`
export const environmentSourceVolume = (key: string) => `fx-envsrc-${key}`
export const environmentDataVolume = (key: string, service: string) => `fx-envdata-${key}-${service}`
/** Unique across previews, so the gateway, which joins every preview network, can address each service without ambiguity. */
export const serviceContainerName = (key: string, service: string) => `fx-env-${key}-${service}`

export function serviceContainerConfig(environment: Environment, spec: ServiceSpec, defaults: ContainerDefaults): ContainerCreateOptions {
  const host = hardening({ ...DEFAULT_LIMITS, ...spec.limits })
  if (!spec.repoCode) host.CapAdd = IMAGE_SERVICE_CAPS
  const mounts: MountConfig = spec.mounts.map((mount) => ({
    ...volumeMount(mount.volume, mount.target, mount.readOnly ? 'ro' : 'rw'),
    ...(mount.subpath ? { VolumeOptions: { Subpath: mount.subpath } as unknown as NonNullable<MountConfig[number]['VolumeOptions']> } : {}),
  }))
  return {
    name: serviceContainerName(environment.key, spec.service),
    Image: spec.image ?? defaults.image,
    ...(spec.script ? { Entrypoint: ['/bin/sh', '-c'], Cmd: [spec.script] } : {}),
    ...(spec.repoCode ? { User: '1000:1000' } : {}),
    ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
    Env: toEnv(spec.env),
    Labels: {
      ...managedLabels(defaults),
      'factorix.kind': 'env',
      'factorix.env': environment.key,
      'factorix.service': spec.service,
      ...spec.labels,
    },
    ...(spec.healthcheck
      ? {
          Healthcheck: {
            Test: ['CMD-SHELL', spec.healthcheck],
            Interval: 5e9,
            Timeout: 10e9,
            Retries: 3,
            StartPeriod: 3600e9,
            StartInterval: 1e9,
          },
        }
      : {}),
    HostConfig: { ...host, Init: true, Mounts: mounts, NetworkMode: environment.network },
    NetworkingConfig: { EndpointsConfig: { [environment.network]: { Aliases: [spec.service, ...(spec.aliases ?? [])] } } },
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
