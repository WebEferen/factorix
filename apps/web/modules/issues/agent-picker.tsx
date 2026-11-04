'use client'

import type { AgentDto, IssueDto } from '@factorix/schemas'
import { Bot, Check, UserX } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { mutate } from 'swr'
import { api } from '../lib/api'
import { useAgents } from '../lib/data'
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from '../ui'

export function refreshIssueData() {
  void mutate(
    (key) =>
      typeof key === 'string' &&
      (key.startsWith('/api/issues') || key.startsWith('/api/runs') || key.startsWith('/api/inbox') || key.startsWith('/api/projects')),
  )
}

export function AgentPicker({
  issue,
  trigger,
  label,
}: {
  issue: Pick<IssueDto, 'id' | 'identifier' | 'assignedAgentId' | 'group'>
  trigger: ReactNode
  /** For a trigger that is only an icon. */
  label?: string
}) {
  const { data } = useAgents()
  const assign = async (agent: AgentDto | null) => {
    try {
      await api.post(`/api/issues/${issue.id}/assign`, { agentId: agent?.id ?? null })
      refreshIssueData()
      toast.success(agent ? `${agent.displayName} is on ${issue.identifier}` : `Unassigned ${issue.identifier}`)
    } catch (error) {
      toast.error((error as Error).message)
    }
  }
  const agents = data?.agents.filter((agent) => agent.status === 'active') ?? []
  if (issue.group === 'closed')
    return (
      <Tooltip label="Closed in the tracker. Reopen it there to hand it to an agent.">
        <span className="flex cursor-not-allowed opacity-40 [&>*]:pointer-events-none">{trigger}</span>
      </Tooltip>
    )
  const menuTrigger = <MenuTrigger asChild>{trigger}</MenuTrigger>
  return (
    <Menu>
      {label ? (
        <Tooltip label={label} hoverOnly>
          {menuTrigger}
        </Tooltip>
      ) : (
        menuTrigger
      )}
      <MenuContent className="w-60" onClick={(event) => event.stopPropagation()}>
        <MenuLabel>Assign to an agent</MenuLabel>
        {agents.map((agent) => (
          <MenuItem key={agent.id} onSelect={() => void assign(agent)}>
            <Avatar name={agent.displayName} agent size={18} />
            <span className="min-w-0 flex-1 truncate">{agent.displayName}</span>
            <span className="text-xs text-ink-3">{agent.archetype.name}</span>
            {agent.id === issue.assignedAgentId ? <Check className="!text-signal" /> : null}
          </MenuItem>
        ))}
        {agents.length === 0 ? (
          <MenuItem disabled>
            <Bot />
            No active agents
          </MenuItem>
        ) : null}
        {issue.assignedAgentId ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => void assign(null)}>
              <UserX />
              Remove agent
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  )
}
