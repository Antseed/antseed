#!/usr/bin/env node
/**
 * Write the GitHub release notes for an npm publish run.
 *
 * The npm-publish workflow calls this after `pnpm publish` succeeds, with the
 * plan that scripts/npm-publish-plan.mjs wrote (`--json`). The release is
 * named after the CLI version (tag `cli-v<version>`), since the CLI is what
 * people install; the notes list every package the run published, how to
 * install the CLI, and the pull requests merged since the previous CLI
 * version bump.
 *
 * Usage: node scripts/github-release-notes.mjs <plan.json> <notes.md>
 * Prints the CLI version, or nothing when the run did not publish the CLI.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [planPath, notesPath] = process.argv.slice(2);
if (!planPath || !notesPath) {
  console.error('usage: github-release-notes.mjs <plan.json> <notes.md>');
  process.exit(2);
}

const published = JSON.parse(readFileSync(planPath, 'utf8'));
const cli = published.find((pkg) => pkg.name === '@antseed/cli');
if (!cli) process.exit(0);

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// The commit that set the previous CLI version: the PRs merged after it are
// the ones this release ships (the CLI is bumped on every release, since it
// pins the packages it depends on).
const bumps = git('log', '-2', '--format=%H', '-G"version": ', '--', 'apps/cli/package.json').split('\n');
const since = bumps[1];
const merges = since
  ? git('log', '--merges', '--first-parent', '--format=%s%x09%b', `${since}..HEAD`).split('\n').filter(Boolean)
  : [];
const pulls = [];
for (const line of merges) {
  const [subject, title] = line.split('\t');
  const match = /^Merge pull request #(\d+) from /.exec(subject);
  if (match && title && !/^chore: Bump versions/i.test(title)) pulls.push(`- ${title.trim()} (#${match[1]})`);
}

const npmLink = (pkg) => `[\`${pkg.name}@${pkg.version}\`](https://www.npmjs.com/package/${pkg.name}/v/${pkg.version})`;
const lines = [
  'Install or update the CLI:',
  '',
  '```sh',
  `npm install -g @antseed/cli@${cli.version}`,
  '```',
  '',
  `## Packages published (${published.length})`,
  '',
  ...published.map((pkg) => `- ${npmLink(pkg)}`),
  '',
];
if (pulls.length > 0) lines.push('## Pull requests', '', ...pulls, '');
lines.push('Details of each change are in [CHANGELOG.md](https://github.com/Antseed/antseed/blob/main/CHANGELOG.md).', '');

writeFileSync(notesPath, lines.join('\n'));
console.log(cli.version);
