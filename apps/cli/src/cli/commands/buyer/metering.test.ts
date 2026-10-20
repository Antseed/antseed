import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelStore } from '@antseed/node';
import type { StoredChannel } from '@antseed/node';
import { registerBuyerMeteringCommand } from './metering.js';
import { buyerChannel, buyerCommandHarness, onChain } from './test-helpers.js';

function seedChannel(store: ChannelStore, overrides: Partial<StoredChannel> = {}): StoredChannel {
  const now = Date.now();
  const channel: StoredChannel = {
    sessionId: '0x' + 'aa'.repeat(32),
    peerId: 'test-seller-peer-id',
    role: 'buyer',
    sellerEvmAddr: '0x' + '11'.repeat(20),
    buyerEvmAddr: '0x' + '22'.repeat(20),
    nonce: 0,
    authMax: '500000',
    previousConsumption: '1000000', // repurposed as reserveMax
    tokensDelivered: '12345',
    deadline: Math.floor(now / 1000) + 3600,
    previousSessionId: '',
    requestCount: 42,
    reservedAt: now,
    settledAt: null,
    settledAmount: null,
    status: 'active',
    latestBuyerSig: null,
    latestSpendingAuthSig: null,
    latestMetadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  store.upsertChannel(channel);
  return channel;
}

test('ChannelStore returns active buyer channels for metering', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'metering-test-'));
  const store = new ChannelStore(tempDir);
  try {
    seedChannel(store);

    const channels = store.getActiveChannels('buyer');
    assert.equal(channels.length, 1);
    assert.equal(channels[0]!.peerId, 'test-seller-peer-id');
    assert.equal(channels[0]!.authMax, '500000');
    assert.equal(channels[0]!.requestCount, 42);
    assert.equal(channels[0]!.status, 'active');
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ChannelStore returns lifetime totals by peer and buyer', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'metering-test-'));
  const store = new ChannelStore(tempDir);
  try {
    const buyerAddr = '0x' + '22'.repeat(20);

    // Seed two sessions — one settled, one active
    seedChannel(store, {
      sessionId: '0x' + 'bb'.repeat(32),
      authMax: '200000',
      requestCount: 10,
      status: 'settled',
    });
    seedChannel(store, {
      sessionId: '0x' + 'cc'.repeat(32),
      authMax: '300000',
      requestCount: 15,
      status: 'active',
    });

    const totals = store.getTotalsByPeerAndBuyer('test-seller-peer-id', 'buyer', buyerAddr);
    assert.ok(totals);
    assert.equal(totals.totalSessions, 2);
    assert.equal(totals.totalRequests, 25);
    assert.equal(totals.totalAuthorizedUsdc, 500000n);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ChannelStore returns null totals for unknown peer', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'metering-test-'));
  const store = new ChannelStore(tempDir);
  try {
    const totals = store.getTotalsByPeerAndBuyer('nonexistent', 'buyer', '0x0000');
    // Should return null or zeroed totals
    assert.ok(totals === null || totals.totalSessions === 0);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('metering shows settled channels when no active ones exist', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'metering-test-'));
  const store = new ChannelStore(tempDir);
  try {
    const buyerAddr = '0x' + '22'.repeat(20);

    seedChannel(store, {
      status: 'settled',
      authMax: '750000',
      requestCount: 30,
    });

    // No active channels
    const active = store.getActiveChannels('buyer');
    assert.equal(active.length, 0);

    // But latest channel is findable
    const latest = store.getLatestChannelByPeerAndBuyer('test-seller-peer-id', 'buyer', buyerAddr);
    assert.ok(latest);
    assert.equal(latest.status, 'settled');
    assert.equal(latest.authMax, '750000');
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buyer metering lists no channel the seller settled on-chain', async (context) => {
  const harness = await buyerCommandHarness(context);
  const channelId = '0x' + 'dd'.repeat(32);
  harness.seed(buyerChannel(channelId, harness.buyer));

  const { stdout } = await harness.run(registerBuyerMeteringCommand, ['metering', '--json'], {
    [channelId]: onChain(harness.buyer, 2, 400_000n),
  });

  assert.match(stdout, /No active payment channels\./);
});
