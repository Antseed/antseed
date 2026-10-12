#!/usr/bin/env node

/**
 * Proves that the code running on chain is the code in this repository.
 *
 * For every contract a release claims to have deployed, compares the runtime
 * code at its address against a local `forge build`, masking immutable slots.
 * Requires an RPC URL per network (`BASE_MAINNET_RPC_URL`, ...); networks
 * without one are skipped.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACTS_ROOT } from './deployments/runtime/paths.mjs';
import { buildArtifactIndex, compareRuntimeCode, findArtifact } from './deployments/runtime/bytecode.mjs';
import { fileExists, readJson } from './deployments/runtime/fsx.mjs';
import { rpcEnvName } from './deployments/runtime/env.mjs';

const deploymentsRoot = process.env.CONTRACT_DEPLOYMENTS_ROOT
  ? path.resolve(process.env.CONTRACT_DEPLOYMENTS_ROOT)
  : path.join(CONTRACTS_ROOT, 'deployments');

const artifactIndex = await buildArtifactIndex();
const networks = (await readdir(deploymentsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort();

let failures = 0;
let checked = 0;

for (const network of networks) {
  const rpcUrl = process.env[rpcEnvName(network)];
  const historyDirectory = path.join(deploymentsRoot, network, 'history');
  if (!(await fileExists(historyDirectory))) continue;
  if (!rpcUrl) {
    console.log(`[--] ${network}: ${rpcEnvName(network)} not set; on-chain verification skipped`);
    continue;
  }
  for (const historyFile of (await readdir(historyDirectory)).filter((file) => file.endsWith('.json')).sort()) {
    const record = await readJson(path.join(historyDirectory, historyFile));
    for (const [key, contract] of Object.entries(record.contracts ?? {})) {
      if (contract.deployedInRelease !== true) continue;
      checked += 1;
      const found = await findArtifact(artifactIndex, key);
      const reason = found ? compareRuntimeCode(rpcUrl, contract.address, found.artifact) : 'no matching local artifact';
      if (reason) failures += 1;
      console.log(`[${reason ? 'FAIL' : 'ok'}] ${network}/${historyFile} ${key}: ${reason ?? `matches ${contract.address}`}`);
    }
  }
}

if (failures > 0) throw new Error(`${failures} contract(s) do not match the local build`);
console.log(checked === 0
  ? 'No deployed-in-release contracts recorded yet; nothing to verify.'
  : `Verified runtime code for ${checked} contract(s).`);
