import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { encodeRlp, keccak256 } from "ethers";
import { normalizeHash, stableDigest } from "./wash-trading-blockhash-backfill-lib.mjs";

export const HEADER_CACHE_KIND = "antseed-wash-trading-header-cache";

export function encodeRpcBlockHeader(block, expectedBlockNumber = null) {
  if (block === null || typeof block !== "object") throw new Error("missing RPC block");
  const blockNumber = Number(BigInt(block.number));
  if (expectedBlockNumber !== null && blockNumber !== expectedBlockNumber) {
    throw new Error(`RPC returned block ${blockNumber}, expected ${expectedBlockNumber}`);
  }
  const fields = [
    block.parentHash,
    block.sha3Uncles,
    block.miner,
    block.stateRoot,
    block.transactionsRoot,
    block.receiptsRoot,
    block.logsBloom,
    rlpQuantity(block.difficulty),
    rlpQuantity(block.number),
    rlpQuantity(block.gasLimit),
    rlpQuantity(block.gasUsed),
    rlpQuantity(block.timestamp),
    block.extraData,
    block.mixHash,
    block.nonce,
  ];
  appendOptional(fields, block.baseFeePerGas, rlpQuantity);
  appendOptional(fields, block.withdrawalsRoot);
  appendOptional(fields, block.blobGasUsed, rlpQuantity);
  appendOptional(fields, block.excessBlobGas, rlpQuantity);
  appendOptional(fields, block.parentBeaconBlockRoot);
  appendOptional(fields, block.requestsHash);
  const header = encodeRlp(fields);
  if (normalizeHash(keccak256(header)) !== normalizeHash(block.hash)) {
    throw new Error(`reconstructed header hash mismatch for Base block ${blockNumber}`);
  }
  return header;
}

