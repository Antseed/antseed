#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, getAddress, keccak256 } from "ethers";
import {
  BASE_CHAIN_ID,
  DEFAULT_BLOCKHASH_STORE,
  JsonRpcClient,
  buildCatalogBackfillRanges,
  clusterBlockNumbers,
  findNextStoredBlock,
  loadProductionArtifacts,
  mapWithConcurrency,
  mergeBackfillRanges,
  normalizeHash,
  parseArguments,
  positiveInteger,
  readStoredBlockhashes,
  stableDigest,
  uniqueBlockReferences,
} from "./wash-trading-blockhash-backfill-lib.mjs";

const scannerInterface = new Interface([
  "function read(uint256[] blockNumbers) view returns (bytes32[] blockHashes)",
]);
const contractsDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultScannerArtifact = resolve(
  contractsDirectory,
  "out/AntseedBlockhashStoreStorageScanner.sol/AntseedBlockhashStoreStorageScanner.json",
);

const { value } = parseArguments(process.argv.slice(2));
const artifactDirectory = value("--artifact-dir");
const rpcUrl = value("--rpc-url") ?? process.env.BASE_RPC_URL;
const outputPath = value("--out");
const anchorCatalogPath = value("--anchor-catalog");
const scannerArtifactPath = resolve(value("--scanner-artifact") ?? defaultScannerArtifact);
const chainlinkBlockhashStore = getAddress(value("--blockhash-store") ?? DEFAULT_BLOCKHASH_STORE);
const maximumClusterGap = positiveInteger(value("--maximum-cluster-gap") ?? "512", "maximum cluster gap");
const maximumAnchorSearch = positiveInteger(value("--maximum-anchor-search") ?? "250000", "maximum anchor search");
const anchorConcurrency = positiveInteger(value("--anchor-concurrency") ?? "8", "anchor concurrency");
if (!artifactDirectory || !rpcUrl || !outputPath) {
  throw new Error("usage: plan-wash-trading-blockhash-backfill.mjs --artifact-dir DIR --rpc-url URL --out PLAN.json");
}

const client = new JsonRpcClient(rpcUrl);
const chainId = BigInt(await client.request("eth_chainId", []));
if (chainId !== BASE_CHAIN_ID) throw new Error(`expected Base chain ID ${BASE_CHAIN_ID}, got ${chainId}`);
const artifacts = await loadProductionArtifacts(artifactDirectory);
const references = uniqueBlockReferences(artifacts);
const numbers = references.map((reference) => reference.number);
let anchorCatalog = null;
let scannerRuntimeCode = null;
if (anchorCatalogPath) {
  anchorCatalog = JSON.parse(await readFile(anchorCatalogPath, "utf8"));
  const { digest, ...catalogWithoutDigest } = anchorCatalog;
  if (
    anchorCatalog.version !== 2
    || anchorCatalog.kind !== "chainlink-blockhash-anchor-catalog"
    || anchorCatalog.chainId !== Number(BASE_CHAIN_ID)
    || getAddress(anchorCatalog.blockhashStore) !== chainlinkBlockhashStore
    || stableDigest(catalogWithoutDigest) !== digest
  ) throw new Error("invalid anchor catalog");
  if (anchorCatalog.startBlock > numbers[0] || anchorCatalog.endBlock <= numbers.at(-1)) {
    throw new Error("anchor catalog does not cover the required period and a later anchor");
  }
  const scannerArtifact = JSON.parse(await readFile(scannerArtifactPath, "utf8").catch(() => {
    throw new Error(`missing scanner artifact ${scannerArtifactPath}; run forge build first`);
  }));
  scannerRuntimeCode = scannerArtifact?.deployedBytecode?.object;
  if (!/^0x[0-9a-f]+$/i.test(scannerRuntimeCode ?? "") || keccak256(scannerRuntimeCode) !== anchorCatalog.scannerRuntimeCodeHash) {
    throw new Error("anchor catalog scanner bytecode does not match the local scanner artifact");
  }
}

const catalogAnchorSet = anchorCatalog === null ? null : new Set(anchorCatalog.anchorBlocks);
const coverageCandidates = catalogAnchorSet === null
  ? numbers
  : numbers.filter((number) => catalogAnchorSet.has(number));
process.stderr.write(`checking ${coverageCandidates.length}/${numbers.length} catalog-present required block hashes\n`);
const stored = anchorCatalog === null
  ? await readStoredBlockhashes(client, chainlinkBlockhashStore, coverageCandidates, (completed, total) => {
    if (completed === total || completed % 20_000 < client.batchSize) process.stderr.write(`coverage ${completed}/${total}\n`);
  })
  : await readCatalogStorageBlockhashes(
    client,
    chainlinkBlockhashStore,
    coverageCandidates,
    scannerRuntimeCode,
    `0x${anchorCatalog.scannedAtBlock.toString(16)}`,
  );
let present = 0;
let missing = 0;
const storedHashFor = (blockNumber) => catalogAnchorSet !== null && !catalogAnchorSet.has(blockNumber)
  ? null
  : stored.get(blockNumber);
for (const reference of references) {
  const storedHash = storedHashFor(reference.number);
  if (storedHash === null) missing += 1;
  else if (storedHash !== reference.blockHash) throw new Error(`stored hash mismatch for Base block ${reference.number}`);
  else present += 1;
}

