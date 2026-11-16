// A throwaway checkout that looks like a built AntSeed repo, for the --seller-tree/--buyer-tree checks.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const BUILT = ['apps/cli/dist/cli/index.js', 'packages/node/dist/index.js', 'packages/node/dist/discovery/bootstrap.js', 'packages/node/dist/p2p/nat-traversal.js', 'plugins/provider-openai/dist/index.js', 'plugins/router-local/dist/index.js'];

export async function fakeTree({ built = true, cliName = '@antseed/cli', at } = {}) {
  const dir = at ?? mkdtempSync(join(tmpdir(), 'tb-tree-'));
  const write = (file, text) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };
  write('apps/cli/package.json', JSON.stringify({ name: cliName }));
  if (built) for (const file of BUILT) write(file, '');
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  return { dir: realpathSync(dir), head: git('rev-parse', 'HEAD') };
}
