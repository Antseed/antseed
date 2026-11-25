#!/usr/bin/env node
// Assembles the npm package that carries one platform's sidecar binary:
//   node scripts/platform-package.mjs <platform> <arch> <binary path> <out dir>
// The package is `@antseed/keyed-relay-<platform>-<arch>` at the version of
// `@antseed/keyed-relay`, which finds its `bin/` (resolveKeyedRelayBinary).
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [platform, arch, binary, outDir] = process.argv.slice(2)
if (!platform || !arch || !binary || !outDir) {
  console.error('usage: platform-package.mjs <platform> <arch> <binary> <out dir>')
  process.exit(2)
}
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const name = `@antseed/keyed-relay-${platform}-${arch}`
const dir = join(outDir, `keyed-relay-${platform}-${arch}`)
mkdirSync(join(dir, 'bin'), { recursive: true })
const target = join(dir, 'bin', basename(binary))
copyFileSync(binary, target)
if (platform !== 'win32') chmodSync(target, 0o755)
writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
  name,
  version,
  description: `The ${platform}-${arch} binary of the Antseed keyed-relay sidecar (@antseed/keyed-relay)`,
  os: [platform],
  cpu: [arch],
  files: ['bin'],
  license: 'GPL-3.0-only',
}, null, 2)}\n`)
console.log(`${name}@${version} -> ${dir}`)
