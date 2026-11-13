import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeRlp, keccak256 } from "ethers";
import {
  buildHeaderChunkDescriptors,
  encodeRpcBlockHeader,
  openHeaderCache,
  uniquePlanHeaderNumbers,
  writeHeaderCacheManifest,
  writeHeaderChunk,
} from "./wash-trading-header-cache-lib.mjs";

test("reconstructs canonical post-Prague Base headers from standard RPC blocks", () => {
  const block = {
    parentHash: `0x${"01".repeat(32)}`,
    sha3Uncles: `0x${"02".repeat(32)}`,
    miner: `0x${"03".repeat(20)}`,
    stateRoot: `0x${"04".repeat(32)}`,
    transactionsRoot: `0x${"05".repeat(32)}`,
    receiptsRoot: `0x${"06".repeat(32)}`,
    logsBloom: `0x${"00".repeat(256)}`,
    difficulty: "0x0",
    number: "0x2a",
    gasLimit: "0x100000",
    gasUsed: "0x1234",
    timestamp: "0x65",
    extraData: "0x0102",
    mixHash: `0x${"07".repeat(32)}`,
    nonce: "0x0000000000000000",
    baseFeePerGas: "0x3b9aca00",
    withdrawalsRoot: `0x${"08".repeat(32)}`,
    blobGasUsed: "0x0",
    excessBlobGas: "0x10",
    parentBeaconBlockRoot: `0x${"09".repeat(32)}`,
    requestsHash: `0x${"0a".repeat(32)}`,
  };
  const expected = encodeRlp([
    block.parentHash, block.sha3Uncles, block.miner, block.stateRoot, block.transactionsRoot,
    block.receiptsRoot, block.logsBloom, "0x", "0x2a", "0x100000", "0x1234", "0x65",
    block.extraData, block.mixHash, block.nonce, "0x3b9aca00", block.withdrawalsRoot, "0x",
    "0x10", block.parentBeaconBlockRoot, block.requestsHash,
  ]);
  block.hash = keccak256(expected);
  assert.equal(encodeRpcBlockHeader(block, 42), expected);
});

test("deduplicates exact header paths from plan ranges", () => {
  assert.deepEqual(uniquePlanHeaderNumbers({ ranges: [
    { startBlock: 10, anchorBlock: 13 },
    { startBlock: 12, anchorBlock: 15 },
  ] }), [11, 12, 13, 14, 15]);
});

test("writes and streams digest-pinned header chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-header-cache-"));
  const plan = { chainId: 8453, digest: "0xplan" };
  const descriptors = buildHeaderChunkDescriptors([11, 12, 20], 2);
  const chunks = [
    await writeHeaderChunk(directory, plan.digest, descriptors[0], ["0x" + "11".repeat(36), "0x" + "12".repeat(36)]),
    await writeHeaderChunk(directory, plan.digest, descriptors[1], ["0x" + "20".repeat(36)]),
  ];
  const manifest = await writeHeaderCacheManifest(directory, plan, chunks, { chunkSize: 2 });
  assert.equal(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).digest, manifest.digest);
  const cache = await openHeaderCache(directory, plan.digest, { maximumLoadedChunks: 1 });
  assert.deepEqual(await cache.readHeaders([20, 11, 12]), [
    "0x" + "20".repeat(36),
    "0x" + "11".repeat(36),
    "0x" + "12".repeat(36),
  ]);

  await writeHeaderChunk(directory, plan.digest, descriptors[0], [
    "0x" + "aa".repeat(36),
    "0x" + "bb".repeat(36),
  ]);
  const replaced = await openHeaderCache(directory, plan.digest);
  await assert.rejects(replaced.readHeaders([11]), /invalid header cache chunk 0/);
});
