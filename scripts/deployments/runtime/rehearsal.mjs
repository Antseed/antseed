import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withAnvilFork } from './anvil.mjs';
import { loadDotEnv, requireEnvironment } from './env.mjs';
import { CANONICAL_DEPLOYMENTS_ROOT } from './paths.mjs';

export function resolveRehearsal(migration, options, registry) {
  const visiting = new Set();
  const visited = new Set();
  const migrations = [];
  let fork;

  function visit(current) {
    if (visiting.has(current.id)) throw new Error(`Cyclic rehearsal prerequisite: ${current.id}`);
    if (visited.has(current.id)) return;
    const declaration = current.rehearsal;
    if (typeof declaration?.run !== 'function') throw new Error(`${current.id} has no rehearsal hook`);
    const prerequisites = declaration.prerequisites ?? [];
    if (!Array.isArray(prerequisites)) throw new Error(`${current.id} rehearsal prerequisites must be an array`);
    current.validateOptions?.({ ...options, migration: current.id });
    visiting.add(current.id);
    for (const prerequisite of prerequisites) {
      const dependency = registry.get(prerequisite);
      if (!dependency) throw new Error(`${current.id} has unknown rehearsal prerequisite ${prerequisite}`);
      visit(dependency);
    }
    if (declaration.fork) {
      const configured = declaration.fork;
      if (!configured.rpcEnv || !Number.isSafeInteger(configured.chainId) || configured.chainId <= 0
        || !Number.isSafeInteger(configured.forkBlockNumber) || configured.forkBlockNumber < 0) {
        throw new Error(`${current.id} requires a pinned rehearsal fork configuration`);
      }
      if (fork && ['rpcEnv', 'chainId', 'forkBlockNumber'].some((key) => fork[key] !== configured[key])) {
        throw new Error(`${current.id} rehearsal fork conflicts with its prerequisites`);
      }
      fork = configured;
    }
    visiting.delete(current.id);
    visited.add(current.id);
    migrations.push(current);
  }

  visit(migration);
  if (!fork) throw new Error(`${migration.id} has no rehearsal fork configuration`);
  return { migrations, fork };
}

export async function runRehearsal(migration, options, { registry, runMigration }, dependencies = {}) {
  const { migrations, fork } = resolveRehearsal(migration, options, registry);
  await (dependencies.loadDotEnv ?? loadDotEnv)();
  requireEnvironment([fork.rpcEnv]);
  const outputRoot = await mkdtemp(path.join(tmpdir(), `antseed-${migration.id.toLowerCase()}-deployments-`));
  console.log(`${migration.id} fork test records: ${outputRoot}`);
  await cp(dependencies.canonicalRoot ?? CANONICAL_DEPLOYMENTS_ROOT, outputRoot, { recursive: true });
  const withFork = dependencies.withAnvilFork ?? withAnvilFork;
  await withFork({ forkUrl: process.env[fork.rpcEnv], forkBlockNumber: fork.forkBlockNumber, chainId: fork.chainId }, async ({ rpcUrl }) => {
    for (const current of migrations) {
      await current.rehearsal.run({
        rpcUrl,
        outputRoot,
        network: options.network,
        runMigration: (overrides = {}) => runMigration(current, {
          migration: current.id,
          network: options.network,
          mode: 'broadcast',
          signers: {},
        }, { ...overrides, rpcUrl, outputRoot, canonicalRoot: outputRoot, forkTest: true }),
      });
    }
  });
  console.log(`${migration.id} fork test passed. Temporary records: ${outputRoot}`);
}
