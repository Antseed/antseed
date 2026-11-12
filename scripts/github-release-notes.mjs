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
 * the pull requests merged since that bump, and a Thanks section crediting
 * their authors from outside the organization (read with `gh api`, so it needs
 * GH_TOKEN; organization members and bots are left out).
 *
 * Usage: node scripts/github-release-notes.mjs <notes.md>
 * Prints the CLI version, or nothing when that version is not on npm yet.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, readPackage, publishablePackages } from './publishable-packages.mjs';

const [notesPath] = process.argv.slice(2);
if (!notesPath) {
  console.error('usage: github-release-notes.mjs <notes.md>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function onNpm(name, version) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name}@${version}`);
  return true;
}

const cli = readPackage('apps/cli');
if (!(await onNpm(cli.name, cli.version))) process.exit(0);

// The commit that set the previous CLI version: what changed after it is what
// this release ships (the CLI is bumped on every release, since it pins the
// packages it depends on).
const since = git('log', '-2', '--format=%H', '-G"version": ', '--', 'apps/cli/package.json').split('\n')[1];

const released = [];
for (const pkg of publishablePackages()) {
  const bumped = !since || git('log', '-1', '--format=%H', '-G"version": ', `${since}..HEAD`, '--', join(pkg.dir, 'package.json'));
  if (bumped && (await onNpm(pkg.name, pkg.version))) released.push(pkg);
}

const pulls = [];
if (since) {
  for (const line of git('log', '--merges', '--first-parent', '--format=%s%x09%b', `${since}..HEAD`).split('\n')) {
    const [subject, title] = line.split('\t');
    const match = /^Merge pull request #(\d+) from /.exec(subject ?? '');
    if (match && title && !/^chore: Bump versions/i.test(title)) pulls.push({ number: Number(match[1]), title: title.trim() });
  }
}

// Outside contributors, each with their pull requests, oldest first, like the
// Thanks section of other projects' release notes.
const repo = process.env.GITHUB_REPOSITORY || 'Antseed/antseed';
const TEAM = new Set(['OWNER', 'MEMBER']);
const thanks = new Map();
for (const pull of [...pulls].reverse()) {
  const [login, association, type] = execFileSync('gh', ['api', `repos/${repo}/pulls/${pull.number}`,
    '-q', '[.user.login, .author_association, .user.type] | join(" ")'], { encoding: 'utf8' }).trim().split(' ');
  if (TEAM.has(association) || type === 'Bot') continue;
  thanks.set(login, [...(thanks.get(login) ?? []), pull.number]);
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
if (pulls.length > 0) lines.push('## Pull requests', '', ...pulls.map((pull) => `- ${pull.title} (#${pull.number})`), '');
if (thanks.size > 0) {
  const credits = [...thanks].sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  lines.push('## Thanks', '', ...credits.map(([login, numbers]) => `- @${login} (${numbers.map((n) => `#${n}`).join(', ')})`), '');
}
lines.push('Details of each change are in [CHANGELOG.md](https://github.com/Antseed/antseed/blob/main/CHANGELOG.md).', '');

writeFileSync(notesPath, lines.join('\n'));
console.log(cli.version);
