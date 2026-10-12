#!/usr/bin/env node

/**
 * Validates every deployment record under packages/contracts/deployments.
 *
 * The shape is checked with plain assertions rather than a schema library:
 * the record format is small, owned by this repository, and read by exactly
 * this script and the chain-config generator. `schema.json` remains for editor
 * tooling and documents the same shape.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { generatedChainConfigFile, renderContractChainConfig } from './generate-contract-chain-config.mjs';
import { buildReleaseOwners } from './deployments/index.mjs';

const deploymentsRoot = process.env.CONTRACT_DEPLOYMENTS_ROOT
  ? path.resolve(process.env.CONTRACT_DEPLOYMENTS_ROOT)
  : path.resolve('packages/contracts/deployments');

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const STATUSES = new Set(['baseline', 'deployed', 'active']);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function isInt(value, minimum = 0) {
  return Number.isInteger(value) && value >= minimum;
}

function checkTransaction(transaction, at, errors) {
  const allowed = new Set(['action', 'hash', 'blockNumber', 'from', 'to']);
  for (const key of Object.keys(transaction)) if (!allowed.has(key)) errors.push(`${at}: unexpected field ${key}`);
  if (typeof transaction.action !== 'string' || !transaction.action) errors.push(`${at}.action must be a non-empty string`);
  if (!HASH.test(transaction.hash ?? '')) errors.push(`${at}.hash must be a 32-byte hex hash`);
  if (!isInt(transaction.blockNumber)) errors.push(`${at}.blockNumber must be a non-negative integer`);
  if (!ADDRESS.test(transaction.from ?? '')) errors.push(`${at}.from must be an address`);
  if (transaction.to !== null && !ADDRESS.test(transaction.to ?? '')) errors.push(`${at}.to must be an address or null`);
}

function checkContract(contract, at, errors) {
  const allowed = new Set([
    'address', 'deploymentBlock', 'transactionHash', 'runtimeCodeHash', 'version',
    'external', 'deployedInRelease', 'constructorArguments', 'owner',
  ]);
  for (const key of Object.keys(contract)) if (!allowed.has(key)) errors.push(`${at}: unexpected field ${key}`);
  if (!ADDRESS.test(contract.address ?? '')) errors.push(`${at}.address must be an address`);
  const nullable = (key, test, description) => {
    if (contract[key] !== undefined && contract[key] !== null && !test(contract[key])) {
      errors.push(`${at}.${key} must be ${description} or null`);
    }
  };
  nullable('deploymentBlock', (value) => isInt(value), 'a non-negative integer');
  nullable('transactionHash', (value) => HASH.test(value), 'a hash');
  nullable('runtimeCodeHash', (value) => HASH.test(value), 'a hash');
  nullable('version', (value) => typeof value === 'string', 'a string');
  nullable('owner', (value) => ADDRESS.test(value), 'an address');
  nullable('constructorArguments', Array.isArray, 'an array');
  for (const key of ['external', 'deployedInRelease']) {
    if (contract[key] !== undefined && typeof contract[key] !== 'boolean') errors.push(`${at}.${key} must be boolean`);
  }
  if (contract.deployedInRelease === true) {
    // A contract created by this release must carry full provenance.
    for (const key of ['deploymentBlock', 'transactionHash', 'runtimeCodeHash', 'constructorArguments']) {
      if (contract[key] === undefined || contract[key] === null) {
        errors.push(`${at}.${key} is required for a contract deployed in this release`);
      }
    }
    if (contract.owner === undefined) errors.push(`${at}.owner is required for a contract deployed in this release`);
  }
}

function addressMap(value, at, errors) {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null) return errors.push(`${at} must be an object`);
  for (const [key, address] of Object.entries(value)) {
    if (!ADDRESS.test(address ?? '')) errors.push(`${at}.${key} must be an address`);
  }
}

/** Shared record shape. Returns a list of problems (empty when valid). */
export function recordErrors(record) {
  const errors = [];
  const allowed = new Set([
    '$schema', 'network', 'chainId', 'release', 'status', 'sourceCommit', 'effectiveEpoch', 'notes',
    'transactions', 'registryBefore', 'registryAfter', 'verificationConfiguration', 'contracts',
  ]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) errors.push(`unexpected field ${key}`);
  for (const key of ['network', 'chainId', 'release', 'status', 'sourceCommit', 'transactions', 'contracts']) {
    if (!(key in record)) errors.push(`missing required field ${key}`);
  }
  if (typeof record.network !== 'string' || !record.network) errors.push('network must be a non-empty string');
  if (!isInt(record.chainId, 1)) errors.push('chainId must be a positive integer');
  if (typeof record.release !== 'string' || !record.release) errors.push('release must be a non-empty string');
  if (!STATUSES.has(record.status)) errors.push(`status must be one of ${[...STATUSES].join(', ')}`);
  if (record.sourceCommit !== null && !COMMIT.test(record.sourceCommit ?? '')) {
    errors.push('sourceCommit must be a 40-character commit hash or null');
  }
  if (record.status === 'baseline' && record.sourceCommit !== null) errors.push('baseline records never carry provenance');
  if (record.effectiveEpoch !== undefined && record.effectiveEpoch !== null && !isInt(record.effectiveEpoch)) {
    errors.push('effectiveEpoch must be a non-negative integer or null');
  }
  if (record.notes !== undefined && typeof record.notes !== 'string') errors.push('notes must be a string');
  if (!Array.isArray(record.transactions)) {
    errors.push('transactions must be an array');
  } else {
    // A record with known provenance describes a broadcast this repository executed.
    if (typeof record.sourceCommit === 'string' && record.transactions.length === 0) {
      errors.push('a record with a sourceCommit must list the transactions that produced it');
    }
    record.transactions.forEach((transaction, index) => checkTransaction(transaction, `transactions[${index}]`, errors));
  }
  addressMap(record.registryBefore, 'registryBefore', errors);
  addressMap(record.registryAfter, 'registryAfter', errors);
  if (record.verificationConfiguration !== undefined && typeof record.verificationConfiguration !== 'object') {
    errors.push('verificationConfiguration must be an object');
  }
  if (typeof record.contracts !== 'object' || record.contracts === null) {
    errors.push('contracts must be an object');
  } else {
    for (const [key, contract] of Object.entries(record.contracts)) checkContract(contract, `contracts.${key}`, errors);
  }
  return errors;
}

