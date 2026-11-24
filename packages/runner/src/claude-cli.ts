import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The Claude Code binary the Agent SDK ships for this machine, as Anthropic published it. */
export function claudeCliPath(): string {
  const require = createRequire(import.meta.url)
  const names = [`linux-${process.arch}`, `linux-${process.arch}-musl`, `${process.platform}-${process.arch}`]
  for (const name of names) {
    try {
      return join(dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${name}/package.json`)), 'claude')
    } catch {
      // Only the package for this platform is installed.
    }
  }
  throw new Error(`No Claude Code binary is installed for ${process.platform}-${process.arch}`)
}

/** Runs the CLI with `args` on this process's own input and output, for its sign-in commands. */
export function runClaudeCli(args: string[]): void {
  const child = spawn(claudeCliPath(), args, { stdio: 'inherit' })
  child.on('error', (error) => {
    console.error(error.message)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}
