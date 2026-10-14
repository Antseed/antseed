#!/usr/bin/env node
/**
 * Gateway admission benchmark: fills a gateway store with 500,000 ledger
 * rows and times admit() with daily, weekly, monthly and total caps at the
 * key, member and workspace level (target: under 5 ms).
 *
 *   pnpm --filter @antseed/cli build   # or: cd apps/cli && npx tsc -p .
 *   node scripts/gateway-admit-benchmark.mjs [rows]
 *
 * It runs the same test the CLI suite runs at a smaller size.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rows = process.argv[2] ?? '500000'
const result = spawnSync(process.execPath, ['--test', join(root, 'apps/cli/dist/gateway/admission-benchmark.test.js')], {
  stdio: 'inherit',
  env: { ...process.env, ANTSEED_ADMIT_BENCH_ROWS: rows },
})
process.exit(result.status ?? 1)
