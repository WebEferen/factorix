import type { PermissionPolicy } from '@factorix/runtime'
import { describe, expect, it, vi } from 'vitest'
import { claudeCatalog, createCanUseTool, createRequireApprovalHook, permissionOptionsFor } from './claude'
import { ClaudeNormalizer, classifyError } from './claude-normalize'

const policy: PermissionPolicy = { mode: 'full', allow: [], deny: [], requireApproval: [], networkAccess: true }

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'claude-opus-5-5',
  tools: ['Read', 'Bash'],
  mcp_servers: [{ name: 'db', status: 'connected', source: 'x' }],
}

describe('claudeCatalog', () => {
  const row = (value: string, resolvedModel: string, description: string) => ({
    value,
    resolvedModel,
    displayName: value,
    description,
    supportedEffortLevels: ['low', 'max'] as ('low' | 'max')[],
  })

  it('pins wire ids, drops the default row, and collapses aliases of one model', () => {
    const catalog = claudeCatalog([
      row('default', 'claude-opus-5-5', 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok'),
      row('opus', 'claude-opus-5-5', 'Opus 5.5 · Best for everyday tasks · $4/$20 per Mtok'),
      row('opus-again', 'claude-opus-5-5', 'Another alias · of the same model'),
      row('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5 · Efficient'),
    ])
    expect(catalog.defaultModel).toBe('claude-opus-5-5')
    expect(catalog.models.map((model) => model.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(catalog.models[0]).toEqual({
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'Best for everyday tasks · $4/$20 per Mtok',
      efforts: ['low', 'max'],
    })
  })

  it('keeps the display name when the description names no version', () => {
    const [model] = claudeCatalog([{ value: 'custom', displayName: 'Custom', description: 'A custom model' }]).models
    expect(model).toEqual({ id: 'custom', label: 'Custom', description: 'A custom model', efforts: [] })
  })
})

describe('ClaudeNormalizer', () => {
  it('turns the init message into run.started', () => {
    expect(new ClaudeNormalizer().normalize(init)).toEqual([
      {
        type: 'run.started',
        sessionRef: 's1',
        runtime: 'claude',
        model: 'claude-opus-5-5',
        tools: ['Read', 'Bash'],
        mcpServers: [{ name: 'db', status: 'connected' }],
      },
    ])
  })

  it('streams text deltas under the id of the message being written', () => {
    const normalizer = new ClaudeNormalizer()
    normalizer.normalize({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_1' } } })
    expect(
      normalizer.normalize({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      }),
    ).toEqual([{ type: 'message', role: 'assistant', text: 'Hi', partial: true, messageId: 'msg_1' }])
  })

  it('does not stream subagent deltas into the main conversation', () => {
    expect(
      new ClaudeNormalizer().normalize({
        type: 'stream_event',
        parent_tool_use_id: 'tool',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
      }),
    ).toEqual([])
  })

  it('maps assistant content blocks in order', () => {
    const events = new ClaudeNormalizer().normalize({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'msg_2',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Reading' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    })
    expect(events.map((e) => e.type)).toEqual(['thinking', 'message', 'tool.call'])
    expect(events[2]).toMatchObject({ callId: 'tu_1', category: 'exec', summary: 'Bash ls -la' })
  })

  it('derives file changes only from successful edit tools', () => {
    const normalizer = new ClaudeNormalizer()
    normalizer.normalize({
      type: 'assistant',
      message: {
        id: 'm',
        content: [
          { type: 'tool_use', id: 'ok', name: 'Edit', input: { file_path: '/w/a.ts' } },
          { type: 'tool_use', id: 'bad', name: 'Write', input: { file_path: '/w/b.ts' } },
          { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/w/c.ts' } },
        ],
      },
    })
    const events = normalizer.normalize({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'ok', content: 'done' },
          { type: 'tool_result', tool_use_id: 'bad', content: [{ type: 'text', text: 'denied' }], is_error: true },
          { type: 'tool_result', tool_use_id: 'read', content: 'text' },
        ],
      },
    })
    expect(events.filter((e) => e.type === 'file.change')).toEqual([{ type: 'file.change', path: '/w/a.ts', kind: 'update', callId: 'ok' }])
    expect(events.find((e) => e.type === 'tool.result' && e.callId === 'bad')).toMatchObject({ isError: true, output: 'denied' })
  })

  it('truncates huge tool output', () => {
    const normalizer = new ClaudeNormalizer()
    const [event] = normalizer.normalize({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(100_000) }] },
    })
    expect(event).toMatchObject({ truncated: true })
    expect((event as { output: string }).output.length).toBeLessThan(21_000)
  })

  it('finishes a successful result with usage and structured output', () => {
    const normalizer = new ClaudeNormalizer()
    normalizer.normalize(init)
    const events = normalizer.normalize({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'All done',
      num_turns: 3,
      total_cost_usd: 0.25,
      session_id: 's1',
      structured_output: { verdict: 'approve' },
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {
        a: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
        b: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
      },
    })
    expect(events[0]).toEqual({
      type: 'usage',
      cumulative: true,
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
      costUsd: 0.25,
      turns: 3,
    })
    expect(events[1]).toMatchObject({
      type: 'done',
      outcome: 'completed',
      finalText: 'All done',
      structuredOutput: { verdict: 'approve' },
      sessionRef: 's1',
    })
  })

  it.each([
    ['error_max_turns', 'max_turns'],
    ['error_max_budget_usd', 'budget_exceeded'],
    ['error_during_execution', 'failed'],
    ['error_max_structured_output_retries', 'failed'],
  ])('maps %s to %s', (subtype, outcome) => {
    const events = new ClaudeNormalizer().normalize({
      type: 'result',
      subtype,
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
      errors: ['nope'],
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome })
  })

  it('treats a success subtype flagged is_error as a failure and keeps the auth code', () => {
    const normalizer = new ClaudeNormalizer()
    normalizer.normalize({
      type: 'assistant',
      error: 'authentication_failed',
      message: { id: 'm', content: [{ type: 'text', text: 'Invalid API key' }] },
    })
    const events = normalizer.normalize({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Invalid API key',
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
    })
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'auth', fatal: true })
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'failed' })
  })

  it('falls back to the last assistant text when the result has none', () => {
    const normalizer = new ClaudeNormalizer()
    normalizer.normalize({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'partial work' }] } })
    expect(
      normalizer.normalize({ type: 'result', subtype: 'error_max_turns', num_turns: 1, total_cost_usd: 0, usage: {}, errors: [] }).at(-1),
    ).toMatchObject({ finalText: 'partial work' })
  })

  it('classifies error text', () => {
    expect(classifyError('401 Unauthorized')).toBe('auth')
    expect(classifyError('Rate limit hit')).toBe('rate_limit')
    expect(classifyError('request timed out')).toBe('timeout')
    expect(classifyError('whatever')).toBe('unknown')
  })
})

