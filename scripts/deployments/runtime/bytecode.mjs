import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACTS_ROOT } from './paths.mjs';
import { cast } from './chain.mjs';
import { readJson } from './fsx.mjs';

/**
 * Compares the runtime code deployed on chain with a local `forge build`.
 *
 * Immutable variables are written into the runtime code at deployment, so the
 * local artifact (zeros in those slots) never hashes equal to the on-chain code.
 * Both sides are masked with the artifact's `immutableReferences` before
 * comparison. Reproducibility also depends on `bytecode_hash = "none"` and
 * `cbor_metadata = false` in foundry.toml.
 */

const artifactsRoot = path.join(CONTRACTS_ROOT, 'out');

/** Maps Solidity contract names to artifact files. */
export async function buildArtifactIndex() {
  const index = new Map();
  for (const entry of await readdir(artifactsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.sol')) continue;
    for (const file of await readdir(path.join(artifactsRoot, entry.name))) {
      if (file.endsWith('.json')) index.set(file.replace(/\.json$/, ''), path.join(artifactsRoot, entry.name, file));
    }
  }
  if (index.size === 0) throw new Error('No Foundry artifacts found; run `forge build` in packages/contracts first');
  return index;
}

/** Ledger keys are camelCase; Solidity artifacts are PascalCase file names. */
export function candidateContractNames(ledgerKey) {
  const pascal = ledgerKey.charAt(0).toUpperCase() + ledgerKey.slice(1);
  return [`Antseed${pascal}`, pascal, ledgerKey];
}

export async function findArtifact(index, ledgerKey) {
  for (const name of candidateContractNames(ledgerKey)) {
    const file = index.get(name);
    if (!file) continue;
    const artifact = await readJson(file);
    const object = artifact.deployedBytecode?.object;
    if (object && object !== '0x') return { name, artifact };
  }
  return null;
}

function maskImmutables(hex, immutableReferences) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  for (const references of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of references) bytes.fill(0, start, start + length);
  }
  return bytes;
}

/**
 * Returns null when the on-chain code matches the artifact, otherwise a
 * human-readable reason.
 */
export function compareRuntimeCode(rpcUrl, address, artifact) {
  const onChain = cast(rpcUrl, ['code', address]);
  if (onChain === '0x') return `no code at ${address}`;
  const local = maskImmutables(artifact.deployedBytecode.object, artifact.deployedBytecode.immutableReferences);
  const deployed = maskImmutables(onChain, artifact.deployedBytecode.immutableReferences);
  if (local.length !== deployed.length) return `runtime code length ${deployed.length} != local ${local.length}`;
  if (!local.equals(deployed)) return 'runtime code differs from the local build (immutables masked)';
  return null;
}
