import type { PermissionPolicy, RuntimeId } from '@factorix/runtime'

export interface ArchetypePreset {
  name: string
  description: string
  role: 'engineer' | 'reviewer'
  systemPrompt: string
}

export const ARCHETYPE_PRESETS: ArchetypePreset[] = [
  {
    name: 'Engineer',
    description: 'Takes a ticket, implements it on a branch, and opens a merge request.',
    role: 'engineer',
    systemPrompt: `You are a senior software engineer. Read the code before changing it, keep the diff as small as the problem allows, and match the surrounding style.
Prove the change works by running the relevant checks. If you cannot finish, say exactly what is missing instead of guessing.`,
  },
  {
    name: 'Reviewer',
    description: 'Reviews merge requests and posts findings as discussion threads.',
    role: 'reviewer',
    systemPrompt: `You are a principal engineer reviewing a teammate's merge request. Look for correctness, security, concurrency, and data problems first.
Be specific: name the failing scenario, not a general concern. Do not comment on style the linter already covers.`,
  },
  {
    name: 'Tester',
    description: 'Writes and runs the tests a ticket needs, then opens a merge request with them.',
    role: 'engineer',
    systemPrompt: `You are a test engineer. Reproduce the problem or exercise the requested behavior first, then add the tests that would have caught it. Prefer tests of real behavior over tests of internals, and change production code only when a test proves it wrong.
Say what you covered and what you could not.`,
  },
  {
    name: 'Incident manager',
    description: 'Finds what broke, ships the smallest safe fix, and writes up what happened.',
    role: 'engineer',
    systemPrompt: `You are handling a production incident. Establish what is broken, who is affected, and since when before changing anything. Prefer the smallest safe fix or a revert over a refactor.
End with the timeline, the cause, and the follow-ups.`,
  },
]

export interface AgentPreset {
  archetype: string
  handle: string
  displayName: string
  description: string
  policy: PermissionPolicy
  runtime: RuntimeId
  model: string
}

const FULL_POLICY: PermissionPolicy = { mode: 'full', allow: [], deny: [], requireApproval: [], networkAccess: true }

export const AGENT_PRESETS: AgentPreset[] = [
  {
    archetype: 'Engineer',
    handle: 'engineer-1',
    displayName: 'Engineer One',
    description: 'Takes an issue, implements it on a branch, and opens a merge request.',
    policy: FULL_POLICY,
    runtime: 'claude',
    model: 'claude-opus-5-5',
  },
  {
    archetype: 'Reviewer',
    handle: 'reviewer-1',
    displayName: 'Reviewer One',
    description: 'Reviews merge requests and posts findings as discussion threads.',
    policy: { ...FULL_POLICY, mode: 'read_only' },
    runtime: 'claude',
    model: 'claude-opus-5-5',
  },
]

export const DEFAULT_SKILLS: { slug: string; name: string; markdown: string }[] = [
  {
    slug: 'atomic-changes',
    name: 'Atomic changes',
    markdown: `Change only what the issue requires. Do not bundle renames, reformatting, or unrelated cleanups into the same merge request.`,
  },
]
