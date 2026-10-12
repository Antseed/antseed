#!/usr/bin/env node
// Backfill the canonical Chainlink BlockhashStore on Base with every block hash the wash-trading
// proofs reference, using the plan produced by plan-wash-trading-blockhash-backfill.mjs.
//
// For each planned range it walks from the Chainlink-known anchor down to the range start, calling
//   BlockhashStore.storeVerifyHeader(n, rawHeader(n + 1))
// once per block, batched through Multicall3.aggregate so one transaction carries ~150 headers.
// Chainlink verifies keccak256(header) against its stored hash(n + 1) and stores parentHash as
// hash(n); nothing AntSeed-owned sits in the verification path. The wash-trading registry is
// then deployed with WASH_TRADING_BLOCKHASH_STORE set to the Chainlink store itself.
import { readFile, writeFile } from "node:fs/promises";
import { Contract, Interface, JsonRpcProvider, Wallet, decodeRlp, getAddress, keccak256 } from "ethers";
import {
  BASE_CHAIN_ID,
  JsonRpcClient,
  mapWithConcurrency,
  normalizeHash,
  parseArguments,
  positiveInteger,
  stableDigest,
} from "./wash-trading-blockhash-backfill-lib.mjs";
import { openHeaderCache } from "./wash-trading-header-cache-lib.mjs";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
// Base's sequencer rejects raw transactions above 131,072 bytes; leave headroom for the envelope.
const MAXIMUM_TX_CALLDATA_BYTES = 124_000;
const GAS_PER_HEADER = 60_000; // measured ~36.2k; explicit limit avoids estimateGas on pipelined nonces
const GAS_BASE = 150_000;

const { value, has } = parseArguments(process.argv.slice(2));
const planPath = value("--plan");
const rpcUrl = value("--rpc-url") ?? "http://127.0.0.1:8545";
const headerCacheDirectory = value("--header-cache");
const checkpointPath = value("--checkpoint") ?? `${planPath}.chainlink-checkpoint.json`;
const batchSize = positiveInteger(value("--batch-size") ?? "150", "batch size");
const inFlightLimit = positiveInteger(value("--in-flight") ?? "1", "in-flight batch limit");
const maximumBatches = value("--maximum-batches") === null
  ? Number.POSITIVE_INFINITY
  : positiveInteger(value("--maximum-batches"), "maximum batches");
const multicallAddress = getAddress(value("--multicall") ?? MULTICALL3);
if (!planPath || !headerCacheDirectory) {
  throw new Error(
    "usage: execute-wash-trading-chainlink-backfill.mjs --plan PLAN.json --header-cache DIR --rpc-url URL [--execute --allow-live --approve-plan-digest 0x..]",
  );
}
const localRpc = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(rpcUrl);
if (has("--execute") && !localRpc && !has("--allow-live")) {
  throw new Error("live backfill requires both --execute and --allow-live");
}
if (has("--execute") && !localRpc && !process.env.BACKFILL_PRIVATE_KEY) {
  throw new Error("live backfill requires BACKFILL_PRIVATE_KEY; the public Anvil key is never used on Base");
}

const plan = JSON.parse(await readFile(planPath, "utf8"));
if (plan.version !== 2 || plan.kind !== "antseed-wash-trading-sparse-blockhash-backfill-plan") {
  throw new Error("expected a version 2 blockhash backfill plan");
}
const { digest, ...planWithoutDigest } = plan;
if (digest !== stableDigest(planWithoutDigest)) throw new Error("backfill plan digest mismatch");
const approvedDigest = value("--approve-plan-digest");
if (has("--execute") && approvedDigest !== digest) throw new Error(`execution requires --approve-plan-digest ${digest}`);
const headerCache = await openHeaderCache(headerCacheDirectory, digest);

const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
provider.pollingInterval = 1000;
const network = await provider.getNetwork();
if (network.chainId !== BASE_CHAIN_ID) throw new Error(`expected Base chain ID ${BASE_CHAIN_ID}, got ${network.chainId}`);
const signer = new Wallet(
  process.env.BACKFILL_PRIVATE_KEY ?? process.env.ANVIL_PRIVATE_KEY
    ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider,
);
const chainlinkAddress = getAddress(plan.chainlinkBlockhashStore);
const chainlinkInterface = new Interface([
  "function storeVerifyHeader(uint256 n, bytes header)",
  "function getBlockhash(uint256) view returns (bytes32)",
]);
const chainlinkStore = new Contract(chainlinkAddress, chainlinkInterface, provider);
const multicall = new Contract(
  multicallAddress,
  ["function aggregate((address target,bytes callData)[] calls) returns (uint256 blockNumber,bytes[] returnData)"],
  signer,
);
if ((await provider.getCode(multicallAddress)) === "0x") throw new Error(`no Multicall3 code at ${multicallAddress}`);
if ((await provider.getCode(chainlinkAddress)) === "0x") throw new Error(`no Chainlink store code at ${chainlinkAddress}`);

