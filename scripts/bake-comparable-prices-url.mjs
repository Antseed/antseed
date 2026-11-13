#!/usr/bin/env node
/**
 * Bake the comparable retail-prices API URL into release builds.
 *
 * ANTSEED_COMPARABLE_PRICES_URL is a runtime environment variable, so npm
 * installs and packaged desktop apps (which don't inherit shell env) would
 * otherwise ship with the savings baseline off. This script rewrites the
 * committed `baked-defaults.ts` modules — which default to null — with the
 * URL taken from the environment (falling back to the repo-root .env.local /
 * .env), so the value ends up compiled into dist without ever being
 * hard-coded in the repo. Runtime env still overrides the baked value, and
 * setting the env var to an empty string disables it.
 *
 * Usage: node scripts/bake-comparable-prices-url.mjs [--require]
 *   --require  Exit non-zero when no URL is configured (release builds).
 *
 * Run from CI before building; if run locally, restore with:
 *   git checkout -- apps/cli/src/generated apps/desktop/src/main/generated
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_KEY = 'ANTSEED_COMPARABLE_PRICES_URL';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  join(root, 'apps/cli/src/generated/baked-defaults.ts'),
  join(root, 'apps/desktop/src/main/generated/baked-defaults.ts'),
];

function readEnvFileValue(filePath, key) {
  if (!existsSync(filePath)) return undefined;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] === key) {
      return match[2].replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

const url = (
  process.env[ENV_KEY]
  ?? readEnvFileValue(join(root, '.env.local'), ENV_KEY)
  ?? readEnvFileValue(join(root, '.env'), ENV_KEY)
  ?? ''
).trim();

if (!url) {
  const message = `${ENV_KEY} is not set — baked defaults stay null (savings baseline off).`;
  if (process.argv.includes('--require')) {
    console.error(`bake-comparable-prices-url: ${message}`);
    process.exit(1);
  }
  console.log(`bake-comparable-prices-url: ${message}`);
  process.exit(0);
}

if (!/^https?:\/\//.test(url)) {
  console.error(`bake-comparable-prices-url: ${ENV_KEY} must be an http(s) URL, got: ${url}`);
  process.exit(1);
}

for (const target of TARGETS) {
  const source = readFileSync(target, 'utf8');
  const baked = source.replace(
    /export const BAKED_COMPARABLE_PRICES_URL: string \| null = .*;/,
    `export const BAKED_COMPARABLE_PRICES_URL: string | null = ${JSON.stringify(url)};`,
  );
  if (baked === source && !source.includes(JSON.stringify(url))) {
    console.error(`bake-comparable-prices-url: could not find the export to rewrite in ${target}`);
    process.exit(1);
  }
  writeFileSync(target, baked);
  console.log(`bake-comparable-prices-url: baked ${url} into ${target}`);
}
