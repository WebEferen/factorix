'use client'

import type { OrgStreamMessage } from '@factorix/schemas'
import { type ReactNode, useEffect } from 'react'
import { useSWRConfig } from 'swr'

const PREFIXES: Record<OrgStreamMessage['kind'], string[]> = {
  issue: ['/api/issues', '/api/inbox', '/api/projects', '/api/approvals'],
  run: ['/api/runs', '/api/issues', '/api/agents', '/api/spend', '/api/inbox'],
  approval: ['/api/approvals', '/api/inbox', '/api/issues'],
  project: ['/api/projects', '/api/issues'],
  agent: ['/api/agents', '/api/archetypes'],
  network: ['/api/settings/network'],
}

/** Everything the UI lists stays current from one stream of "this changed" pings, instead of each page polling. */
export function LiveUpdates({ children }: { children: ReactNode }) {
  const { mutate } = useSWRConfig()
  useEffect(() => {
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      const prefixes = [...pending]
      pending.clear()
      // Passing only the filter refetches in place. Adding a data argument would empty the cache and blank every list until the reply.
      void mutate((key) => typeof key === 'string' && prefixes.some((prefix) => key.startsWith(prefix)))
    }
    const source = new EventSource('/api/stream')
    source.onmessage = (message) => {
      let parsed: OrgStreamMessage
      try {
        parsed = JSON.parse(message.data) as OrgStreamMessage
      } catch {
        return
      }
      for (const prefix of PREFIXES[parsed.kind] ?? []) pending.add(prefix)
      timer ??= setTimeout(flush, 300)
    }
    return () => {
      source.close()
      if (timer) clearTimeout(timer)
    }
  }, [mutate])
  return children
}
