// Which checkout of this repo each side of a cli-mode testbench runs from (--seller-tree, --buyer-tree), so one
// version can be tested against another. The testbench's own code, mocks, chain setup and oracle stay in this worktree.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realHome } from './env.mjs';
import { isInside } from './paths.mjs';

const SIDES = [['seller', '--seller-tree', 'sellerTree'], ['buyer', '--buyer-tree', 'buyerTree']];
const BUILT = ['apps/cli/dist/cli/index.js', 'packages/node/dist/index.js', 'packages/node/dist/discovery/bootstrap.js', 'packages/node/dist/p2p/nat-traversal.js', 'plugins/provider-openai/dist/index.js', 'plugins/router-local/dist/index.js'];

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The root of a git checkout whose apps/cli is the AntSeed CLI. */
function isRepoCheckout(path) {
  const top = git(path, 'rev-parse', '--show-toplevel');
  if (!top || realpathSync(top) !== path) return false;
  try {
    return JSON.parse(readFileSync(join(path, 'apps/cli/package.json'), 'utf8')).name === '@antseed/cli';
  } catch {
    return false;
  }
}

/** A named tree as { path, head }; refuses anything but a built checkout of this repo outside the real ~/.antseed. */
function checkedTree(dir, flag, actualHome) {
  const given = resolve(dir);
  if (!existsSync(given)) throw new Error(`${flag}: ${given} does not exist`);
  const path = realpathSync(given);
  if (actualHome) {
    const antseed = join(actualHome, '.antseed');
    if (isInside(given, antseed) || isInside(path, existsSync(antseed) ? realpathSync(antseed) : antseed)) throw new Error(`${flag}: refusing ${path}, which is your real ~/.antseed`);
  }
  if (!isRepoCheckout(path)) throw new Error(`${flag}: ${path} is not a checkout of this repo (the root of a git worktree with apps/cli)`);
  const missing = BUILT.filter((file) => !existsSync(join(path, file)));
  if (missing.length) throw new Error(`${flag}: ${path} is not built (missing ${missing.join(', ')}); run pnpm run build there`);
  return { path, head: git(path, 'rev-parse', 'HEAD') };
}

/** `{ seller, buyer }`, each `{ path, head }`. A side without a flag runs from this worktree. */
export function resolveTrees(options, worktree, mode, actualHome = realHome()) {
  const trees = {};
  for (const [side, flag, key] of SIDES) {
    if (options[key] !== undefined && mode !== 'cli') throw new Error(`${flag} runs real CLI processes, but this testbench is in ${mode} mode; add --mode cli`);
    trees[side] = options[key] === undefined ? { path: worktree, head: git(worktree, 'rev-parse', 'HEAD') } : checkedTree(options[key], flag, actualHome);
  }
  return trees;
}

/** The sides that run from another checkout, or undefined: part of the topology, so a reuse must match them. */
export function otherTrees(trees, worktree) {
  const other = Object.fromEntries(Object.entries(trees).filter(([, tree]) => tree.path !== worktree));
  return Object.keys(other).length ? other : undefined;
}

export function describeTree(tree) {
  return `${tree.path} @ ${tree.head?.slice(0, 12) ?? 'unknown commit'}`;
}

export function treesLine(trees) {
  return `Trees: seller ${describeTree(trees.seller)}; buyer ${describeTree(trees.buyer)}`;
}
