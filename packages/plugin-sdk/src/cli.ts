#!/usr/bin/env node
import { relative } from 'node:path'
import { packPlugin } from './pack.js'
import { buildRegistry, generateKey, signPackage } from './registry.js'

const USAGE = `Usage:
  factorix-plugin pack [folder] [--out file.zip]   pack a built plugin, or content, into a zip
  factorix-plugin keygen <file>                     make a signing key, and print its public key
  factorix-plugin sign <file.zip> --key <file>      sign a zip as its publisher, into <file.zip>.sig
  factorix-plugin registry [folder] --key <file>    write a registry's signed index.json from its registry.json and zips

An organization's admin uploads a zip under Integrations, Plugins, or installs it from a registry under Integrations, Market.
The folder's package.json names the bundled entry, or the content, in its "factorix" field.`

/** The value after a flag, and the first argument that is neither a flag nor a flag's value. */
function parse(args: string[], flags: string[]): { values: Record<string, string | undefined>; positional: string | undefined } {
  const values: Record<string, string | undefined> = {}
  const taken = new Set<number>()
  for (const flag of flags) {
    const at = args.indexOf(flag)
    if (at === -1) continue
    values[flag] = args[at + 1]
    taken.add(at).add(at + 1)
  }
  return { values, positional: args.find((value, index) => !taken.has(index) && !value.startsWith('--')) }
}

const shown = (file: string) => relative(process.cwd(), file)

async function pack(rest: string[]): Promise<void> {
  const { values, positional } = parse(rest, ['--out'])
  const packed = await packPlugin(positional ?? '.', { out: values['--out'] })
  const { name, version, permissions = [], egress = [], database, content } = packed.manifest
  console.log(`Packed ${name} ${version} into ${shown(packed.file)}, ${Math.ceil(packed.size / 1024)} KB in ${packed.files.length} files.`)
  if (content) {
    const count = (items: unknown[] | undefined, one: string) => `${items?.length ?? 0} ${one}${items?.length === 1 ? '' : 's'}`
    console.log(`Imports ${count(content.skills, 'skill')}, ${count(content.archetypes, 'archetype')}, and ${count(content.workflows, 'workflow')}.`)
    return
  }
  console.log(
    `Asks for: ${permissions.length ? permissions.join(', ') : 'no permissions'}. Reaches: ${egress.length ? egress.join(', ') : 'only Factorix'}.`,
  )
  if (database) console.log('Gets a Postgres database of its own.')
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args
  if (command === 'pack') return pack(rest)
  if (command === 'keygen' && rest[0]) {
    const key = await generateKey(rest[0])
    console.log(`Wrote a private key to ${rest[0]}. Keep it secret, and keep a copy: a lost key cannot sign again.\nIts public key:\n${key}`)
    return
  }
  const { values, positional } = parse(rest, ['--key'])
  const key = values['--key']
  if (command === 'sign' && positional && key) {
    const signed = await signPackage(positional, key)
    console.log(`Signed ${signed.name} ${signed.version} into ${shown(signed.file)} with ${signed.key}.`)
    return
  }
  if (command === 'registry' && key) {
    const built = await buildRegistry(positional ?? '.', key)
    const count = (value: number, one: string) => `${value} ${one}${value === 1 ? '' : 's'}`
    console.log(`Wrote ${shown(built.index)} and its signature: ${count(built.packages, 'package')}, ${count(built.versions, 'version')}.`)
    console.log(`Factorix adds this registry with its address and the key ${built.key}`)
    return
  }
  console.log(USAGE)
  process.exitCode = command === undefined || command === '--help' ? 0 : 1
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message)
  process.exitCode = 1
})
