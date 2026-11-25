import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitBranchCache, parseHead, readGitBranch } from './git-branch.js';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'git-branch-'));
}

test('HEAD names a branch, or a short commit when detached', () => {
  assert.equal(parseHead('ref: refs/heads/main\n'), 'main');
  assert.equal(parseHead('ref: refs/heads/feat/desktop-gateway'), 'feat/desktop-gateway');
  assert.equal(parseHead('145d06f8f0c1e2d3a4b5c6d7e8f9a0b1c2d3e4f5\n'), '145d06f');
  assert.equal(parseHead('ref: refs/remotes/origin/main'), null);
  assert.equal(parseHead('garbage'), null);
});

test('reads the branch from the repository root and from a folder inside it', async () => {
  const repo = tempDir();
  mkdirSync(path.join(repo, '.git'));
  writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  mkdirSync(path.join(repo, 'apps', 'desktop'), { recursive: true });
  assert.equal(await readGitBranch(repo), 'feature/x');
  assert.equal(await readGitBranch(path.join(repo, 'apps', 'desktop')), 'feature/x');
});

test('follows a worktree .git file to its own HEAD', async () => {
  const root = tempDir();
  const gitDir = path.join(root, 'main-repo', '.git', 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n');
  const worktree = path.join(root, 'wt');
  mkdirSync(worktree);
  writeFileSync(path.join(worktree, '.git'), 'gitdir: ../main-repo/.git/worktrees/wt\n');
  assert.equal(await readGitBranch(worktree), 'wt-branch');
});

test('a folder outside any repository or a relative path has no branch', async () => {
  assert.equal(await readGitBranch(tempDir()), null);
  assert.equal(await readGitBranch('relative/path'), null);
  assert.equal(await readGitBranch(''), null);
});

test('the cache reads each folder once per window', async () => {
  let reads = 0;
  let now = 1_000;
  const cache = new GitBranchCache(async () => { reads += 1; return 'main'; }, 5_000, () => now);
  assert.equal(await cache.get('/repo'), 'main');
  assert.equal(await cache.get('/repo'), 'main');
  assert.equal(reads, 1);
  now += 5_000;
  await cache.get('/repo');
  assert.equal(reads, 2);
});
