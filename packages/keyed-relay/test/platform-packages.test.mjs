import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { declarePlatformPackages, missingPlatformPackages } from '../scripts/declare-platform-packages.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const workflow = readFileSync(new URL('../../../.github/workflows/keyed-relay-binaries.yml', import.meta.url), 'utf8')
/** The packages the binaries workflow builds and publishes, read from its matrix. */
const built = [...workflow.matchAll(/platform: (\w+), arch: (\w+)/g)].map(([, platform, arch]) => `@antseed/keyed-relay-${platform}-${arch}`).sort()

test('the published package installs the sidecar of every platform the binaries workflow builds', () => {
  assert.ok(built.length > 0, 'no platform found in the binaries workflow')
  const declared = declarePlatformPackages(manifest)
  assert.deepEqual(Object.keys(declared.optionalDependencies).sort(), built)
  // An exact version: the sidecars speak one protocol version, so the two are released together.
  assert.deepEqual([...new Set(Object.values(declared.optionalDependencies))], [manifest.version])
  assert.deepEqual({ ...declared, optionalDependencies: undefined }, { ...manifest, optionalDependencies: undefined })
})

test('a release names the platform packages npm does not have yet', async () => {
  const published = new Set([`${built[0]}@${manifest.version}`])
  const missing = await missingPlatformPackages(manifest, (name, version) => published.has(`${name}@${version}`))
  assert.deepEqual(missing.sort(), built.slice(1).map((name) => `${name}@${manifest.version}`))
})