const releaseOwners = buildReleaseOwners();

function validateRecord(record, file) {
  const errors = [];
  if (JSON.stringify(record).includes('REPLACE_ME')) errors.push('contains an unresolved template placeholder');
  errors.push(...recordErrors(record));
  // Each migration may add invariants that apply only to the releases it owns.
  const owner = releaseOwners.get(record.release);
  if (owner?.recordErrors) errors.push(...owner.recordErrors(record));
  if (errors.length) throw new Error(`${file}:\n- ${errors.join('\n- ')}`);
}

async function validateNetwork(network) {
  const directory = path.join(deploymentsRoot, network);
  const currentFile = path.join(directory, 'current.json');
  const current = await readJson(currentFile);
  validateRecord(current, currentFile);
  if (current.network !== network) throw new Error(`${currentFile}: network does not match directory`);
  for (const pointer of ['emissions', 'staking']) {
    if (
      current.registryAfter?.[pointer]
      && current.registryAfter[pointer].toLowerCase() !== current.contracts?.[pointer]?.address?.toLowerCase()
    ) {
      throw new Error(`${currentFile}: contracts.${pointer} must match registryAfter.${pointer}`);
    }
  }

  const historyDirectory = path.join(directory, 'history');
  const historyFiles = (await readdir(historyDirectory)).filter((file) => file.endsWith('.json')).sort();
  const releases = new Set();
  for (const historyFile of historyFiles) {
    const file = path.join(historyDirectory, historyFile);
    const record = await readJson(file);
    validateRecord(record, file);
    if (record.network !== network || record.chainId !== current.chainId) {
      throw new Error(`${file}: network identity mismatch`);
    }
    if (`${record.release}.json` !== historyFile) throw new Error(`${file}: filename must match release ${record.release}`);
    if (releases.has(record.release)) throw new Error(`${file}: duplicate release ${record.release}`);
    releases.add(record.release);
  }
  if (!releases.has(current.release)) throw new Error(`${currentFile}: current release is missing from history`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const networks = (await readdir(deploymentsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  for (const network of networks) await validateNetwork(network);

  if (!process.env.CONTRACT_DEPLOYMENTS_ROOT) {
    const generated = await readFile(generatedChainConfigFile, 'utf8');
    if (generated !== await renderContractChainConfig()) {
      throw new Error(`${generatedChainConfigFile} is stale; run node scripts/generate-contract-chain-config.mjs`);
    }
  }

  console.log(`Validated contract deployment records for ${networks.join(', ')}`);
}
