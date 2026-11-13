import path from 'node:path';
import { CONTRACTS_ROOT } from './paths.mjs';
import { run } from './exec.mjs';
import { cast, ownerOf, transactionSucceeded } from './chain.mjs';
import { fileExists, readJson } from './fsx.mjs';

export function broadcastPath(scriptName, chainId) {
  return path.join(CONTRACTS_ROOT, 'broadcast', scriptName, String(chainId), 'run-latest.json');
}

/**
 * Foundry writes simulations (no --broadcast) under a `dry-run` directory
 * rather than alongside confirmed broadcasts.
 */
export function simulationPath(scriptName, chainId) {
  return path.join(CONTRACTS_ROOT, 'broadcast', scriptName, String(chainId), 'dry-run', 'run-latest.json');
}

export function parseHexNumber(value) {
  if (typeof value === 'number') return value;
  return Number(BigInt(value));
}

/**
 * Runs a Foundry script. `contractNames` maps Solidity contract names to
 * ledger keys so a migration never has to parse broadcast files itself.
 */
export function runForgeScript({ target, rpcUrl, broadcast, verify, etherscanApiKey, env, walletArgs = [], slow = false }) {
  const args = ['script', target, '--rpc-url', rpcUrl, '--via-ir', ...walletArgs];
  if (broadcast) {
    args.push('--broadcast', '--slow');
    // Basescan only accepts Etherscan V2 API keys; pin the version so a stale
    // Foundry default cannot fail verification after transactions were sent.
    if (verify) args.push('--verify', '--etherscan-api-key', etherscanApiKey, '--etherscan-api-version', 'v2');
  }
  run('forge', args, { cwd: CONTRACTS_ROOT, env });
}

/** Converts a Foundry broadcast file into ledger transactions and contract entries. */
export async function parseBroadcast(file, rpcUrl, contractNames) {
  const broadcast = await readJson(file);
  const receipts = new Map((broadcast.receipts ?? []).map((receipt) => [receipt.transactionHash.toLowerCase(), receipt]));
  const transactions = [];
  const contracts = {};
  for (const transaction of broadcast.transactions ?? []) {
    if (!transaction.hash) continue;
    const receipt = receipts.get(transaction.hash.toLowerCase());
    if (!receipt || receipt.status !== '0x1') continue;
    const isCreation = transaction.transactionType === 'CREATE' || transaction.transactionType === 'CREATE2';
    transactions.push({
      action: isCreation
        ? `deploy ${transaction.contractName}`
        : transaction.function ?? 'contract call',
      hash: transaction.hash,
      blockNumber: parseHexNumber(receipt.blockNumber),
      from: receipt.from,
      to: receipt.to ?? null,
    });
    const key = contractNames[transaction.contractName];
    const address = transaction.contractAddress ?? receipt.contractAddress;
    if (isCreation && key && address) {
      contracts[key] = {
        address,
        deploymentBlock: parseHexNumber(receipt.blockNumber),
        transactionHash: transaction.hash,
        runtimeCodeHash: cast(rpcUrl, ['codehash', address]),
        version: '1',
        external: false,
        deployedInRelease: true,
        constructorArguments: transaction.arguments ?? [],
        owner: ownerOf(rpcUrl, address),
      };
    }
  }
  return { transactions, contracts };
}

export function mergeBroadcast(previous, parsed) {
  const transactions = new Map(
    [...(previous.transactions ?? []), ...parsed.transactions].map((transaction) => [transaction.hash.toLowerCase(), transaction]),
  );
  return { transactions: [...transactions.values()], contracts: { ...previous.contracts, ...parsed.contracts } };
}

/** True when every hashed transaction in the broadcast file is confirmed on chain. */
export async function broadcastIsLive(file, rpcUrl) {
  if (!(await fileExists(file))) return false;
  const broadcast = await readJson(file);
  const hashed = (broadcast.transactions ?? []).filter((transaction) => transaction.hash);
  if (hashed.length === 0) return false;
  return hashed.every((transaction) => transactionSucceeded(rpcUrl, transaction.hash));
}

export async function readReceiptFile(file, action) {
  if (!(await fileExists(file))) return [];
  const receipt = await readJson(file);
  return [{
    action,
    hash: receipt.transactionHash,
    blockNumber: parseHexNumber(receipt.blockNumber),
    from: receipt.from,
    to: receipt.to,
  }];
}

export async function receiptFileIsLive(file, rpcUrl) {
  if (!(await fileExists(file))) return false;
  try {
    return transactionSucceeded(rpcUrl, (await readJson(file)).transactionHash);
  } catch {
    return false;
  }
}
