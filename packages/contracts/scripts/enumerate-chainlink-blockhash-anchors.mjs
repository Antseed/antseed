#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, getAddress, keccak256 } from "ethers";
import {
  BASE_CHAIN_ID,
  DEFAULT_BLOCKHASH_STORE,
  JsonRpcClient,
  decodeAnchorBitmap,
  mapWithConcurrency,
  parseArguments,
  positiveInteger,
  positiveSafeInteger,
  stableDigest,
} from "./wash-trading-blockhash-backfill-lib.mjs";

const scannerInterface = new Interface([
  "function scan(uint256 startBlock,uint256 count) view returns (bytes bitmap,uint256 found)",
]);
const contractsDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultScannerArtifact = resolve(
  contractsDirectory,
  "out/AntseedBlockhashStoreStorageScanner.sol/AntseedBlockhashStoreStorageScanner.json",
);

const { value } = parseArguments(process.argv.slice(2));
const rpcUrl = value("--rpc-url") ?? process.env.BASE_RPC_URL;
const outputPath = value("--out");
const startBlock = positiveSafeInteger(value("--start-block"), "start block");
const endBlock = positiveSafeInteger(value("--end-block"), "end block");
const blockhashStore = getAddress(value("--blockhash-store") ?? DEFAULT_BLOCKHASH_STORE);
const concurrency = positiveInteger(value("--concurrency") ?? "4", "concurrency");
const scanSize = positiveInteger(value("--scan-size") ?? "8192", "scan size");
const scannerArtifactPath = resolve(value("--scanner-artifact") ?? defaultScannerArtifact);
if (!rpcUrl || !outputPath || startBlock > endBlock || scanSize > 8_192) {
  throw new Error(
    "usage: enumerate-chainlink-blockhash-anchors.mjs --rpc-url URL --start-block N --end-block N --out anchors.json",
  );
}

const scannerArtifact = JSON.parse(await readFile(scannerArtifactPath, "utf8").catch(() => {
  throw new Error(`missing scanner artifact ${scannerArtifactPath}; run forge build first`);
}));
const scannerRuntimeCode = scannerArtifact?.deployedBytecode?.object;
if (!/^0x[0-9a-f]+$/i.test(scannerRuntimeCode ?? "")) {
  throw new Error(`invalid deployed bytecode in ${scannerArtifactPath}`);
}

const client = new JsonRpcClient(rpcUrl, { concurrency, retries: 10 });
const chainId = BigInt(await client.request("eth_chainId", []));
if (chainId !== BASE_CHAIN_ID) throw new Error(`expected Base chain ID ${BASE_CHAIN_ID}, got ${chainId}`);
const scannedAtBlock = Number(BigInt(await client.request("eth_blockNumber", [])));
const blockTag = `0x${scannedAtBlock.toString(16)}`;

const ranges = [];
for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += scanSize) {
  ranges.push({ fromBlock, count: Math.min(scanSize, endBlock - fromBlock + 1) });
}

let completed = 0;
const scanned = await mapWithConcurrency(ranges, concurrency, async (range) => {
  const result = await client.request("eth_call", [
    {
      to: blockhashStore,
      gas: "0x1c9c380",
      data: scannerInterface.encodeFunctionData("scan", [range.fromBlock, range.count]),
    },
    blockTag,
    { [blockhashStore]: { code: scannerRuntimeCode } },
  ]);
  const [bitmap, found] = scannerInterface.decodeFunctionResult("scan", result);
  const anchorBlocks = decodeAnchorBitmap(bitmap, range.fromBlock, range.count);
  if (anchorBlocks.length !== Number(found)) throw new Error(`scanner count mismatch at Base block ${range.fromBlock}`);
  completed += 1;
  if (completed === ranges.length || completed % 50 === 0) {
    process.stderr.write(`storage scans ${completed}/${ranges.length}\n`);
  }
  return anchorBlocks;
});

const anchorBlocks = scanned.flat();
const catalogWithoutDigest = {
  version: 2,
  kind: "chainlink-blockhash-anchor-catalog",
  chainId: Number(BASE_CHAIN_ID),
  blockhashStore,
  startBlock,
  endBlock,
  scannedAtBlock,
  scanSize,
  scanCount: ranges.length,
  storageSlot: 0,
  scannerRuntimeCodeHash: keccak256(scannerRuntimeCode),
  validatedAnchorCount: anchorBlocks.length,
  anchorBlocks,
};
const catalog = { ...catalogWithoutDigest, digest: stableDigest(catalogWithoutDigest) };
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`CHAINLINK_BLOCKHASH_ANCHOR_CATALOG=${JSON.stringify({
  path: outputPath,
  digest: catalog.digest,
  scannedAtBlock,
  scanCount: ranges.length,
  validatedAnchorCount: anchorBlocks.length,
})}`);
