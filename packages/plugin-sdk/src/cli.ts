#!/usr/bin/env node
import { relative } from 'node:path'
import { packPlugin } from './pack.js'

const USAGE = `Usage: factorix-plugin pack [folder] [--out file.zip]

Packs a built plugin into the zip an organization's admin uploads under Integrations, Plugins.
The folder's package.json names the bundled entry in its "factorix" field.`

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args
  if (command !== 'pack') {
    console.log(USAGE)
    process.exitCode = command === undefined || command === '--help' ? 0 : 1
    return
  }
  const outAt = rest.indexOf('--out')
  const out = outAt === -1 ? undefined : rest[outAt + 1]
  const dir = rest.find((value, index) => !value.startsWith('--') && (outAt === -1 || index !== outAt + 1)) ?? '.'
  const packed = await packPlugin(dir, { out })
  const { name, version, permissions, egress, database } = packed.manifest
  console.log(
    `Packed ${name} ${version} into ${relative(process.cwd(), packed.file)}, ${Math.ceil(packed.size / 1024)} KB in ${packed.files.length} files.`,
  )
  console.log(
    `Asks for: ${permissions.length ? permissions.join(', ') : 'no permissions'}. Reaches: ${egress.length ? egress.join(', ') : 'only Factorix'}.`,
  )
  if (database) console.log('Gets a Postgres database of its own.')
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message)
  process.exitCode = 1
})
