import type { RunSpec } from '@factorix/runtime'
import { describe, expect, it } from 'vitest'
import { buildFirstTurn, buildThreadOptions, codexCatalog, mcpServersToConfig } from './codex'
import { CodexNormalizer, parseStructuredOutput } from './codex-normalize'

describe('codexCatalog', () => {
  const row = (slug: string, priority: number, extra = {}) => ({
    slug,
    display_name: slug.toUpperCase(),
    description: `${slug} model`,
    visibility: 'list',
    supported_in_api: true,
    priority,
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }],
    ...extra,
  })

  it('lists models usable with an API key, in catalog order', () => {
    const { models, defaultModel } = codexCatalog([
      row('b', 2),
      row('hidden', 0, { visibility: 'hide' }),
      row('chatgpt-only', 0, { supported_in_api: false }),
      row('a', 1),
    ])
    expect(defaultModel).toBeNull()
    expect(models.map((model) => model.id)).toEqual(['a', 'b'])
  })

  it('offers only the efforts agents can be set to', () => {
    expect(codexCatalog([row('a', 1)]).models[0]?.efforts).toEqual(['low'])
  })
})

describe('CodexNormalizer', () => {
  it('announces run.started once, from thread.started', () => {
    const normalizer = new CodexNormalizer('gpt-x')
    expect(normalizer.normalize({ type: 'thread.started', thread_id: 't1' })).toEqual([
      { type: 'run.started', sessionRef: 't1', runtime: 'codex', model: 'gpt-x', tools: [], mcpServers: [] },
    ])
    expect(normalizer.normalize({ type: 'turn.started' })).toEqual([])
  })

  it('announces on turn.started when resuming a thread that sends no thread.started', () => {
    expect(new CodexNormalizer(undefined, 't9').normalize({ type: 'turn.started' })[0]).toMatchObject({
      type: 'run.started',
      sessionRef: 't9',
      model: 'default',
    })
  })

  it('pairs a command start with its completion', () => {
    const normalizer = new CodexNormalizer(undefined)
    expect(
      normalizer.normalize({
        type: 'item.started',
        item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' },
      }),
    ).toEqual([{ type: 'tool.call', callId: 'c1', tool: 'Bash', category: 'exec', input: { command: 'ls' }, summary: 'Bash ls' }])
    expect(
      normalizer.normalize({
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a\n', exit_code: 2, status: 'failed' },
      }),
    ).toEqual([{ type: 'tool.result', callId: 'c1', isError: true, exitCode: 2, output: 'a\n' }])
  })

  it('emits the call first when a command only reports completion', () => {
    const events = new CodexNormalizer(undefined).normalize({
      type: 'item.completed',
      item: { id: 'c2', type: 'command_execution', command: 'pwd', aggregated_output: '/', exit_code: 0, status: 'completed' },
    })
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.result'])
  })

  it('expands a patch into one file.change per path, only when it applied', () => {
    const normalizer = new CodexNormalizer(undefined)
    const changes = [
      { path: 'a.ts', kind: 'update' },
      { path: 'b.ts', kind: 'add' },
    ]
    expect(normalizer.normalize({ type: 'item.completed', item: { id: 'p1', type: 'file_change', changes, status: 'completed' } })).toEqual([
      { type: 'file.change', path: 'a.ts', kind: 'update', callId: 'p1' },
      { type: 'file.change', path: 'b.ts', kind: 'add', callId: 'p1' },
    ])
    expect(normalizer.normalize({ type: 'item.completed', item: { id: 'p2', type: 'file_change', changes, status: 'failed' } })).toEqual([])
  })

  it('accumulates usage across turns because Codex reports per turn', () => {
    const normalizer = new CodexNormalizer('gpt-unknown')
    const usage = { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 3 }
    normalizer.normalize({ type: 'turn.completed', usage })
    const [event] = normalizer.normalize({ type: 'turn.completed', usage })
    expect(event).toMatchObject({
      type: 'usage',
      inputTokens: 20,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      outputTokens: 10,
      reasoningTokens: 6,
      turns: 2,
    })
    expect((event as { costUsd?: number }).costUsd).toBeUndefined()
  })

  it('remembers the last agent message as the final text', () => {
    const normalizer = new CodexNormalizer(undefined)
    normalizer.normalize({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'first' } })
    normalizer.normalize({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'second' } })
    expect(normalizer.finalText).toBe('second')
  })

  it('records fatal errors', () => {
    const normalizer = new CodexNormalizer(undefined)
    expect(normalizer.normalize({ type: 'turn.failed', error: { message: 'quota' } })).toEqual([
      { type: 'error', code: 'model', message: 'quota', fatal: true },
    ])
    expect(normalizer.failed).toBe('quota')
  })

  it('keeps non-fatal error items from ending the run', () => {
    const normalizer = new CodexNormalizer(undefined)
    expect(normalizer.normalize({ type: 'item.completed', item: { id: 'e', type: 'error', message: 'minor' } })).toEqual([
      { type: 'error', code: 'tool', message: 'minor', fatal: false },
    ])
    expect(normalizer.failed).toBeNull()
  })
})

describe('Codex option mapping', () => {
  const spec: RunSpec = {
    runId: 'r',
    attempt: 1,
    phase: 'review',
    cwd: '/workspace/repo',
    runtime: 'codex',
    model: { name: 'gpt-x', reasoningEffort: 'high' },
    prompt: { system: 'SYSTEM', user: 'USER' },
    mcpServers: {},
    policy: { mode: 'read_only', allow: [], deny: ['Bash(git push*)'], requireApproval: [], networkAccess: true },
    startSeq: 0,
  }

  it('never lets Codex prompt for approval', () => {
    expect(buildThreadOptions(spec)).toMatchObject({
      approvalPolicy: 'never',
      workingDirectory: '/workspace/repo',
      model: 'gpt-x',
      modelReasoningEffort: 'high',
    })
  })

  it('places system instructions and deny rules before the task', () => {
    const turn = buildFirstTurn(spec)
    expect(turn.indexOf('SYSTEM')).toBeLessThan(turn.indexOf('USER'))
    expect(turn).toContain('Bash(git push*)')
  })

  it('maps both MCP transports', () => {
    expect(
      mcpServersToConfig({ a: { type: 'stdio', command: 'x', args: ['y'] }, b: { type: 'http', url: 'https://m', headers: { h: '1' } } }),
    ).toEqual({
      a: { command: 'x', args: ['y'], env: {} },
      b: { url: 'https://m', http_headers: { h: '1' } },
    })
  })

  it('tolerates non-JSON final text', () => {
    expect(parseStructuredOutput('{"a":1}')).toEqual({ a: 1 })
    expect(parseStructuredOutput('nope')).toBeUndefined()
  })
})
