import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  type AgentRuntime,
  decodeCommand,
  encodeLine,
  JOURNAL_FILE,
  type RunEvent,
  type RunnerIO,
  type RunSpec,
  type RuntimeId,
  type RuntimeModelCatalog,
} from '@factorix/runtime'
import { RunnerSession } from './session'

console.log = console.error
console.info = console.error

async function loadRuntime(id: RuntimeId): Promise<AgentRuntime> {
  switch (id) {
    case 'claude':
      return new (await import('./adapters/claude')).ClaudeRuntime()
    case 'codex':
      return new (await import('./adapters/codex')).CodexRuntime()
    case 'scripted':
      return new (await import('./adapters/scripted')).ScriptedRuntime()
  }
}

function writeStdout(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(line, (error) => (error ? reject(error) : resolve()))
  })
}

async function main(): Promise<void> {
  const io: RunnerIO = {
    workspaceDir: process.env.FACTORIX_WORKSPACE ?? '/workspace',
    homeDir: process.env.HOME ?? '/workspace/.home',
    factorixDir: process.env.FACTORIX_DIR ?? '/workspace/.factorix',
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  const holder: { session: RunnerSession | null } = { session: null }
  let started: Promise<void> | null = null
  let writes: Promise<void> = Promise.resolve()

  const start = async (spec: RunSpec) => {
    const journalDir = join(io.factorixDir, 'runs', spec.runId)
    mkdirSync(journalDir, { recursive: true })
    const journal = join(journalDir, JOURNAL_FILE)
    const emit = (event: RunEvent) => {
      const line = encodeLine(event)
      if (event.seq !== 0) appendFileSync(journal, line)
      writes = writes.then(() => writeStdout(line))
    }
    const runtime = await loadRuntime(spec.runtime)
    holder.session = new RunnerSession({
      spec,
      runtime,
      io,
      emit,
      onForceExit: () => {
        void writes.finally(() => process.exit(0))
      },
    })
    await holder.session.run()
    await writes
    process.exit(0)
  }

  for await (const line of lines) {
    if (!line.trim()) continue
    if (!started) {
      started = start(JSON.parse(line) as RunSpec).catch((error) => {
        console.error('runner failed to start', error)
        process.exit(1)
      })
      continue
    }
    const command = decodeCommand(line)
    if (command) holder.session?.handleCommand(command)
  }
  // stdin closing means the worker detached. The run keeps going so a restarted worker can reattach.
  await started
}

async function printModels(): Promise<void> {
  const io = {
    workspaceDir: process.cwd(),
    homeDir: process.env.HOME ?? '/tmp',
    factorixDir: process.cwd(),
  }
  const catalogs: Partial<Record<RuntimeId, RuntimeModelCatalog>> = {}
  await Promise.all(
    (['claude', 'codex'] as const).map(async (id) => {
      try {
        catalogs[id] = await (await loadRuntime(id)).listModels(io)
      } catch (error) {
        console.error(`could not list ${id} models`, error)
      }
    }),
  )
  await writeStdout(`${JSON.stringify(catalogs)}\n`)
  process.exit(0)
}

void (process.argv.includes('--models') ? printModels() : main())