export function uniquePlanHeaderNumbers(plan) {
  const numbers = new Set();
  for (const range of plan.ranges ?? []) {
    for (let headerBlock = range.startBlock + 1; headerBlock <= range.anchorBlock; ++headerBlock) {
      numbers.add(headerBlock);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

export function buildHeaderChunkDescriptors(headerNumbers, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < headerNumbers.length; offset += chunkSize) {
    const blockNumbers = headerNumbers.slice(offset, offset + chunkSize);
    const index = chunks.length;
    chunks.push({
      index,
      file: `${String(index).padStart(6, "0")}.json`,
      firstBlock: blockNumbers[0],
      lastBlock: blockNumbers.at(-1),
      count: blockNumbers.length,
      blockNumbers,
    });
  }
  return chunks;
}

export async function writeHeaderChunk(directory, planDigest, descriptor, headers) {
  if (headers.length !== descriptor.blockNumbers.length) throw new Error("header chunk count mismatch");
  const chunkWithoutDigest = {
    version: 1,
    kind: "antseed-wash-trading-header-cache-chunk",
    planDigest,
    index: descriptor.index,
    firstBlock: descriptor.firstBlock,
    lastBlock: descriptor.lastBlock,
    blockNumbers: descriptor.blockNumbers,
    headers,
  };
  const chunk = { ...chunkWithoutDigest, digest: stableDigest(chunkWithoutDigest) };
  await mkdir(directory, { recursive: true });
  const target = join(directory, descriptor.file);
  const temporary = `${target}.partial-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(chunk)}\n`);
  await rename(temporary, target);
  return { ...descriptor, digest: chunk.digest };
}

export async function validateExistingHeaderChunk(directory, planDigest, descriptor) {
  const path = join(directory, descriptor.file);
  try {
    await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const chunk = JSON.parse(await readFile(path, "utf8"));
  validateHeaderChunk(chunk, planDigest, descriptor);
  return { ...descriptor, digest: chunk.digest };
}

export async function writeHeaderCacheManifest(directory, plan, chunks, metadata = {}) {
  const manifestWithoutDigest = {
    version: 1,
    kind: HEADER_CACHE_KIND,
    chainId: plan.chainId,
    planDigest: plan.digest,
    headerCount: chunks.reduce((total, chunk) => total + chunk.count, 0),
    chunkCount: chunks.length,
    chunks: chunks.map(({ blockNumbers: _blockNumbers, ...chunk }) => chunk),
    ...metadata,
  };
  const manifest = { ...manifestWithoutDigest, digest: stableDigest(manifestWithoutDigest) };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function openHeaderCache(directory, expectedPlanDigest, { maximumLoadedChunks = 8 } = {}) {
  const absolute = resolve(directory);
  const manifest = JSON.parse(await readFile(join(absolute, "manifest.json"), "utf8"));
  const { digest, ...manifestWithoutDigest } = manifest;
  const computedHeaderCount = Array.isArray(manifest.chunks)
    ? manifest.chunks.reduce((total, chunk) => total + chunk.count, 0)
    : -1;
  if (
    manifest.version !== 1
    || manifest.kind !== HEADER_CACHE_KIND
    || manifest.planDigest !== expectedPlanDigest
    || manifest.chunkCount !== manifest.chunks?.length
    || manifest.headerCount !== computedHeaderCount
    || stableDigest(manifestWithoutDigest) !== digest
  ) throw new Error("invalid header cache manifest");

  const loaded = new Map();
  async function loadChunk(descriptor) {
    if (loaded.has(descriptor.index)) {
      const values = loaded.get(descriptor.index);
      loaded.delete(descriptor.index);
      loaded.set(descriptor.index, values);
      return values;
    }
    const chunk = JSON.parse(await readFile(join(absolute, descriptor.file), "utf8"));
    validateHeaderChunk(chunk, expectedPlanDigest, descriptor);
    const values = new Map(chunk.blockNumbers.map((blockNumber, index) => [blockNumber, chunk.headers[index]]));
    loaded.set(descriptor.index, values);
    while (loaded.size > maximumLoadedChunks) loaded.delete(loaded.keys().next().value);
    return values;
  }

  function descriptorFor(blockNumber) {
    let low = 0;
    let high = manifest.chunks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (manifest.chunks[middle].lastBlock < blockNumber) low = middle + 1;
      else high = middle;
    }
    const descriptor = manifest.chunks[low];
    if (!descriptor || blockNumber < descriptor.firstBlock || blockNumber > descriptor.lastBlock) {
      throw new Error(`header cache does not cover Base block ${blockNumber}`);
    }
    return descriptor;
  }

  return {
    manifest,
    async readHeaders(blockNumbers) {
      const headers = [];
      for (const blockNumber of blockNumbers) {
        const descriptor = descriptorFor(blockNumber);
        const values = await loadChunk(descriptor);
        const header = values.get(blockNumber);
        if (header === undefined) throw new Error(`header cache is missing Base block ${blockNumber}`);
        headers.push(header);
      }
      return headers;
    },
  };
}

function validateHeaderChunk(chunk, planDigest, descriptor) {
  const { digest, ...chunkWithoutDigest } = chunk;
  if (
    chunk.version !== 1
    || chunk.kind !== "antseed-wash-trading-header-cache-chunk"
    || chunk.planDigest !== planDigest
    || chunk.index !== descriptor.index
    || chunk.firstBlock !== descriptor.firstBlock
    || chunk.lastBlock !== descriptor.lastBlock
    || !Array.isArray(chunk.blockNumbers)
    || !Array.isArray(chunk.headers)
    || chunk.blockNumbers.length !== descriptor.count
    || chunk.headers.length !== descriptor.count
    || (descriptor.digest !== undefined && digest !== descriptor.digest)
    || stableDigest(chunkWithoutDigest) !== digest
  ) throw new Error(`invalid header cache chunk ${descriptor.index}`);
  for (const header of chunk.headers) {
    if (!/^0x[0-9a-f]+$/i.test(header) || header.length < 72) throw new Error(`invalid raw header in chunk ${descriptor.index}`);
  }
}

function appendOptional(fields, value, transform = (item) => item) {
  if (value !== null && value !== undefined) fields.push(transform(value));
}

function rlpQuantity(value) {
  const quantity = BigInt(value);
  if (quantity === 0n) return "0x";
  let hex = quantity.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return `0x${hex}`;
}
