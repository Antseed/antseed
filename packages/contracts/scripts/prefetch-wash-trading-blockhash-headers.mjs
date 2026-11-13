#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BASE_CHAIN_ID,
  JsonRpcClient,
  mapWithConcurrency,
  parseArguments,
  positiveInteger,
  stableDigest,
} from "./wash-trading-blockhash-backfill-lib.mjs";
import {
  buildHeaderChunkDescriptors,
  encodeRpcBlockHeader,
  uniquePlanHeaderNumbers,
  validateExistingHeaderChunk,
  writeHeaderCacheManifest,
  writeHeaderChunk,
} from "./wash-trading-header-cache-lib.mjs";

const { value } = parseArguments(process.argv.slice(2));
const planPath = value("--plan");
const rpcUrl = value("--rpc-url") ?? process.env.BASE_RPC_URL;
const cacheDirectory = resolve(value("--cache-dir") ?? "");
const chunkSize = positiveInteger(value("--chunk-size") ?? "500", "chunk size");
const rpcBatchSize = positiveInteger(value("--rpc-batch-size") ?? "50", "RPC batch size");
const concurrency = positiveInteger(value("--concurrency") ?? "4", "concurrency");
const rpcBatchDelayMs = positiveInteger(value("--rpc-batch-delay-ms") ?? "500", "RPC batch delay");
const headerMethod = value("--header-method") ?? "block";
if (headerMethod !== "block" && headerMethod !== "debug") {
  throw new Error("header method must be block or debug");
}
if (!planPath || !rpcUrl || !value("--cache-dir")) {
  throw new Error("usage: prefetch-wash-trading-blockhash-headers.mjs --plan PLAN.json --rpc-url URL --cache-dir DIR");
}

const plan = JSON.parse(await readFile(planPath, "utf8"));
const { digest, ...planWithoutDigest } = plan;
if (
  plan.version !== 2
  || plan.kind !== "antseed-wash-trading-sparse-blockhash-backfill-plan"
  || stableDigest(planWithoutDigest) !== digest
) throw new Error("invalid blockhash backfill plan");

const client = new JsonRpcClient(rpcUrl, {
  batchSize: rpcBatchSize,
  concurrency: 1,
  retries: 20,
  minimumBatchIntervalMs: rpcBatchDelayMs,
});
const chainId = BigInt(await client.request("eth_chainId", []));
if (chainId !== BASE_CHAIN_ID || Number(chainId) !== plan.chainId) throw new Error(`unexpected chain ID ${chainId}`);

const headerNumbers = uniquePlanHeaderNumbers(plan);
const descriptors = buildHeaderChunkDescriptors(headerNumbers, chunkSize);
let completed = 0;
let reused = 0;
const chunks = await mapWithConcurrency(descriptors, concurrency, async (descriptor) => {
  const existing = await validateExistingHeaderChunk(cacheDirectory, plan.digest, descriptor);
  if (existing) {
    reused += 1;
    completed += 1;
    reportProgress();
    return existing;
  }
  const headers = new Array(descriptor.blockNumbers.length);
  await client.mapBatches(
    descriptor.blockNumbers,
    (blockNumber) => ({
      method: headerMethod === "block" ? "eth_getBlockByNumber" : "debug_getRawHeader",
      params: [`0x${blockNumber.toString(16)}`],
      ...(headerMethod === "block" ? { params: [`0x${blockNumber.toString(16)}`, false] } : {}),
    }),
    async (batch, results, batchIndex) => {
      const offset = batchIndex * client.batchSize;
      for (let index = 0; index < batch.length; ++index) {
        const response = results[index];
        if (response.error) throw new Error(`${headerMethod} header ${batch[index]}: ${response.error.message}`);
        const header = headerMethod === "block"
          ? encodeRpcBlockHeader(response.result, batch[index])
          : response.result;
        if (!/^0x[0-9a-f]+$/i.test(header)) throw new Error(`invalid raw header for Base block ${batch[index]}`);
        headers[offset + index] = header;
      }
    },
  );
  const written = await writeHeaderChunk(cacheDirectory, plan.digest, descriptor, headers);
  completed += 1;
  reportProgress();
  return written;
});

const manifest = await writeHeaderCacheManifest(cacheDirectory, plan, chunks, {
  chunkSize,
  rpcBatchSize,
  rpcBatchDelayMs,
  headerMethod,
});
console.log(`WASH_TRADING_HEADER_CACHE=${JSON.stringify({
  directory: cacheDirectory,
  digest: manifest.digest,
  planDigest: plan.digest,
  headerCount: manifest.headerCount,
  chunkCount: manifest.chunkCount,
  reusedChunkCount: reused,
})}`);

function reportProgress() {
  if (completed === descriptors.length || completed % 10 === 0) {
    process.stderr.write(`header chunks ${completed}/${descriptors.length} reused=${reused}\n`);
  }
}