const checkpoint = (await readCheckpoint()) ?? {
  version: 3,
  kind: "antseed-wash-trading-chainlink-blockhash-backfill-checkpoint",
  planDigest: digest,
  chainlinkBlockhashStore: chainlinkAddress,
  multicall: multicallAddress,
  cursors: {},
  completedRanges: {},
  submittedBatches: 0,
  submittedBlocks: 0,
};
if (
  checkpoint.kind !== "antseed-wash-trading-chainlink-blockhash-backfill-checkpoint"
  || checkpoint.planDigest !== digest
  || getAddress(checkpoint.chainlinkBlockhashStore) !== chainlinkAddress
) {
  throw new Error("chainlink backfill checkpoint configuration mismatch");
}

let nonce = await provider.getTransactionCount(signer.address, "pending");
let submittedBatches = 0;
let submittedBlocks = 0;
let totalGasUsed = 0n;
const inFlight = [];

// Walk order: highest ranges first (matches the anchor catalog scan).
const orderedRanges = [...plan.ranges].sort((left, right) => right.endBlock - left.endBlock);
const pendingRanges = orderedRanges.filter((range) => !checkpoint.completedRanges[String(range.index)]);
const remainingHeaders = pendingRanges.reduce((sum, range) => {
  const cursor = checkpoint.cursors[String(range.index)] ?? range.endBlock;
  return sum + (cursor - range.startBlock + 1);
}, 0);
console.error(
  `chainlink backfill: ${pendingRanges.length}/${plan.ranges.length} ranges pending, ${remainingHeaders} headers remaining`,
);

// A "unit" stores hash(block) by submitting rawHeader(block + 1). Units for one range descend
// from range.endBlock (whose child is the Chainlink anchor) to range.startBlock.
let rangeCursor = 0;
let unitCursor = null; // { range, block, expectedChildHash } for the range currently being walked
while (submittedBatches < maximumBatches) {
  const units = [];
  const touched = new Map(); // range.index -> { range, lowestBlock }
  let calldataBytes = 4 + 64; // selector + array head
  while (units.length < batchSize) {
    if (unitCursor === null) {
      if (rangeCursor >= pendingRanges.length) break;
      const range = pendingRanges[rangeCursor];
      const start = checkpoint.cursors[String(range.index)] ?? range.endBlock;
      const expectedChildHash = await expectedHashFor(range, start + 1);
      unitCursor = { range, block: start, expectedChildHash };
    }
    const { range, block } = unitCursor;
    const [header] = await headerCache.readHeaders([block + 1]);
    const headerHash = normalizeHash(keccak256(header));
    if (headerHash !== unitCursor.expectedChildHash) {
      throw new Error(`block ${block + 1}: raw header does not match expected child hash (range ${range.index})`);
    }
    const decoded = decodeRlp(header);
    if (!Array.isArray(decoded) || typeof decoded[0] !== "string") throw new Error("invalid RLP block header");
    const parentHash = normalizeHash(decoded[0]);
    const required = range.requiredReferences.find((reference) => reference.number === block);
    if (required && normalizeHash(required.blockHash) !== parentHash) {
      throw new Error(`block ${block}: cached header chain disagrees with proof reference hash`);
    }
    const callData = chainlinkInterface.encodeFunctionData("storeVerifyHeader", [block, header]);
    const unitBytes = 64 + 64 + Math.ceil((callData.length - 2) / 2 / 32) * 32; // tuple head + bytes head + padded data
    if (units.length > 0 && calldataBytes + unitBytes > MAXIMUM_TX_CALLDATA_BYTES) break;
    calldataBytes += unitBytes;
    units.push({ range, block, blockHash: parentHash, callData, required: Boolean(required) });
    touched.set(range.index, { range, lowestBlock: block });
    if (block - 1 < range.startBlock) {
      unitCursor = null;
      rangeCursor += 1;
    } else {
      unitCursor = { range, block: block - 1, expectedChildHash: parentHash };
    }
  }
  if (units.length === 0) break;

  const calls = units.map((unit) => ({ target: chainlinkAddress, callData: unit.callData }));
  const gasLimit = BigInt(GAS_BASE + GAS_PER_HEADER * units.length);
  if (!has("--execute")) {
    const estimated = await multicall.aggregate.estimateGas(calls);
    console.error(
      `dry run: headers=${units.length} ranges=${touched.size} required=${units.filter((u) => u.required).length} `
      + `calldata~${calldataBytes}B estimatedGas=${estimated} (${Number(estimated) / units.length | 0}/header) gasLimit=${gasLimit}`,
    );
    process.exit(0);
  }

  const batchNonce = nonce++;
  let response;
  try {
    // Explicit gasLimit: pipelined batches may depend on hashes stored by a not-yet-mined
    // predecessor, so eth_estimateGas against "latest" would spuriously revert.
    response = await multicall.aggregate(calls, { nonce: batchNonce, gasLimit });
  } catch (error) {
    await drainInFlight();
    throw error;
  }
  submittedBatches += 1;
  submittedBlocks += units.length;
  inFlight.push({ nonce: batchNonce, response, units, touched, calldataBytes });
  if (inFlight.length >= inFlightLimit) await settleOldestInFlight();
}
await drainInFlight();

