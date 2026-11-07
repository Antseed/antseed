#!/usr/bin/env node
// Lists the model ids used in website and skill examples, so maintainers can
// check them against the live catalog before a release.
//
//   node apps/website/scripts/list-example-model-ids.mjs
//   node apps/website/scripts/list-example-model-ids.mjs --check http://localhost:8377/v1/models
//
// With --check, each id is looked up in the catalog (by id or alias). Ids no
// seller offers are marked MISSING. "free" means at least one seller lists the
// model at $0, not that automatic routing will pick that seller.
// Not run in CI: the catalog changes all the time.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOTS = [
  'apps/website/docs',
  'apps/website/src/integrations',
  'apps/website/static/llms.txt',
  'skills',
];
const EXTENSIONS = /\.(md|mdx|ts|tsx|txt|sh)$/;

const PATTERNS = [
  /"model"\s*:\s*"([^"]+)"/g,
  /\bmodel\s*[:=]\s*['"]([^'"]+)['"]/g,
  /--model[ =]["']?([^\s"'`\\,)]+)/g,
  /_MODEL["']?\s*[=:]\s*["']?([^\s"',`]+)/g,
  /<peerId>@([A-Za-z0-9._/:-]+)/g,
  /models set ["']?([^\s"'`]+)/g,
];
const SUGGESTED = /suggested:\s*\[([^\]]*)\]/g;

function walk(path, out) {
  const full = join(repoRoot, path);
  if (statSync(full).isDirectory()) {
    for (const name of readdirSync(full)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(join(path, name), out);
    }
  } else if (EXTENSIONS.test(path)) {
    out.push(path);
  }
}

function normalize(raw) {
  let id = raw.trim().replace(/[.,;:]+$/, '');
  id = id.replace(/^antseed\//, '').replace(/^<peerId>@/, '');
  if (!id || /[<>${}…*]/.test(id) || id.startsWith('@preset/') || id === 'antseed' || /^[A-Z_]+$/.test(id)) return null;
  if (/^[0-9a-f]{40}@/.test(id)) id = id.slice(41);
  return id;
}

const found = new Map(); // id -> Set of "file:line"
const files = [];
for (const root of ROOTS) walk(root, files);
for (const file of files) {
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const ids = [];
    for (const re of PATTERNS) for (const m of line.matchAll(re)) ids.push(m[1]);
    for (const m of line.matchAll(SUGGESTED)) {
      for (const item of m[1].matchAll(/['"]([^'"]+)['"]/g)) ids.push(item[1]);
    }
    for (const raw of ids) {
      const id = normalize(raw);
      if (!id) continue;
      if (!found.has(id)) found.set(id, new Set());
      found.get(id).add(`${relative(repoRoot, join(repoRoot, file))}:${i + 1}`);
    }
  });
}

/**
 * An offer is free only when it lists its token prices as zero and charges nothing
 * else: no cached-input or image price and no priced unit-billing component (the
 * same charges as `isPricedService` in packages/node/src/payments/free-tier-program.ts).
 * Missing token prices mean the price is unknown, not free.
 */
function isFreeOffer(offer) {
  if (offer.inputUsdPerMillion !== 0 || offer.outputUsdPerMillion !== 0) return false;
  const positive = (value) => typeof value === 'number' && value > 0;
  if (positive(offer.cachedInputUsdPerMillion) || positive(offer.maxImageUsdPerImage)) return false;
  return !Object.values(offer.unitBillingModels ?? {}).some((model) =>
    (model?.components ?? []).some((component) => !(component.priceUsd <= 0)));
}

const checkIndex = process.argv.indexOf('--check');
let catalog = null;
if (checkIndex !== -1) {
  const url = process.argv[checkIndex + 1];
  if (!url) {
    console.error('usage: --check <url of GET /v1/models>');
    process.exit(2);
  }
  const headers = process.env.ANTSEED_API_KEY ? { authorization: `Bearer ${process.env.ANTSEED_API_KEY}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`GET ${url} -> ${res.status}`);
    process.exit(2);
  }
  catalog = new Map();
  for (const model of (await res.json()).data ?? []) {
    const free = (model.peers ?? []).some(isFreeOffer);
    for (const name of [model.id, ...(model.aliases ?? [])]) catalog.set(String(name).toLowerCase(), { id: model.id, free });
  }
}

let missing = 0;
for (const [id, where] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
  let status = '';
  if (catalog) {
    const hit = catalog.get(id.toLowerCase());
    if (!hit) {
      status = 'MISSING';
      missing += 1;
    } else {
      status = hit.free ? 'free' : 'paid';
    }
  }
  console.log([status, id, [...where].join(' ')].filter(Boolean).join('\t'));
}
if (catalog) console.error(`${found.size} ids, ${missing} missing from the catalog`);
