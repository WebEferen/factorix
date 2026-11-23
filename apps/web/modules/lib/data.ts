'use client'

import type {
  AgentDto,
  ApprovalDto,
  ArchetypeDto,
  BlockCatalog,
  ConnectionDto,
  EnvironmentDto,
  InboxDto,
  IssueDetailDto,
  IssueFilterDto,
  IssueListDto,
  IssueSortDto,
  MeDto,
  NetworkSettings,
  NotificationChannelDto,
  NotificationPersonDto,
  PlatformSettingDto,
  PluginDto,
  PreviewDto,
  ProjectDto,
  RunDto,
  RuntimeDto,
  SecretSourceOptionDto,
  SkillDto,
  WorkflowDto,
  WorkflowRunDetailDto,
  WorkflowRunDto,
} from '@factorix/schemas'
import useSWR, { type SWRConfiguration } from 'swr'
import { fetcher } from './api'

function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(path, fetcher as never, config)
}

export function useMe() {
  return useApi<MeDto>('/api/auth/me', { revalidateOnFocus: false, shouldRetryOnError: false })
}

/** The blocks the organization's plugins add to workflows. */
export function useWorkflowBlocks() {
  return useApi<{ blocks: BlockCatalog }>('/api/workflows/blocks', { revalidateOnFocus: false })
}

/** A plugin's choices for one field of its block. Null while the block is not a plugin's or the field is not dynamic. */
export function usePluginFieldOptions(type: string | null, field: string | null) {
  return useApi<{ options: { value: string; label: string }[] }>(
    type && field ? `/api/workflows/blocks/options?${new URLSearchParams({ type, field })}` : null,
    { revalidateOnFocus: false },
  )
}

export function usePlugins() {
  return useApi<{ plugins: PluginDto[] }>('/api/plugins', { revalidateOnFocus: false })
}

export function useProjects() {
  return useApi<{ projects: ProjectDto[] }>('/api/projects')
}

export function useProject(id: string | null) {
  return useApi<{ project: ProjectDto }>(id ? `/api/projects/${id}` : null)
}

export function useIssues(query: Record<string, string | string[] | undefined> | null = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) for (const item of [value ?? []].flat()) if (item) params.append(key, item)
  const text = params.toString()
  return useApi<IssueListDto>(query ? `/api/issues${text ? `?${text}` : ''}` : null, { keepPreviousData: true })
}

export function useIssueFilterSpecs(projectId: string | undefined, scope: string) {
  const params = new URLSearchParams({ scope })
  if (projectId) params.set('projectId', projectId)
  return useApi<{ filters: IssueFilterDto[]; sorts: IssueSortDto[] }>(`/api/issues/filters?${params}`, { keepPreviousData: true })
}

export function useIssue(id: string) {
  return useApi<{ issue: IssueDetailDto }>(`/api/issues/${id}`)
}

export function useAgents() {
  return useApi<{ agents: AgentDto[] }>('/api/agents')
}

export function useAgent(id: string | null) {
  return useApi<{ agent: AgentDto }>(id ? `/api/agents/${id}` : null)
}

export function useRuntimes() {
  return useApi<{ runtimes: RuntimeDto[] }>('/api/runtimes', { revalidateOnFocus: false })
}

export function useArchetypes() {
  return useApi<{ archetypes: ArchetypeDto[] }>('/api/archetypes')
}

export function useSkills() {
  return useApi<{ skills: SkillDto[] }>('/api/skills')
}

export function useGeneralSettings() {
  return useApi<{ settings: PlatformSettingDto[] }>('/api/settings/general')
}

export function useNetworkSettings() {
  return useApi<{ network: NetworkSettings }>('/api/settings/network')
}

export function useConnections() {
  return useApi<{ connections: ConnectionDto[] }>('/api/connections')
}

export function useRuns(query: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])))
  const text = params.toString()
  return useApi<{ runs: RunDto[] }>(`/api/runs${text ? `?${text}` : ''}`, { keepPreviousData: true })
}

export function useRun(id: string) {
  return useApi<{ run: RunDto }>(`/api/runs/${id}`)
}

export function useInbox() {
  return useApi<InboxDto>('/api/inbox')
}

export function useWorkflows() {
  return useApi<{ workflows: WorkflowDto[] }>('/api/workflows')
}

export function useWorkflow(id: string) {
  return useApi<{ workflow: WorkflowDto }>(`/api/workflows/${id}`)
}

export function useWorkflowRuns(id: string) {
  return useApi<{ runs: WorkflowRunDto[] }>(`/api/workflows/${id}/runs`, {
    refreshInterval: (data) => (data?.runs.some((run) => run.status === 'running') ? 2000 : 0),
  })
}

export function useWorkflowRun(id: string) {
  return useApi<{ run: WorkflowRunDetailDto }>(`/api/workflow-runs/${id}`, {
    refreshInterval: (data) => (data?.run.status === 'running' ? 2000 : 0),
  })
}

export function useIssueWorkflowRuns(issueId: string) {
  return useApi<{ runs: WorkflowRunDto[] }>(`/api/issues/${issueId}/workflow-runs`, {
    refreshInterval: (data) => (data?.runs.some((run) => run.status === 'running') ? 2000 : 0),
  })
}

export function usePreview(issueId: string) {
  return useApi<{ preview: PreviewDto }>(`/api/issues/${issueId}/preview`, {
    refreshInterval: (data) => (data?.preview.state && ['starting', 'refreshing', 'stopping'].includes(data.preview.state) ? 3000 : 0),
  })
}

export function useEnvironment(projectId: string) {
  return useApi<{ environment: EnvironmentDto }>(`/api/projects/${projectId}/environment`, { revalidateOnFocus: false })
}

/** Null lists mean the token reaches one place only, so there is nothing to pick. */
export function useSecretSourceProjects(connectionId: string | null) {
  return useApi<{ projects: SecretSourceOptionDto[] | null }>(connectionId ? `/api/secret-sources/${connectionId}/projects` : null, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useSecretSourceConfigs(connectionId: string | null, project: string | null) {
  return useApi<{ configs: SecretSourceOptionDto[] | null }>(
    connectionId && project ? `/api/secret-sources/${connectionId}/configs?project=${encodeURIComponent(project)}` : null,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )
}

export function useConnectionUses(connectionId: string | null) {
  return useApi<{ uses: string[] }>(connectionId ? `/api/connections/${connectionId}/uses` : null, { revalidateOnFocus: false })
}

export function useNotificationPeople(connectionId: string | null) {
  return useApi<{ people: NotificationPersonDto[] }>(connectionId ? `/api/connections/${connectionId}/people` : null, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useNotificationChannels(connectionId: string | null) {
  return useApi<{ channels: NotificationChannelDto[] }>(connectionId ? `/api/connections/${connectionId}/channels` : null, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export type { ApprovalDto }
