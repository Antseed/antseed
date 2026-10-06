import { cp } from 'node:fs/promises';
import path from 'node:path';
import { CANONICAL_DEPLOYMENTS_ROOT } from './paths.mjs';
import { run } from './exec.mjs';
import { fileExists, readJson } from './fsx.mjs';
import { buildArtifactIndex, compareRuntimeCode, findArtifact } from './bytecode.mjs';
import { rpcEnvName } from './env.mjs';
import { writeJsonAtomic, writeJsonOnce } from './artifacts.mjs';

/**
 * Resolves everything a migration phase needs: the canonical baseline, the
 * writable output root, the RPC endpoint, and the checkpoint location.
 */
export async function loadContext(migration, network, overrides = {}) {
  const canonicalRoot = overrides.canonicalRoot ?? CANONICAL_DEPLOYMENTS_ROOT;
  const outputRoot = overrides.outputRoot ?? process.env.CONTRACT_DEPLOYMENTS_ROOT ?? canonicalRoot;
  if (outputRoot !== canonicalRoot && !(await fileExists(path.join(outputRoot, network, 'current.json')))) {
    await cp(canonicalRoot, outputRoot, { recursive: true });
  }
  const canonical = await readJson(path.join(canonicalRoot, network, 'current.json'));
  migration.validateBaseline?.(canonical);
  const rpcUrl = overrides.rpcUrl ?? process.env[rpcEnvName(network)];
  if (!rpcUrl) throw new Error(`${rpcEnvName(network)} is required`);
  const slug = `${migration.id.toLowerCase()}-${network}`;
  return {
    migrationId: migration.id,
    network,
    rpcUrl,
    outputRoot,
    canonicalRoot,
    canonical,
    expected: migration.expectedState(canonical),
    checkpointFile: path.join(outputRoot, '.deployments', `${slug}.json`),
    receiptDirectory: path.join(outputRoot, '.deployments', `${slug}-receipts`),
    forkTest: overrides.forkTest ?? false,
  };
}

export function networkRoot(context) {
  return path.join(context.outputRoot, context.network);
}

export function historyFile(context, release) {
  return path.join(networkRoot(context), 'history', `${release}.json`);
}

export function currentFile(context) {
  return path.join(networkRoot(context), 'current.json');
}

/**
 * The checkpoint is a local, gitignored cache of in-progress state. The
 * committed history record for `release` is the durable source, so a later
 * phase can run from any machine once that record is in the tree.
 */
export async function readCheckpoint(context, release, fromHistory) {
  if (await fileExists(context.checkpointFile)) return readJson(context.checkpointFile);
  if (!release || !(await historyRecordExists(context, release))) return null;
  const checkpoint = await fromHistory(await readJson(historyFile(context, release)));
  await writeCheckpoint(context, checkpoint);
  return checkpoint;
}

export async function writeCheckpoint(context, checkpoint) {
  await writeJsonAtomic(context.checkpointFile, checkpoint);
}

/** History records are append-only: writing the same release twice is refused. */
export async function writeHistoryRecord(context, release, record) {
  await writeJsonOnce(historyFile(context, release), record);
}

export async function writeCurrent(context, current) {
  await writeJsonAtomic(currentFile(context), current);
}

export async function historyRecordExists(context, release) {
  return fileExists(historyFile(context, release));
}

/**
 * History and `current.json` are separate files written in sequence, so a crash
 * between them leaves the pointer stale. Callers reconcile each independently
 * rather than treating either one as proof the other landed.
 */
export async function currentRelease(context) {
  const file = currentFile(context);
  if (!(await fileExists(file))) return null;
  return (await readJson(file)).release ?? null;
}

export function buildReleaseRecord(context, fields) {
  return { ...fields, $schema: '../../schema.json', network: context.network, chainId: context.canonical.chainId };
}

export function applyContractAliases(current, contracts, aliases) {
  current.registryBefore ??= Object.fromEntries(
    Object.keys(aliases).map((key) => [key, current.contracts[key].address]),
  );
  for (const contract of Object.values(current.contracts)) contract.deployedInRelease = false;
  Object.assign(current.contracts, contracts);
  for (const [alias, key] of Object.entries(aliases)) current.contracts[alias] = { ...contracts[key] };
  return current;
}

export async function writeActivationRecords(context, record, current) {
  if (!(await historyRecordExists(context, record.release))) {
    await writeHistoryRecord(context, record.release, record);
  }
  if (await currentRelease(context) !== record.release) await writeCurrent(context, current);
}

/** Regenerates derived config and re-runs the ledger validator against the output root. */
export function validateArtifacts(context) {
  const env = { CONTRACT_DEPLOYMENTS_ROOT: context.outputRoot };
  if (path.resolve(context.outputRoot) === CANONICAL_DEPLOYMENTS_ROOT) {
    run('node', ['scripts/generate-contract-chain-config.mjs'], { env });
  }
  run('node', ['scripts/validate-contract-deployments.mjs'], { env });
}

/**
 * A later phase must run against the same contract code an earlier phase
 * deployed. Rather than pinning the Git commit, compare the local build with
 * the code on chain for every contract the checkpoint recorded.
 */
export async function assertCheckpointBytecode(context, checkpoint) {
  const index = await buildArtifactIndex();
  const mismatches = [];
  for (const [key, contract] of Object.entries(checkpoint.contracts ?? {})) {
    if (!contract.deployedInRelease) continue;
    const found = await findArtifact(index, key);
    if (!found) {
      mismatches.push(`${key}: no local artifact`);
      continue;
    }
    const reason = compareRuntimeCode(context.rpcUrl, contract.address, found.artifact);
    if (reason) mismatches.push(`${key} (${found.name} at ${contract.address}): ${reason}`);
  }
  if (mismatches.length) {
    throw new Error(
      `${context.migrationId} local build does not match the deployed contracts; `
      + `check out the source that produced ${checkpoint.sourceCommit} or rebuild:\n- ${mismatches.join('\n- ')}`,
    );
  }
}
