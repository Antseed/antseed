#!/usr/bin/env node

/**
 * Proves that the code running on chain is the code in this repository.
 *
 * For every contract a release claims to have deployed, compares the runtime
 * code at its address against a local `forge build`, masking immutable slots.
 * A contract `current.json` no longer lists at that address (superseded by a
 * later release), or whose source this repository no longer has, cannot match
 * today's build; its on-chain code hash is compared with the
 * `runtimeCodeHash` its history record captured at deployment instead.
 * Requires an RPC URL per network (`BASE_MAINNET_RPC_URL`, ...); networks
 * without one are skipped.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACTS_ROOT } from './deployments/runtime/paths.mjs';
import {
  buildArtifactIndex, compareRecordedCodeHash, compareRuntimeCode, findArtifact,
} from './deployments/runtime/bytecode.mjs';
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
  const current = await readJson(path.join(deploymentsRoot, network, 'current.json'));
  for (const historyFile of (await readdir(historyDirectory)).filter((file) => file.endsWith('.json')).sort()) {
    const record = await readJson(path.join(historyDirectory, historyFile));
    for (const [key, contract] of Object.entries(record.contracts ?? {})) {
      if (contract.deployedInRelease !== true) continue;
      checked += 1;
      const live = current.contracts?.[key]?.address?.toLowerCase() === contract.address.toLowerCase();
      const found = live ? await findArtifact(artifactIndex, key) : null;
      const reason = found
        ? compareRuntimeCode(rpcUrl, contract.address, found.artifact)
        : compareRecordedCodeHash(rpcUrl, contract.address, contract.runtimeCodeHash);
      const match = found
        ? `matches ${contract.address}`
        : `${live ? 'no local source' : 'superseded'}; code hash matches the record`;
      if (reason) failures += 1;
      console.log(`[${reason ? 'FAIL' : 'ok'}] ${network}/${historyFile} ${key}: ${reason ?? match}`);
    }
  }
}

if (failures > 0) throw new Error(`${failures} contract(s) do not match the local build or their record`);
console.log(checked === 0
  ? 'No deployed-in-release contracts recorded yet; nothing to verify.'
  : `Verified runtime code for ${checked} contract(s).`);
