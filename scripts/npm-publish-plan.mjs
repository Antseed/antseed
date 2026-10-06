#!/usr/bin/env node
/**
 * Compute and validate the npm publish plan.
 *
 * The decision of WHAT to release is made by version bumps (locally, via the
 * /publish flow): `pnpm -r publish` only publishes packages whose
 * package.json version is not on the registry yet. This script makes that
 * plan visible before publishing and enforces the release invariants that
 * are easy to get wrong:
 *
 *   1. Pin cascade — pnpm resolves `workspace:*` regular dependencies to
 *      EXACT versions at pack time. If a package is being published but a
 *      public dependent that pins it is not, npm users of the dependent
 *      keep resolving the old version and the fix silently never ships
 *      (e.g. a @antseed/node bump requires republishing @antseed/payments
 *      and @antseed/cli; peer-range dependents like provider-core do not
 *      need a rebump).
 *   2. Local-behind-registry — a local version older than the published
 *      one means version bumps from a previous release were never
 *      committed; publishing from this tree would ship stale code.
 *
 * Usage: node scripts/npm-publish-plan.mjs
 * Exits non-zero on invariant violations or registry errors.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Must match the --filter set in .github/workflows/npm-publish.yml.
const GROUP_DIRS = ['packages', 'plugins'];
const EXTRA_DIRS = ['apps/cli', 'apps/network-stats', 'apps/payments', 'apps/ants', 'apps/relay'];

function readPackage(dir) {
  const manifestPath = join(root, dir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.private) return null;
  return { dir, name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? {} };
}

const packages = [];
for (const group of GROUP_DIRS) {
  for (const entry of readdirSync(join(root, group))) {
    const pkg = readPackage(join(group, entry));
    if (pkg) packages.push(pkg);
  }
}
for (const dir of EXTRA_DIRS) {
  const pkg = readPackage(dir);
  if (pkg) packages.push(pkg);
}

async function publishedVersions(name) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' }, // abbreviated metadata
  });
  if (res.status === 404) return null; // never published
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${name}`);
  const body = await res.json();
  return { versions: Object.keys(body.versions ?? {}), latest: body['dist-tags']?.latest ?? null };
}

function compareSemver(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const toPublish = new Set();
const problems = [];
const rows = [];

for (const pkg of packages) {
  const registry = await publishedVersions(pkg.name);
  if (registry === null) {
    toPublish.add(pkg.name);
    rows.push([pkg.name, pkg.version, '(never published)', 'PUBLISH (first release)']);
    continue;
  }
  if (registry.versions.includes(pkg.version)) {
    rows.push([pkg.name, pkg.version, registry.latest, 'skip (already on npm)']);
  } else if (registry.latest && compareSemver(pkg.version, registry.latest) < 0) {
    rows.push([pkg.name, pkg.version, registry.latest, 'ERROR (local behind npm)']);
    problems.push(
      `${pkg.name}: local version ${pkg.version} is BEHIND npm latest ${registry.latest} — ` +
      'a previous release probably never committed its version bumps.',
    );
  } else {
    toPublish.add(pkg.name);
    rows.push([pkg.name, pkg.version, registry.latest, 'PUBLISH']);
  }
}

// Pin-cascade check: every public dependent that exact-pins a to-be-published
// package (regular `workspace:` dependency) must itself be in the publish set.
const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
for (const dependent of packages) {
  for (const [depName, spec] of Object.entries(dependent.dependencies)) {
    if (!String(spec).startsWith('workspace:')) continue;
    if (!byName.has(depName)) continue;
    if (toPublish.has(depName) && !toPublish.has(dependent.name)) {
      problems.push(
        `${depName} is being published, but ${dependent.name} pins it exactly (workspace dependency) ` +
        `and has no version bump — npm installs of ${dependent.name} would keep the old ${depName}. ` +
        `Bump ${dependent.name} too.`,
      );
    }
  }
}

const widths = [0, 0, 0];
for (const row of rows) {
  for (let i = 0; i < 3; i++) widths[i] = Math.max(widths[i], String(row[i]).length);
}
console.log('npm publish plan (packages with a version not on the registry):\n');
for (const row of rows) {
  console.log(`  ${String(row[0]).padEnd(widths[0])}  ${String(row[1]).padEnd(widths[1])}  ${String(row[2]).padEnd(widths[2])}  ${row[3]}`);
}
console.log(`\n${toPublish.size} package(s) will be published.`);

if (problems.length > 0) {
  console.error('\nRelease invariant violations:');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
