'use client'

import type { RunStreamMessage } from '@factorix/schemas'
import { useEffect, useReducer } from 'react'
import { mutate } from 'swr'

type RunEvent = Extract<RunStreamMessage, { kind: 'event' }>['event']

export type StreamItem =
  | { kind: 'message'; key: string; role: string; text: string; partial: boolean }
  | { kind: 'thinking'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      tool: string
      category: string
      summary: string
      input: unknown
      output?: string
      isError?: boolean
      exitCode?: number
      truncated?: boolean
      done: boolean
    }
  | { kind: 'file'; key: string; path: string; change: string }
  | { kind: 'log'; key: string; level: string; source?: string; message: string }
  | { kind: 'error'; key: string; code: string; message: string }
  | { kind: 'done'; key: string; outcome: string; finalText?: string }
  | { kind: 'approval'; key: string; approvalId: string; summary: string; resolved?: string }

interface State {
  items: StreamItem[]
  usage: Extract<RunEvent, { type: 'usage' }> | null
  sessionRef: string | null
  connected: boolean
}

type Action = { type: 'event'; event: RunEvent } | { type: 'connected'; connected: boolean } | { type: 'reset' }

function upsert(items: StreamItem[], key: string, build: (existing: StreamItem | undefined) => StreamItem): StreamItem[] {
  const index = items.findIndex((item) => item.key === key)
  if (index === -1) return [...items, build(undefined)]
  const next = items.slice()
  next[index] = build(items[index])
  return next
}

function apply(state: State, event: RunEvent): State {
  switch (event.type) {
    case 'run.started':
      return { ...state, sessionRef: event.sessionRef }
    case 'message': {
      const key = `message-${event.messageId ?? event.seq}`
      return {
        ...state,
        items: upsert(state.items, key, () => ({ kind: 'message', key, role: event.role, text: event.text, partial: Boolean(event.partial) })),
      }
    }
    case 'thinking':
      return { ...state, items: [...state.items, { kind: 'thinking', key: `thinking-${event.seq}`, text: event.text }] }
    case 'tool.call': {
      const key = `tool-${event.callId}`
      return {
        ...state,
        items: upsert(
          state.items,
          key,
          (existing) =>
            ({
              ...(existing as object),
              kind: 'tool',
              key,
              tool: event.tool,
              category: event.category,
              summary: event.summary,
              input: event.input,
              done: existing?.kind === 'tool' ? existing.done : false,
            }) as StreamItem,
        ),
      }
    }
    case 'tool.result': {
      const key = `tool-${event.callId}`
      return {
        ...state,
        items: upsert(state.items, key, (existing) => ({
          ...(existing?.kind === 'tool' ? existing : { kind: 'tool' as const, key, tool: 'tool', category: 'exec', summary: '', input: undefined }),
          output: event.output,
          isError: event.isError,
          exitCode: event.exitCode,
          truncated: event.truncated,
          done: true,
        })),
      }
    }
    case 'file.change':
      return { ...state, items: [...state.items, { kind: 'file', key: `file-${event.seq}`, path: event.path, change: event.kind }] }
    case 'approval.requested': {
      const key = `approval-${event.approvalId}`
      return { ...state, items: upsert(state.items, key, () => ({ kind: 'approval', key, approvalId: event.approvalId, summary: event.summary })) }
    }
    case 'approval.resolved': {
      const key = `approval-${event.approvalId}`
      return {
        ...state,
        items: upsert(state.items, key, (existing) => ({
          kind: 'approval',
          key,
          approvalId: event.approvalId,
          summary: existing?.kind === 'approval' ? existing.summary : 'Approval',
          resolved: event.decision,
        })),
      }
    }
    case 'usage':
      return { ...state, usage: event }
    case 'log':
      return {
        ...state,
        items: [...state.items, { kind: 'log', key: `log-${event.seq}`, level: event.level, source: event.source, message: event.message }],
      }
    case 'error':
      return { ...state, items: [...state.items, { kind: 'error', key: `error-${event.seq}`, code: event.code, message: event.message }] }
    case 'done':
      return { ...state, items: [...state.items, { kind: 'done', key: `done-${event.seq}`, outcome: event.outcome, finalText: event.finalText }] }
    default:
      return state
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return { items: [], usage: null, sessionRef: null, connected: false }
    case 'connected':
      return { ...state, connected: action.connected }
    case 'event':
      return apply(state, action.event)
  }
}

/** EventSource resumes from Last-Event-ID by itself, and the reducer treats a replayed row like a new one, so a reconnect loses and repeats nothing. */
export function useRunStream(runId: string): State {
  const [state, dispatch] = useReducer(reducer, { items: [], usage: null, sessionRef: null, connected: false })
  useEffect(() => {
    dispatch({ type: 'reset' })
    const source = new EventSource(`/api/runs/${runId}/events`)
    let lastSeq = 0
    source.onopen = () => dispatch({ type: 'connected', connected: true })
    source.onerror = () => dispatch({ type: 'connected', connected: false })
    source.onmessage = (message) => {
      let parsed: RunStreamMessage
      try {
        parsed = JSON.parse(message.data) as RunStreamMessage
      } catch {
        return
      }
      if (parsed.kind === 'state') {
        void mutate(`/api/runs/${runId}`)
        return
      }
      const { event } = parsed
      if (event.seq > 0) {
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
      }
      dispatch({ type: 'event', event })
      if (event.type === 'done' || event.type === 'run.started' || event.type === 'approval.requested' || event.type === 'approval.resolved')
        void mutate(`/api/runs/${runId}`)
    }
    return () => source.close()
  }, [runId])
  return state
}
