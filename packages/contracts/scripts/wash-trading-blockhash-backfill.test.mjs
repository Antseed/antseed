import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCatalogBackfillRanges,
  clusterBlockNumbers,
  decodeAnchorBitmap,
  findNextCatalogAnchor,
  isMissingBlockhashError,
  mergeBackfillRanges,
  normalizeHash,
  positiveInteger,
  stableDigest,
  uniqueBlockReferences,
} from "./wash-trading-blockhash-backfill-lib.mjs";

const hash = (nibble) => `0x${nibble.repeat(64)}`;

test("deduplicates and sorts authenticated block references", () => {
  const artifacts = [
    {
      blockAuthenticationChunks: [
        { references: [{ number: 30, blockHash: hash("a") }, { number: 10, blockHash: hash("b") }] },
      ],
    },
    {
      blockAuthenticationChunks: [
        { references: [{ number: 10, blockHash: hash("B") }, { number: 20, blockHash: hash("c") }] },
      ],
    },
  ];

  assert.deepEqual(uniqueBlockReferences(artifacts), [
    { number: 10, blockHash: hash("b") },
    { number: 20, blockHash: hash("c") },
    { number: 30, blockHash: hash("a") },
  ]);
});

test("rejects conflicting hashes for one Base block", () => {
  const artifacts = [{
    blockAuthenticationChunks: [{
      references: [
        { number: 10, blockHash: hash("a") },
        { number: 10, blockHash: hash("b") },
      ],
    }],
  }];

  assert.throws(() => uniqueBlockReferences(artifacts), /conflicting hash for Base block 10/);
});

test("clusters only across gaps within the configured bound", () => {
  assert.deepEqual(clusterBlockNumbers([10, 11, 14, 40], 3), [
    { startBlock: 10, endBlock: 14, requiredReferenceCount: 3 },
    { startBlock: 40, endBlock: 40, requiredReferenceCount: 1 },
  ]);
  assert.deepEqual(clusterBlockNumbers([], 3), []);
});

test("merges adjacent backfill ranges under the highest anchor", () => {
  assert.deepEqual(mergeBackfillRanges([
    { startBlock: 21, endBlock: 30, anchorBlock: 31, anchorHash: hash("d"), requiredReferenceCount: 3 },
    { startBlock: 40, endBlock: 42, anchorBlock: 43, anchorHash: hash("e"), requiredReferenceCount: 1 },
    { startBlock: 10, endBlock: 20, anchorBlock: 21, anchorHash: hash("c"), requiredReferenceCount: 2 },
  ]), [
    { startBlock: 10, endBlock: 30, anchorBlock: 31, anchorHash: hash("d"), requiredReferenceCount: 5 },
    { startBlock: 40, endBlock: 42, anchorBlock: 43, anchorHash: hash("e"), requiredReferenceCount: 1 },
  ]);
});

test("decodes storage scanner bitmaps", () => {
  assert.deepEqual(decodeAnchorBitmap("0x8501", 100, 10), [100, 102, 107, 108]);
  assert.throws(() => decodeAnchorBitmap("0x01", 100, 9), /length mismatch/);
});

test("builds the exact union of nearest-anchor paths", () => {
  const anchors = [15, 22, 40];
  assert.equal(findNextCatalogAnchor(anchors, 13, 10), 15);
  assert.deepEqual(buildCatalogBackfillRanges([10, 12, 16, 21, 30], anchors, 20), [
    { startBlock: 10, endBlock: 14, anchorBlock: 15, requiredReferenceCount: 2 },
    { startBlock: 16, endBlock: 21, anchorBlock: 22, requiredReferenceCount: 2 },
    { startBlock: 30, endBlock: 39, anchorBlock: 40, requiredReferenceCount: 1 },
  ]);
  assert.throws(() => findNextCatalogAnchor(anchors, 23, 5), /no catalog anchor/);
});

test("pins plan approval to deterministic serialized content", () => {
  const plan = { version: 1, ranges: [{ startBlock: 10, endBlock: 20 }], live: false };
  assert.equal(stableDigest(plan), "0x829cf5a231653587c5c5efc917652e00367f255b71d51d2109cbd1527cadb609");
  assert.notEqual(stableDigest({ ...plan, live: true }), stableDigest(plan));
});

test("validates numeric and bytes32 inputs", () => {
  assert.equal(positiveInteger("200", "batch size"), 200);
  assert.throws(() => positiveInteger("0", "batch size"), /must be a positive integer/);
  assert.equal(normalizeHash(hash("A")), hash("a"));
  assert.throws(() => normalizeHash("0x1234"), /invalid bytes32/);
});

test("distinguishes missing blockhash reverts from transient RPC failures", () => {
  assert.equal(isMissingBlockhashError({ code: 3, message: "execution reverted: blockhash not found in store" }), true);
  assert.equal(isMissingBlockhashError({ code: -32005, message: "compute units per second capacity exceeded" }), false);
  assert.equal(isMissingBlockhashError(null), false);
});
