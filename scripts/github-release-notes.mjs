#!/usr/bin/env node
/**
 * Write the GitHub release notes for the CLI version on this commit.
 *
 * The npm-publish workflow calls this after publishing. The release is named
 * after the CLI version (tag `cli-v<version>`), since the CLI is what people
 * install. It reads npm rather than the run's publish plan, so a run that
 * fails after the CLI is on npm, and a retry that then has nothing left to
 * publish, still gets its release.
 *
 * The notes list how to install the CLI, the packages released with it (those
 * whose version changed since the previous CLI version bump and is on npm),
 * and the pull requests merged since that bump.
 *
 * Usage: node scripts/github-release-notes.mjs <notes.md>
 * Prints the CLI version, or nothing when that version is not on npm yet.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [notesPath] = process.argv.slice(2);
if (!notesPath) {
  console.error('usage: github-release-notes.mjs <notes.md>');
  process.exit(2);
}

// Must match the --filter set in .github/workflows/npm-publish.yml.
const GROUP_DIRS = ['packages', 'plugins'];
const EXTRA_DIRS = ['apps/cli', 'apps/network-stats', 'apps/payments', 'apps/ants', 'apps/gateway-console', 'apps/relay'];

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function onNpm(name, version) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name}@${version}`);
  return true;
}

function readPackage(dir) {
  const manifestPath = join(root, dir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return manifest.private ? null : { dir, name: manifest.name, version: manifest.version };
}

const cli = readPackage('apps/cli');
if (!(await onNpm(cli.name, cli.version))) process.exit(0);

// The commit that set the previous CLI version: what changed after it is what
// this release ships (the CLI is bumped on every release, since it pins the
// packages it depends on).
const since = git('log', '-2', '--format=%H', '-G"version": ', '--', 'apps/cli/package.json').split('\n')[1];

const dirs = [...GROUP_DIRS.flatMap((group) => readdirSync(join(root, group)).map((entry) => join(group, entry))), ...EXTRA_DIRS];
const released = [];
for (const dir of dirs) {
  const pkg = readPackage(dir);
  if (!pkg) continue;
  const bumped = !since || git('log', '-1', '--format=%H', '-G"version": ', `${since}..HEAD`, '--', join(dir, 'package.json'));
  if (bumped && (await onNpm(pkg.name, pkg.version))) released.push(pkg);
}

const pulls = [];
if (since) {
  for (const line of git('log', '--merges', '--first-parent', '--format=%s%x09%b', `${since}..HEAD`).split('\n')) {
    const [subject, title] = line.split('\t');
    const match = /^Merge pull request #(\d+) from /.exec(subject ?? '');
    if (match && title && !/^chore: Bump versions/i.test(title)) pulls.push(`- ${title.trim()} (#${match[1]})`);
  }
}

const npmLink = (pkg) => `[\`${pkg.name}@${pkg.version}\`](https://www.npmjs.com/package/${pkg.name}/v/${pkg.version})`;
const lines = [
  'Install or update the CLI:',
  '',
  '```sh',
  `npm install -g @antseed/cli@${cli.version}`,
  '```',
  '',
  `## Packages released (${released.length})`,
  '',
  ...released.map((pkg) => `- ${npmLink(pkg)}`),
  '',
];
if (pulls.length > 0) lines.push('## Pull requests', '', ...pulls, '');
lines.push('Details of each change are in [CHANGELOG.md](https://github.com/Antseed/antseed/blob/main/CHANGELOG.md).', '');

writeFileSync(notesPath, lines.join('\n'));
console.log(cli.version);
