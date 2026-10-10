#!/usr/bin/env node
/**
 * Bake public PostHog ingestion configuration — and the download-proxy
 * endpoint for install attribution — into desktop release builds.
 *
 * Packaged GUI apps do not inherit the CI shell environment. This script
 * rewrites the committed null defaults before TypeScript compilation, matching
 * the existing comparable-prices bake flow. Runtime environment variables
 * still override baked values and remain the emergency kill/config switch.
 *
 * Usage: node scripts/bake-desktop-telemetry-config.mjs [--require]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'apps/desktop/src/main/generated/baked-defaults.ts');
const host = (process.env.POSTHOG_HOST ?? '').trim().replace(/\/+$/, '');
const projectApiKey = (process.env.POSTHOG_PROJECT_API_KEY ?? '').trim();
const required = process.argv.includes('--require');
// Install attribution reports (apps/desktop/src/main/telemetry/attribution.ts)
// go to the download proxy; release builds default to production, and an
// explicit empty ATTRIBUTION_ENDPOINT keeps it disabled.
const attributionEndpoint = Object.prototype.hasOwnProperty.call(process.env, 'ATTRIBUTION_ENDPOINT')
  ? (process.env.ATTRIBUTION_ENDPOINT ?? '').trim().replace(/\/+$/, '')
  : 'https://download.antseed.com';

if (!host || !projectApiKey) {
  const message = 'POSTHOG_HOST and POSTHOG_PROJECT_API_KEY must both be set.';
  if (required) {
    console.error(`bake-desktop-telemetry-config: ${message}`);
    process.exit(1);
  }
  console.log(`bake-desktop-telemetry-config: ${message} Baked defaults stay null.`);
  process.exit(0);
}

let hostUrl;
try {
  hostUrl = new URL(host);
} catch {
  hostUrl = null;
}
if (!hostUrl || hostUrl.protocol !== 'https:') {
  console.error('bake-desktop-telemetry-config: POSTHOG_HOST must be an HTTPS URL.');
  process.exit(1);
}
if (attributionEndpoint) {
  let endpointUrl;
  try {
    endpointUrl = new URL(attributionEndpoint);
  } catch {
    endpointUrl = null;
  }
  if (!endpointUrl || endpointUrl.protocol !== 'https:') {
    console.error('bake-desktop-telemetry-config: ATTRIBUTION_ENDPOINT must be an HTTPS URL or empty.');
    process.exit(1);
  }
}

let source = readFileSync(target, 'utf8');
source = source.replace(
  /export const BAKED_POSTHOG_HOST: string \| null = .*;/,
  `export const BAKED_POSTHOG_HOST: string | null = ${JSON.stringify(host)};`,
);
source = source.replace(
  /export const BAKED_POSTHOG_PROJECT_API_KEY: string \| null = .*;/,
  `export const BAKED_POSTHOG_PROJECT_API_KEY: string | null = ${JSON.stringify(projectApiKey)};`,
);

source = source.replace(
  /export const BAKED_ATTRIBUTION_ENDPOINT: string \| null = .*;/,
  `export const BAKED_ATTRIBUTION_ENDPOINT: string | null = ${attributionEndpoint ? JSON.stringify(attributionEndpoint) : 'null'};`,
);

if (!source.includes(JSON.stringify(host)) || !source.includes(JSON.stringify(projectApiKey))) {
  console.error('bake-desktop-telemetry-config: could not rewrite generated defaults.');
  process.exit(1);
}

writeFileSync(target, source);
console.log(
  `bake-desktop-telemetry-config: baked PostHog host ${host}, project key, and attribution endpoint ${attributionEndpoint || '(disabled)'}.`,
);
