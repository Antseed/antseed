#!/usr/bin/env node
// Declares the per-platform sidecar packages as optional dependencies of
// `@antseed/keyed-relay`, in the manifest about to be published:
//   node scripts/declare-platform-packages.mjs
// npm then installs the one that matches the host (their `os` and `cpu`), where
// resolveKeyedRelayBinary() finds it. The npm-publish workflow runs this before
// it publishes. The manifest in git does not list them: a lockfile cannot hold a
// package that npm does not have yet, and each release publishes new ones.
// It fails when a platform package of this version is not on npm, so the
// binaries (keyed-relay-binaries.yml) are always published first.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The platforms keyed-relay-binaries.yml builds, as `<platform>-<arch>`. */
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

const platformPackages = () => PLATFORMS.map((platform) => `@antseed/keyed-relay-${platform}`)

/** `manifest` with every platform package as an optional dependency at the manifest's own version. */
export function declarePlatformPackages(manifest) {
  return {
    ...manifest,
    optionalDependencies: {
      ...manifest.optionalDependencies,
      ...Object.fromEntries(platformPackages().map((name) => [name, manifest.version])),
    },
  }
}

/** The platform packages of the manifest's version that `onNpm(name, version)` does not find, as `name@version`. */
export async function missingPlatformPackages(manifest, onNpm) {
  const missing = []
  for (const name of platformPackages()) {
    if (!(await onNpm(name, manifest.version))) missing.push(`${name}@${manifest.version}`)
  }
  return missing
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { onNpm } = await import('../../../scripts/npm-registry.mjs')
  const manifestUrl = new URL('../package.json', import.meta.url)
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'))
  if (await onNpm(manifest.name, manifest.version)) {
    console.log(`${manifest.name}@${manifest.version} is already on npm: nothing to declare`)
  } else {
    const missing = await missingPlatformPackages(manifest, onNpm)
    if (missing.length > 0) {
      console.error(`Not on npm: ${missing.join(', ')}.\nRun the "Keyed relay binaries" workflow on this commit first, then publish.`)
      process.exit(1)
    }
    writeFileSync(manifestUrl, `${JSON.stringify(declarePlatformPackages(manifest), null, 2)}\n`)
    console.log(`${manifest.name}@${manifest.version} declares ${PLATFORMS.length} platform packages`)
  }
}