console.log(`WASH_TRADING_CHAINLINK_BACKFILL_RESULT=${JSON.stringify({
  planDigest: digest,
  chainlinkBlockhashStore: chainlinkAddress,
  multicall: multicallAddress,
  submittedBatches,
  submittedBlocks,
  totalGasUsed: totalGasUsed.toString(),
  completedRanges: Object.keys(checkpoint.completedRanges).length,
  totalRanges: plan.ranges.length,
  checkpoint: checkpointPath,
})}`);

async function expectedHashFor(range, childBlock) {
  const live = await readChainlinkHash(childBlock);
  if (live === null) {
    throw new Error(`range ${range.index}: Chainlink has no hash for block ${childBlock} (anchor ${range.anchorBlock})`);
  }
  if (childBlock === range.anchorBlock && live !== normalizeHash(range.anchorHash)) {
    throw new Error(`range ${range.index}: anchor changed`);
  }
  return live;
}

async function readChainlinkHash(blockNumber) {
  for (let attempt = 1; attempt <= 20; ++attempt) {
    try {
      return normalizeHash(await chainlinkStore.getBlockhash(blockNumber));
    } catch (error) {
      // Chainlink reverts with "blockhash not found in store" for unknown blocks: a genuine revert
      // carries revert data / a reason. Provider failures (HTTP 429, timeouts) surface as
      // CALL_EXCEPTION with no revert data and must be retried, not treated as "missing".
      const genuineRevert = error.code === "CALL_EXCEPTION" && (error.reason !== null || (error.data && error.data !== "0x"));
      if (genuineRevert) return null;
      if (attempt === 20) throw error;
      await new Promise((done) => setTimeout(done, 500 * attempt));
    }
  }
  throw new Error("unreachable Chainlink read retry state");
}

async function verifyStoredUnits(units) {
  const targets = units.filter((unit) => unit.required);
  // Always include the lowest stored block so a resumed walk can rely on it.
  const lowest = units[units.length - 1];
  if (!targets.includes(lowest)) targets.push(lowest);
  let mismatch;
  for (let attempt = 1; attempt <= 15; ++attempt) {
    let stored;
    try {
      stored = await mapWithConcurrency(targets, 6, (unit) => readChainlinkHash(unit.block));
    } catch (error) {
      console.error(`verification read failed (attempt ${attempt}): ${error.shortMessage ?? error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      continue;
    }
    mismatch = undefined;
    for (let index = 0; index < targets.length; ++index) {
      if (stored[index] !== targets[index].blockHash) {
        mismatch = targets[index];
        break;
      }
    }
    if (mismatch === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`block ${mismatch.block}: chainlink backfill verification failed`);
}

async function settleOldestInFlight() {
  const item = inFlight.shift();
  if (!item) return;
  let receipt;
  try {
    receipt = await item.response.wait();
  } catch (error) {
    throw new Error(`batch nonce ${item.nonce}: ${error.shortMessage ?? error.message}`);
  }
  if (!receipt || receipt.status !== 1) {
    throw new Error(`batch nonce ${item.nonce} reverted (tx ${item.response.hash})`);
  }
  totalGasUsed += receipt.gasUsed;
  await verifyStoredUnits(item.units);
  let completed = 0;
  for (const { range, lowestBlock } of item.touched.values()) {
    if (lowestBlock <= range.startBlock) {
      checkpoint.completedRanges[String(range.index)] = true;
      delete checkpoint.cursors[String(range.index)];
      completed += 1;
    } else {
      checkpoint.cursors[String(range.index)] = lowestBlock - 1;
    }
  }
  checkpoint.submittedBlocks += item.units.length;
  checkpoint.submittedBatches += 1;
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  console.error(
    `backfilled headers=${item.units.length} ranges=${item.touched.size} completed=${completed} `
    + `gas=${receipt.gasUsed} (${Number(receipt.gasUsed) / item.units.length | 0}/header) nonce=${item.nonce} inflight=${inFlight.length} `
    + `done=${Object.keys(checkpoint.completedRanges).length}/${plan.ranges.length}`,
  );
}

async function drainInFlight() {
  let firstError = null;
  while (inFlight.length > 0) {
    try {
      await settleOldestInFlight();
    } catch (error) {
      console.error(String(error.message ?? error));
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

async function readCheckpoint() {
  try {
    return JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}