const missingNumbers = references.filter((reference) => storedHashFor(reference.number) === null).map((reference) => reference.number);
const clusters = clusterBlockNumbers(missingNumbers, maximumClusterGap);
let anchored;
if (anchorCatalogPath) {
  process.stderr.write(`building exact paths from ${anchorCatalog.validatedAnchorCount} catalog anchors\n`);
  anchored = buildCatalogBackfillRanges(missingNumbers, anchorCatalog.anchorBlocks, maximumAnchorSearch);
  const uniqueAnchorBlocks = [...new Set(anchored.map((range) => range.anchorBlock))];
  const anchorHashes = await readCatalogStorageBlockhashes(
    client,
    chainlinkBlockhashStore,
    uniqueAnchorBlocks,
    scannerRuntimeCode,
    `0x${anchorCatalog.scannedAtBlock.toString(16)}`,
  );
  anchored = anchored.map((range) => {
    const anchorHash = anchorHashes.get(range.anchorBlock);
    if (anchorHash === null) throw new Error(`catalog anchor ${range.anchorBlock} is no longer stored`);
    return { ...range, anchorHash };
  });
} else {
  process.stderr.write(`finding anchors for ${clusters.length} conservative ranges\n`);
  let anchorsCompleted = 0;
  anchored = await mapWithConcurrency(clusters, anchorConcurrency, async (cluster) => {
    const anchor = await findNextStoredBlock(client, chainlinkBlockhashStore, cluster.endBlock + 1, maximumAnchorSearch);
    anchorsCompleted += 1;
    if (anchorsCompleted === clusters.length || anchorsCompleted % 25 === 0) {
      process.stderr.write(`anchors ${anchorsCompleted}/${clusters.length}\n`);
    }
    return {
      startBlock: cluster.startBlock,
      endBlock: anchor.number - 1,
      anchorBlock: anchor.number,
      anchorHash: anchor.blockHash,
      requiredReferenceCount: cluster.requiredReferenceCount,
    };
  });
}
const missingReferences = references.filter((reference) => storedHashFor(reference.number) === null);
let missingReferenceCursor = 0;
const ranges = mergeBackfillRanges(anchored).map((range, index) => {
  while (missingReferences[missingReferenceCursor]?.number < range.startBlock) missingReferenceCursor += 1;
  const requiredReferences = [];
  while (missingReferences[missingReferenceCursor]?.number <= range.endBlock) {
    requiredReferences.push(missingReferences[missingReferenceCursor]);
    missingReferenceCursor += 1;
  }
  return {
    index,
    ...range,
    requiredReferenceCount: requiredReferences.length,
    requiredReferences,
    blockCount: range.endBlock - range.startBlock + 1,
  };
});
if (missingReferenceCursor !== missingReferences.length) {
  throw new Error("not every missing required block was assigned to a backfill range");
}
const planWithoutDigest = {
  version: 2,
  // Serialized identifier; it is part of the plan digest, so it is kept stable even though the
  // plan now feeds Chainlink's BlockhashStore directly (the "sparse" walk semantics are unchanged).
  kind: "antseed-wash-trading-sparse-blockhash-backfill-plan",
  chainId: Number(BASE_CHAIN_ID),
  chainlinkBlockhashStore,
  artifacts: {
    sellerProofCount: artifacts.length,
    uniqueRequiredBlockCount: references.length,
    minimumRequiredBlock: numbers[0],
    maximumRequiredBlock: numbers.at(-1),
  },
  liveCoverage: {
    presentRequiredBlockCount: present,
    missingRequiredBlockCount: missing,
  },
  parameters: {
    maximumClusterGap,
    maximumAnchorSearch,
    conservative: anchorCatalog === null,
    anchorCatalog: anchorCatalog === null ? null : {
      path: anchorCatalogPath,
      digest: anchorCatalog.digest,
      scannedAtBlock: anchorCatalog.scannedAtBlock,
      validatedAnchorCount: anchorCatalog.validatedAnchorCount,
    },
  },
  totals: {
    clusterCount: clusters.length,
    mergedRangeCount: ranges.length,
    plannedHeaderVerificationCount: ranges.reduce((total, range) => total + range.blockCount, 0),
    plannedRequiredBlockWriteCount: missingReferences.length,
    minimumRequiredBlockStorageGas: missingReferences.length * 20_000,
  },
  ranges,
};
const plan = { ...planWithoutDigest, digest: stableDigest(planWithoutDigest) };
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(`WASH_TRADING_BLOCKHASH_BACKFILL_PLAN=${JSON.stringify({
  path: outputPath,
  digest: plan.digest,
  ...plan.liveCoverage,
  ...plan.totals,
})}`);

async function readCatalogStorageBlockhashes(client, blockhashStore, blockNumbers, runtimeCode, blockTag) {
  const batches = [];
  for (let index = 0; index < blockNumbers.length; index += 1_024) {
    batches.push(blockNumbers.slice(index, index + 1_024));
  }
  const values = new Map();
  let completed = 0;
  await mapWithConcurrency(batches, 4, async (batch) => {
    const result = await client.request("eth_call", [
      {
        to: blockhashStore,
        gas: "0x1c9c380",
        data: scannerInterface.encodeFunctionData("read", [batch]),
      },
      blockTag,
      { [blockhashStore]: { code: runtimeCode } },
    ]);
    const [blockHashes] = scannerInterface.decodeFunctionResult("read", result);
    for (let index = 0; index < batch.length; ++index) {
      const blockHash = normalizeHash(blockHashes[index]);
      values.set(batch[index], /^0x0{64}$/.test(blockHash) ? null : blockHash);
    }
    completed += batch.length;
    if (completed === blockNumbers.length || completed % 20_000 < 1_024) {
      process.stderr.write(`storage validation ${completed}/${blockNumbers.length}\n`);
    }
  });
  return values;
}
