/**
 * Unit tests for SqliteStore.
 *
 * Uses node:test (built-in) with in-memory SQLite (':memory:').
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from './store.js';
import type { DecodedMetadataRecorded } from '@antseed/node';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<DecodedMetadataRecorded> = {}): DecodedMetadataRecorded {
  return {
    blockNumber: 1,
    txHash: '0x' + '0'.repeat(64),
    logIndex: 0,
    agentId: 1n,
    buyer: '0x' + '0'.repeat(40),
    channelId: '0x' + '1'.repeat(64),
    metadataHash: '0x' + '2'.repeat(64),
    inputTokens: 0n,
    outputTokens: 0n,
    requestCount: 0n,
    ...overrides,
  };
}

// ── SqliteStore unit tests ────────────────────────────────────────────────────

describe('SqliteStore', () => {
  // Test 1: init is idempotent
  it('init is idempotent — call twice, no throw', () => {
    const store = new SqliteStore(':memory:');
    assert.doesNotThrow(() => {
      store.init();
      store.init();
    });

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
      .sort();

    assert.deepEqual(tables, [
      'indexer_checkpoint',
      'seller_buyer_totals',
      'seller_channel_totals',
      'seller_metadata_totals',
    ]);
    store.close();
  });

  // Test 2: getCheckpoint returns null before any write
  it('getCheckpoint returns null before any write', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const result = store.getCheckpoint('base', '0xdeadbeef');
    assert.equal(result, null);
    store.close();
  });

  // Test 3: applyBatch seeds a new agent
  it('applyBatch seeds a new agent with correct deltas and analytics', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const event = makeEvent({
      agentId: 42n,
      blockNumber: 1000,
      inputTokens: 100n,
      outputTokens: 200n,
      requestCount: 5n,
    });

    store.applyBatch('base', '0xcontract', [event], 10);

    const totals = store.getSellerTotals(42);
    assert.ok(totals !== null);
    assert.equal(totals.totalInputTokens, 100n);
    assert.equal(totals.totalOutputTokens, 200n);
    assert.equal(totals.totalRequests, 5n);
    assert.equal(totals.settlementCount, 1);
    assert.equal(totals.firstSettledBlock, 1000);
    assert.equal(totals.lastSettledBlock, 1000);
    assert.equal(totals.uniqueBuyers, 1);
    assert.equal(totals.uniqueChannels, 1);
    assert.equal(totals.avgRequestsPerBuyer, 5);
    assert.equal(totals.avgRequestsPerChannel, 5);
    store.close();
  });

  // Test 4: applyBatch accumulates across batches, BigInt correctness
  it('applyBatch accumulates across batches — BigInt correctness with large numbers', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const large = 10n ** 20n;

    const event1 = makeEvent({
      agentId: 7n,
      inputTokens: large,
      outputTokens: large * 2n,
      requestCount: large * 3n,
    });

    const event2 = makeEvent({
      agentId: 7n,
      inputTokens: large,
      outputTokens: large,
      requestCount: 1n,
    });

    store.applyBatch('base', '0xcontract', [event1], 5);
    store.applyBatch('base', '0xcontract', [event2], 10);

    const totals = store.getSellerTotals(7);
    assert.ok(totals !== null);
    assert.equal(totals.totalInputTokens, large * 2n);
    assert.equal(totals.totalOutputTokens, large * 3n);
    assert.equal(totals.totalRequests, large * 3n + 1n);
    store.close();
  });

  // Test 5: applyBatch advances the checkpoint
  it('applyBatch advances the checkpoint', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    store.applyBatch('base', '0xcontract', [], 999);

    const checkpoint = store.getCheckpoint('base', '0xcontract');
    assert.equal(checkpoint, 999);
    store.close();
  });

  // Test 6: applyBatch rollback on mid-batch throw
  it('applyBatch rolls back atomically on error — checkpoint and prior agents unchanged', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    // Establish baseline: agent 1 has data, checkpoint at block 5
    const baseline = makeEvent({ agentId: 1n, inputTokens: 50n, outputTokens: 50n, requestCount: 1n });
    store.applyBatch('base', '0xcontract', [baseline], 5);

    // Verify baseline
    const beforeTotals = store.getSellerTotals(1);
    assert.ok(beforeTotals !== null);
    assert.equal(beforeTotals.totalInputTokens, 50n);

    // Now attempt a batch where the second event has a malformed field (string instead of bigint)
    // This will throw during BigInt arithmetic, rolling back the whole transaction.
    const goodEvent = makeEvent({ agentId: 2n, inputTokens: 100n, outputTokens: 100n, requestCount: 1n });
    const badEvent = makeEvent({ agentId: 3n, inputTokens: null as unknown as bigint });

    assert.throws(() => {
      store.applyBatch('base', '0xcontract', [goodEvent, badEvent], 99);
    });

    // Checkpoint should still be 5, not 99
    assert.equal(store.getCheckpoint('base', '0xcontract'), 5);

    // Agent 1 should be unchanged
    const afterTotals = store.getSellerTotals(1);
    assert.ok(afterTotals !== null);
    assert.equal(afterTotals.totalInputTokens, 50n);

    // Agent 2 should NOT have been written (rolled back)
    assert.equal(store.getSellerTotals(2), null);

    store.close();
  });

  // Test 7: Two different (chainId, contractAddress) checkpoints coexist
  it('two different (chainId, contractAddress) checkpoints coexist independently', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    store.applyBatch('chain-a', '0xaaa', [], 100);
    store.applyBatch('chain-b', '0xbbb', [], 200);

    assert.equal(store.getCheckpoint('chain-a', '0xaaa'), 100);
    assert.equal(store.getCheckpoint('chain-b', '0xbbb'), 200);

    // Advance one without affecting the other
    store.applyBatch('chain-a', '0xaaa', [], 150);
    assert.equal(store.getCheckpoint('chain-a', '0xaaa'), 150);
    assert.equal(store.getCheckpoint('chain-b', '0xbbb'), 200);

    store.close();
  });

  // Test: unique buyers and channels counted across multiple events
  it('tracks unique buyers and channels per agent', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const buyerA = '0x' + 'a'.repeat(40);
    const buyerB = '0x' + 'b'.repeat(40);
    const channel1 = '0x' + '1'.repeat(64);
    const channel2 = '0x' + '2'.repeat(64);
    const channel3 = '0x' + '3'.repeat(64);

    store.applyBatch(
      'base',
      '0xcontract',
      [
        makeEvent({ agentId: 5n, buyer: buyerA, channelId: channel1, blockNumber: 10, requestCount: 3n }),
        makeEvent({ agentId: 5n, buyer: buyerA, channelId: channel2, blockNumber: 11, requestCount: 4n }),
        makeEvent({ agentId: 5n, buyer: buyerB, channelId: channel3, blockNumber: 12, requestCount: 5n }),
        // Repeat on channel1 — must NOT increase uniqueChannels
        makeEvent({ agentId: 5n, buyer: buyerA, channelId: channel1, blockNumber: 13, requestCount: 8n }),
      ],
      20,
    );

    const totals = store.getSellerTotals(5);
    assert.ok(totals !== null);
    assert.equal(totals.totalRequests, 20n);
    assert.equal(totals.settlementCount, 4);
    assert.equal(totals.uniqueBuyers, 2);
    assert.equal(totals.uniqueChannels, 3);
    assert.equal(totals.firstSettledBlock, 10);
    assert.equal(totals.lastSettledBlock, 13);
    assert.equal(totals.avgRequestsPerBuyer, 10); // 20 / 2
    assert.equal(totals.avgRequestsPerChannel, 6); // 20 / 3 → BigInt floor div
    store.close();
  });

  // Test: first_settled_block is set only on first insert, last_settled_block always advances
  it('first_settled_block is stable across batches, last_settled_block advances', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    store.applyBatch(
      'base',
      '0xcontract',
      [makeEvent({ agentId: 9n, blockNumber: 500, requestCount: 1n })],
      500,
    );

    const after1 = store.getSellerTotals(9);
    assert.ok(after1 !== null);
    assert.equal(after1.firstSettledBlock, 500);
    assert.equal(after1.lastSettledBlock, 500);

    store.applyBatch(
      'base',
      '0xcontract',
      [makeEvent({ agentId: 9n, blockNumber: 750, requestCount: 1n })],
      750,
    );

    const after2 = store.getSellerTotals(9);
    assert.ok(after2 !== null);
    assert.equal(after2.firstSettledBlock, 500);
    assert.equal(after2.lastSettledBlock, 750);
    assert.equal(after2.settlementCount, 2);
    store.close();
  });

  // Test: Checkpoint key is case-insensitive on contract_address
  it('checkpoint contract_address key is case-insensitive', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    store.applyBatch('chain', '0xAbC', [], 42);

    // Both lookups should return the same value regardless of case
    const lower = store.getCheckpoint('chain', '0xabc');
    const upper = store.getCheckpoint('chain', '0xABC');
    const mixed = store.getCheckpoint('chain', '0xAbC');

    assert.equal(lower, 42);
    assert.equal(upper, 42);
    assert.equal(mixed, 42);

    store.close();
  });
});

