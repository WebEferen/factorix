// The workspace reads src/ directly. What goes to npm is dist/, with a package.json that points at the built files.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const own = JSON.parse(readFileSync('package.json', 'utf8'))
const entry = (name) => ({ types: `./${name}.d.ts`, default: `./${name}.js` })
const published = {
  name: own.name,
  version: own.version,
  description: own.description,
  license: own.license,
  repository: own.repository,
  type: 'module',
  exports: { '.': entry('index'), './node': entry('node'), './pack': entry('pack'), './testing': entry('testing') },
  bin: { 'factorix-plugin': './cli.js' },
  engines: own.engines,
  publishConfig: { access: 'public' },
}
writeFileSync('dist/package.json', `${JSON.stringify(published, null, 2)}\n`)
for (const file of ['README.md', 'LICENSE']) copyFileSync(file, `dist/${file}`)
