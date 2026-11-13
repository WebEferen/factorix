import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Config {
  url?: string
  token?: string
  /** The agent `fx run` uses when none is named. */
  agent?: string
}

type Env = Record<string, string | undefined>

export function configPath(env: Env = process.env): string {
  return env.FACTORIX_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'factorix', 'config.json')
}

/** The environment wins over the file, so a CI job needs no file at all. */
export function readConfig(env: Env = process.env): Config {
  let stored: Config = {}
  try {
    stored = JSON.parse(readFileSync(configPath(env), 'utf8')) as Config
  } catch {
    stored = {}
  }
  return {
    url: (env.FACTORIX_URL ?? stored.url)?.replace(/\/+$/, ''),
    token: env.FACTORIX_TOKEN ?? stored.token,
    agent: env.FACTORIX_AGENT ?? stored.agent,
  }
}

export function writeConfig(config: Config, env: Env = process.env): string {
  const path = configPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return path
}
