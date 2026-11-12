/**
 * The public packages the npm-publish workflow publishes, shared by
 * npm-publish-plan.mjs and github-release-notes.mjs.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Must match the --filter set in .github/workflows/npm-publish.yml.
const GROUP_DIRS = ['packages', 'plugins'];
const EXTRA_DIRS = ['apps/cli', 'apps/network-stats', 'apps/payments', 'apps/ants', 'apps/gateway-console', 'apps/relay'];

/** The package in `dir` (relative to the repo root), or null when it has no manifest or is private. */
export function readPackage(dir) {
  const manifestPath = join(root, dir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.private) return null;
  return { dir, name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? {} };
}

/** Every publishable package: { dir, name, version, dependencies }. */
export function publishablePackages() {
  const dirs = [...GROUP_DIRS.flatMap((group) => readdirSync(join(root, group)).map((entry) => join(group, entry))), ...EXTRA_DIRS];
  return dirs.map(readPackage).filter(Boolean);
}
