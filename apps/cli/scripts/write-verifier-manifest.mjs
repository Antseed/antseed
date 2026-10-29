#!/usr/bin/env node
/**
 * Writes the `antseedVerifier` field of apps/cli/package.json from the built CLI (run
 * `pnpm --filter @antseed/cli verifier-manifest`). Do this whenever the audited model list or
 * AUDIT_RULES_VERSION changes; a CLI test fails while the field is out of date. npm publishes the
 * field with the package, and verifiers compare it with the latest published version's.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localVerifierManifest } from '../dist/verifier/release-check.js'

const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const pkg = JSON.parse(readFileSync(path, 'utf8'))
const { auditRulesVersion, auditedModelsHash } = localVerifierManifest()
pkg.antseedVerifier = { auditRulesVersion, auditedModelsHash }
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`updated antseedVerifier in ${path}`)