describe('permissionOptionsFor', () => {
  it('bypasses prompts when nothing needs a person, and says so explicitly', () => {
    expect(permissionOptionsFor(policy)).toEqual({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
    expect(permissionOptionsFor({ ...policy, mode: 'read_only' })).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    })
  })

  it('uses the callback path when a rule requires approval', () => {
    expect(permissionOptionsFor({ ...policy, requireApproval: ['Bash'] })).toEqual({ permissionMode: 'default' })
  })

  it('keeps edit mode strict', () => {
    expect(permissionOptionsFor({ ...policy, mode: 'edit' })).toEqual({ permissionMode: 'acceptEdits' })
  })
})

describe('createCanUseTool', () => {
  const context = { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' }

  it('routes matching calls through approval and passes the rejection reason back', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'reject', message: 'not today' })
    const canUse = createCanUseTool({ ...policy, requireApproval: ['Bash(rm *)'] }, { requestApproval })
    expect(await canUse('Bash', { command: 'rm -rf /' }, context)).toEqual({ behavior: 'deny', message: 'not today' })
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool', tool: 'Bash' }))
  })

  it('allows calls no rule matches without asking', async () => {
    const requestApproval = vi.fn()
    const canUse = createCanUseTool({ ...policy, requireApproval: ['Bash(rm *)'] }, { requestApproval })
    expect(await canUse('Bash', { command: 'ls' }, context)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('turns AskUserQuestion into a question approval', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve', updatedInput: { answers: { q: 'yes' } } })
    const canUse = createCanUseTool(policy, { requestApproval })
    const result = await canUse('AskUserQuestion', { questions: [{ question: 'Proceed?' }] }, context)
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question', summary: 'Proceed?' }))
    expect(result).toEqual({ behavior: 'allow', updatedInput: { answers: { q: 'yes' } } })
  })

  it('denies tools outside an edit-only allow list', async () => {
    const canUse = createCanUseTool({ ...policy, mode: 'edit', allow: ['Bash(yarn test*)'] }, { requestApproval: vi.fn() })
    expect(await canUse('Bash', { command: 'curl evil' }, context)).toMatchObject({ behavior: 'deny' })
    expect(await canUse('Bash', { command: 'yarn test' }, context)).toMatchObject({ behavior: 'allow' })
  })
})

describe('createRequireApprovalHook', () => {
  const base = { session_id: 's', transcript_path: '', cwd: '', tool_use_id: 't', hook_event_name: 'PreToolUse' as const }
  const options = { signal: new AbortController().signal }

  it('asks for matching calls even when an allow rule would have approved them', async () => {
    const hook = createRequireApprovalHook({ ...policy, requireApproval: ['Bash(deploy*)'] })
    const output = await hook({ ...base, tool_name: 'Bash', tool_input: { command: 'deploy prod' } }, 't', options)
    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
  })

  it('lets everything else continue', async () => {
    const hook = createRequireApprovalHook({ ...policy, requireApproval: ['Bash(deploy*)'] })
    expect(await hook({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' } }, 't', options)).toEqual({ continue: true })
  })
})
