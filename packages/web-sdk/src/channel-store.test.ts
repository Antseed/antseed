import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { Wallet } from 'ethers';
import {
  BuyerPaymentManager,
  CHANNEL_ROLE,
  CHANNEL_STATUS,
  type BuyerPaymentConfig,
  type PaymentMux,
  type StoredChannel,
} from '@antseed/buyer-core';
import { toPeerId } from '@antseed/protocol';
import { IndexedDbChannelStore } from './channel-store.js';

const databases: string[] = [];

afterEach(async () => {
  for (const name of databases.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
});

describe('IndexedDbChannelStore', () => {
  it('atomically restores authorization and reserve recovery state', async () => {
    const databaseName = `antseed-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const first = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const channel = sampleChannel();

    await first.commitAuthorization(channel, [{
      serviceId: 'test-model',
      cumulativeAmount: 123n,
      cumulativeInputTokens: 10n,
      cumulativeCachedInputTokens: 2n,
      cumulativeOutputTokens: 4n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 2n,
      cumulativeVideoGenerations: 1n,
      cumulativeVideoSeconds: 8n,
    }]);
    await first.close();

    const restored = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const active = restored.getActiveChannelByPeerAndBuyer(
      channel.peerId,
      CHANNEL_ROLE.BUYER,
      channel.buyerEvmAddr.toLowerCase(),
    );

    expect(active).toMatchObject({
      sessionId: channel.sessionId,
      authMax: '123',
      latestSpendingAuthSig: '0xspending',
      latestMetadata: '0xmetadata',
      reserveSalt: '0xsalt',
      initialReserveAmount: '500000',
      reserveMaxAmount: '1000000',
    });
    const restoredMetadata = restored.getChannelMetadata(channel);
    expect(restoredMetadata.cumulativeOutputImages).toBe(2n);
    expect(restoredMetadata.cumulativeVideoGenerations).toBe(1n);
    expect(restoredMetadata.cumulativeVideoSeconds).toBe(8n);
    expect(restoredMetadata.services).toEqual([{
      serviceId: 'test-model',
      cumulativeAmount: 123n,
      cumulativeInputTokens: 10n,
      cumulativeCachedInputTokens: 2n,
      cumulativeOutputTokens: 4n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 2n,
      cumulativeVideoGenerations: 1n,
      cumulativeVideoSeconds: 8n,
    }]);
    await restored.close();
  });

  it('flushes ordinary status updates before closing', async () => {
    const databaseName = `antseed-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const first = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const channel = sampleChannel();
    first.upsertChannel(channel);
    first.updateChannelStatus(channel.sessionId, CHANNEL_STATUS.SETTLED, '123');
    await first.close();

    const restored = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    expect(restored.getChannel(channel.sessionId)).toMatchObject({
      status: CHANNEL_STATUS.SETTLED,
      settledAmount: '123',
    });
    await restored.close();
  });

  it('reports a queued write failure without waiting for a later flush', async () => {
    const databaseName = `antseed-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const onWriteError = vi.fn();
    const store = await IndexedDbChannelStore.open({
      databaseName,
      indexedDB,
      onWriteError,
    });
    (store as unknown as { db: IDBDatabase }).db.close();

    store.upsertChannel(sampleChannel());

    await vi.waitFor(() => expect(onWriteError).toHaveBeenCalledOnce());
    expect(onWriteError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    await expect(store.flush()).rejects.toThrow('IndexedDB channel persistence failed');
  });

  it('hydrates reserve replay context before the next manager can sign', async () => {
    const databaseName = `antseed-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const wallet = Wallet.createRandom();
    const identity = {
      wallet,
      peerId: toPeerId(wallet.address.slice(2).toLowerCase()),
    };
    const sellerPeerId = '44'.repeat(20);
    const first = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const manager = new BuyerPaymentManager(identity, paymentConfig(), first);
    const firstMux = paymentMux();
    await manager.authorizeSpending(sellerPeerId, firstMux, 1_000n);
    await first.close();

    const restored = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const recoveredManager = new BuyerPaymentManager(identity, paymentConfig(), restored);
    expect(recoveredManager.canReplayReserveAuth(sellerPeerId)).toBe(true);
    // The reserve message was sent but never acknowledged before the simulated
    // crash, so recovery must replay it instead of trusting the signed ceiling.
    expect(recoveredManager.getReserveCeiling(sellerPeerId)).toBe(0n);
    expect(recoveredManager.hasPendingReserveAuth(sellerPeerId)).toBe(true);

    const replayMux = paymentMux();
    await recoveredManager.resendReserveAuth(sellerPeerId, replayMux);
    expect(replayMux.sent).toHaveLength(1);
    expect(replayMux.sent[0]).toMatchObject({
      reserveMaxAmount: '500000',
      reserveSalt: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    await restored.close();
  });

  it('treats an on-chain initial reserve as the lost AuthAck after reload', async () => {
    const databaseName = `antseed-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const wallet = Wallet.createRandom();
    const identity = { wallet, peerId: toPeerId(wallet.address.slice(2).toLowerCase()) };
    const sellerPeerId = '45'.repeat(20);
    const first = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const manager = new BuyerPaymentManager(identity, paymentConfig(), first);
    await manager.authorizeSpending(sellerPeerId, paymentMux(), 1_000n);
    await first.close();

    const restored = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const recoveredManager = new BuyerPaymentManager(identity, paymentConfig(), restored);
    expect(recoveredManager.isLockConfirmed(sellerPeerId)).toBe(false);

    await recoveredManager.reconcileReserveAmount(sellerPeerId, 500_000n);

    expect(recoveredManager.hasPendingReserveAuth(sellerPeerId)).toBe(false);
    expect(recoveredManager.isLockConfirmed(sellerPeerId)).toBe(true);
    expect(recoveredManager.getReserveCeiling(sellerPeerId)).toBe(500_000n);
    await restored.close();
  });

  it('atomically recovers the exact top-level metadata counters that were signed', async () => {
    const databaseName = `antseed-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const wallet = Wallet.createRandom();
    const identity = { wallet, peerId: toPeerId(wallet.address.slice(2).toLowerCase()) };
    const sellerPeerId = '55'.repeat(20);
    const first = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const manager = new BuyerPaymentManager(identity, paymentConfig(), first);
    const mux = paymentMux();
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 1_000n);

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '2000',
      currentAcceptedCumulative: '1000',
      deposit: '500000',
      lastRequestCost: '1000',
      inputTokens: '10',
      outputTokens: '4',
      cachedInputTokens: '0',
      requestId: 'crash-window-request',
    }, mux);
    await first.close();

    const restored = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const recoveredManager = new BuyerPaymentManager(identity, paymentConfig(), restored);
    expect(recoveredManager.getCumulativeTokens(sellerPeerId)).toEqual({
      inputTokens: 10n,
      outputTokens: 4n,
    });
    expect(restored.getChannel(channelId)).toMatchObject({
      tokensDelivered: '10',
      previousConsumption: '4',
      requestCount: 1,
    });
    await restored.close();
  });

  it('replays an ambiguously delivered top-up without trusting it after restart', async () => {
    const databaseName = `antseed-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const wallet = Wallet.createRandom();
    const identity = { wallet, peerId: toPeerId(wallet.address.slice(2).toLowerCase()) };
    const sellerPeerId = '66'.repeat(20);
    const first = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const manager = new BuyerPaymentManager(identity, paymentConfig(), first);
    const initialMux = paymentMux();
    const channelId = await manager.authorizeSpending(sellerPeerId, initialMux, 1_000n);
    await manager.handleAuthAck(sellerPeerId, { channelId });

    const failedMux = paymentMux();
    failedMux.sendSpendingAuth = () => { throw new Error('connection closed'); };
    await expect(manager.topUpReserve(sellerPeerId, failedMux)).rejects.toThrow('connection closed');
    await first.close();

    const restored = await IndexedDbChannelStore.open({ databaseName, indexedDB });
    const recoveredManager = new BuyerPaymentManager(identity, paymentConfig(), restored);
    expect(recoveredManager.getReserveCeiling(sellerPeerId)).toBe(500_000n);
    expect(recoveredManager.hasPendingReserveAuth(sellerPeerId)).toBe(true);
    expect(recoveredManager.isLockConfirmed(sellerPeerId)).toBe(true);

    const replayMux = paymentMux();
    await recoveredManager.resendPendingReserveAuth(sellerPeerId, replayMux);
    expect(replayMux.sent[0]).toMatchObject({ reserveMaxAmount: '1000000' });
    // Top-ups do not get AuthAck from current sellers, so replay must retain
    // the recovered session acknowledgement until the chain confirms it.
    expect(recoveredManager.isLockConfirmed(sellerPeerId)).toBe(true);
    await recoveredManager.reconcileReserveAmount(sellerPeerId, 1_500_000n);
    expect(recoveredManager.hasPendingReserveAuth(sellerPeerId)).toBe(false);
    expect(recoveredManager.getReserveCeiling(sellerPeerId)).toBe(1_500_000n);
    await restored.close();
  });
});

function paymentConfig(): BuyerPaymentConfig {
  return {
    rpcUrl: '',
    depositsContractAddress: `0x${'dd'.repeat(20)}`,
    channelsContractAddress: `0x${'cc'.repeat(20)}`,
    usdcAddress: `0x${'ee'.repeat(20)}`,
    identityRegistryAddress: `0x${'ff'.repeat(20)}`,
    chainId: 31337,
    defaultAuthDurationSecs: 900,
    maxPerRequestUsdc: 100_000n,
    maxReserveAmountUsdc: 500_000n,
    dataDir: '',
  };
}

function paymentMux(): PaymentMux & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    sendSpendingAuth: (payload: Record<string, unknown>) => sent.push(payload),
  } as unknown as PaymentMux & { sent: Array<Record<string, unknown>> };
}

function sampleChannel(): StoredChannel {
  const now = Date.now();
  return {
    sessionId: `0x${'11'.repeat(32)}`,
    peerId: '22'.repeat(20),
    role: CHANNEL_ROLE.BUYER,
    sellerEvmAddr: `0x${'22'.repeat(20)}`,
    buyerEvmAddr: `0x${'33'.repeat(20)}`,
    nonce: 0,
    authMax: '123',
    deadline: Math.floor(now / 1000) + 900,
    previousSessionId: `0x${'00'.repeat(32)}`,
    previousConsumption: '4',
    tokensDelivered: '10',
    requestCount: 1,
    reservedAt: now,
    settledAt: null,
    settledAmount: null,
    status: CHANNEL_STATUS.ACTIVE,
    latestBuyerSig: '0xreserve',
    latestSpendingAuthSig: '0xspending',
    latestMetadata: '0xmetadata',
    reserveSalt: '0xsalt',
    initialReserveAmount: '500000',
    reserveMaxAmount: '1000000',
    createdAt: now,
    updatedAt: now,
  };
}
