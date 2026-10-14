import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keccak256, verifyTypedData } from 'ethers';
import { BuyerFreeUsageManager } from '../src/payments/buyer-free-usage-manager.js';
import { SellerFreeUsageManager } from '../src/payments/seller-free-usage-manager.js';
import { ChannelStore, CHANNEL_KIND, CHANNEL_ROLE, CHANNEL_STATUS } from '../src/payments/channel-store.js';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import {
  decodeFreeUsageAck,
  decodeFreeUsageAuth,
  decodeFreeUsageOpen,
  decodeNeedFreeUsageAuth,
} from '../src/p2p/payment-codec.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { MessageType, type FreeUsageAuthPayload, type FreeUsageOpenPayload } from '../src/types/protocol.js';
import { peerIdToAddress, type PeerInfo } from '../src/types/peer.js';
import {
  FREE_USAGE_AUTH_TYPES,
  FREE_USAGE_OPEN_TYPES,
  computeFreeUsageChannelId,
  computeFreeUsageMetadataHash,
  encodeFreeUsageMetadata,
  getServiceMetadataId,
  makeFreeUsageDomain,
  signFreeUsageAuth,
} from '../src/payments/evm/signatures.js';

const CHAIN_ID = 31337;
const FREE_USAGE_ADDRESS = '0x0165878A594ca255338adfa4d48449f69242Eb8F';
const AUTH_SECS = 3600;

const buyer = identityFromPrivateKeyHex('22'.repeat(32));
const seller = identityFromPrivateKeyHex('11'.repeat(32));
const attacker = identityFromPrivateKeyHex('33'.repeat(32));

function makeConn() {
  const frames: Uint8Array[] = [];
  return {
    frames,
    conn: {
      send: vi.fn((frame: Uint8Array) => {
        frames.push(frame);
      }),
    },
  };
}

function freeUsageConfig(overrides: Partial<ConstructorParameters<typeof BuyerFreeUsageManager>[1]> = {}) {
  return {
    chainId: CHAIN_ID,
    freeUsageContractAddress: FREE_USAGE_ADDRESS,
    defaultAuthDurationSecs: AUTH_SECS,
    ...overrides,
  };
}

function sellerConfig(overrides: Partial<ConstructorParameters<typeof SellerFreeUsageManager>[1]> = {}) {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    freeUsageContractAddress: FREE_USAGE_ADDRESS,
    chainId: CHAIN_ID,
    ...overrides,
  };
}

function sellerPeer(): PeerInfo {
  return {
    peerId: seller.peerId,
    lastSeen: Date.now(),
    providers: ['openai'],
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        services: {
          'gpt-free': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        },
      },
    },
  };
}

function decodeSentFrame(frame: Uint8Array) {
  const decoded = decodeFrame(frame);
  if (!decoded) throw new Error('incomplete frame');
  return decoded.message;
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function installMockClient(manager: SellerFreeUsageManager) {
  const client = {
    open: vi.fn(async () => '0xopen'),
    record: vi.fn(async () => '0xrecord'),
    close: vi.fn(async () => '0xclose'),
    getSession: vi.fn(async () => {
      throw new Error('missing session');
    }),
  };
  (manager as any)._client = client;
  return client;
}

async function prepareOpen(buyerManager: BuyerFreeUsageManager): Promise<FreeUsageOpenPayload> {
  const buyerConn = makeConn();
  const buyerMux = new PaymentMux(buyerConn.conn as any);

  await buyerManager.prepareOpen(sellerPeer(), buyerMux);

  const openFrame = decodeSentFrame(buyerConn.frames[0]!);
  expect(openFrame.type).toBe(MessageType.FreeUsageOpen);
  return decodeFreeUsageOpen(openFrame.payload);
}

async function openSellerSession(
  sellerManager: SellerFreeUsageManager,
  openPayload: FreeUsageOpenPayload,
  sellerMux: PaymentMux,
) {
  sellerManager.handleOpen(buyer.peerId, openPayload, sellerMux);
  await vi.waitFor(() => {
    expect(sellerManager.client.open).toHaveBeenCalledOnce();
  });
}

describe('FreeUsage P2P lifecycle', () => {
  it('buyer opens and signs free usage without deposits', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);

    await buyerManager.prepareOpen(sellerPeer(), buyerMux);

    const openFrame = decodeSentFrame(buyerConn.frames[0]!);
    expect(openFrame.type).toBe(MessageType.FreeUsageOpen);
    const openPayload = decodeFreeUsageOpen(openFrame.payload);
    const expectedChannelId = computeFreeUsageChannelId(
      buyer.wallet.address,
      seller.wallet.address,
      openPayload.salt,
    );
    expect(openPayload.channelId).toBe(expectedChannelId);
    expect(verifyTypedData(
      makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
      FREE_USAGE_OPEN_TYPES,
      { channelId: openPayload.channelId, deadline: BigInt(openPayload.deadline) },
      openPayload.openSig,
    ).toLowerCase()).toBe(buyer.wallet.address.toLowerCase());

    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    buyerManager.trackRequestService('req-free-1', 'gpt-free');

    await buyerManager.handleNeedAuth(seller.peerId, {
      channelId: openPayload.channelId,
      requiredSequence: '1',
      currentAcceptedSequence: '0',
      requestId: 'req-free-1',
      inputTokens: '12',
      outputTokens: '7',
    }, buyerMux);

    const authFrame = decodeSentFrame(buyerConn.frames[1]!);
    expect(authFrame.type).toBe(MessageType.FreeUsageAuth);
    const authPayload = decodeFreeUsageAuth(authFrame.payload);
    const expectedMetadata = {
      cumulativeInputTokens: 12n,
      cumulativeOutputTokens: 7n,
      cumulativeRequestCount: 1n,
      services: [{
        serviceId: getServiceMetadataId('gpt-free'),
        cumulativeAmount: 0n,
        cumulativeInputTokens: 12n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 7n,
        cumulativeRequestCount: 1n,
      }],
    };
    expect(authPayload.metadata).toBe(encodeFreeUsageMetadata(expectedMetadata));
    expect(authPayload.metadataHash).toBe(computeFreeUsageMetadataHash(expectedMetadata));
    expect(verifyTypedData(
      makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
      FREE_USAGE_AUTH_TYPES,
      {
        channelId: authPayload.channelId,
        sequence: 1n,
        metadataHash: authPayload.metadataHash,
        deadline: BigInt(authPayload.deadline),
      },
      authPayload.usageSig,
    ).toLowerCase()).toBe(buyer.wallet.address.toLowerCase());
  });

  it('buyer can suppress per-service free usage metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-usage-no-service-meta-'));
    const store = new ChannelStore(dir);
    try {
      const buyerManager = new BuyerFreeUsageManager(
        buyer,
        freeUsageConfig({ disableMetadataV2Services: true }),
        undefined,
        store,
      );
      const buyerConn = makeConn();
      const buyerMux = new PaymentMux(buyerConn.conn as any);

      await buyerManager.prepareOpen(sellerPeer(), buyerMux);
      const openPayload = decodeFreeUsageOpen(decodeSentFrame(buyerConn.frames[0]!).payload);
      buyerManager.handleAck(seller.peerId, {
        channelId: openPayload.channelId,
        acceptedSequence: '0',
      });
      buyerManager.trackRequestService('req-free-private', 'sensitive-free-model');

      await buyerManager.handleNeedAuth(seller.peerId, {
        channelId: openPayload.channelId,
        requiredSequence: '1',
        currentAcceptedSequence: '0',
        requestId: 'req-free-private',
        inputTokens: '12',
        outputTokens: '7',
      }, buyerMux);

      const authPayload = decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[1]!).payload);
      const expectedMetadata = {
        cumulativeInputTokens: 12n,
        cumulativeOutputTokens: 7n,
        cumulativeRequestCount: 1n,
        services: [],
      };
      expect(authPayload.metadata).toBe(encodeFreeUsageMetadata(expectedMetadata));
      expect(authPayload.metadataHash).toBe(computeFreeUsageMetadataHash(expectedMetadata));
      expect(store.getServiceTotals(openPayload.channelId)).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buyer waits for free usage open ack and clears unacked sessions on timeout', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);

    await buyerManager.prepareOpen(sellerPeer(), buyerMux);
    const openPayload = decodeFreeUsageOpen(decodeSentFrame(buyerConn.frames[0]!).payload);

    const waitForAck = buyerManager.waitForOpenAck(seller.peerId, 100);
    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    await expect(waitForAck).resolves.toBeUndefined();

    const timedOutManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const timedOutConn = makeConn();
    const timedOutMux = new PaymentMux(timedOutConn.conn as any);
    await timedOutManager.prepareOpen(sellerPeer(), timedOutMux);

    await expect(timedOutManager.waitForOpenAck(seller.peerId, 1)).rejects.toThrow(/timed out waiting/);
    expect((timedOutManager as any)._sessions.size).toBe(0);
  });

  it('does not wedge buyer state when sending FreeUsageOpen fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-usage-open-send-fails-'));
    const store = new ChannelStore(dir);
    try {
      const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig(), undefined, store);
      const failingMux = new PaymentMux({
        send: vi.fn(() => {
          throw new Error('datachannel closed');
        }),
      } as any);

      await expect(buyerManager.prepareOpen(sellerPeer(), failingMux)).rejects.toThrow('datachannel closed');
      expect((buyerManager as any)._sessions.size).toBe(0);
      expect(store.getActiveChannelByPeer(seller.peerId, CHANNEL_ROLE.BUYER, CHANNEL_KIND.FREE)).toBeNull();

      const retryConn = makeConn();
      const retryMux = new PaymentMux(retryConn.conn as any);
      await buyerManager.prepareOpen(sellerPeer(), retryMux);

      expect(decodeSentFrame(retryConn.frames[0]!).type).toBe(MessageType.FreeUsageOpen);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrates the newest free usage channel after rotation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-usage-rotation-'));
    const store = new ChannelStore(dir);
    try {
      const buyerManager = new BuyerFreeUsageManager(
        buyer,
        { ...freeUsageConfig(), defaultAuthDurationSecs: 20 },
        undefined,
        store,
      );
      const buyerConn = makeConn();
      const buyerMux = new PaymentMux(buyerConn.conn as any);

      await buyerManager.prepareOpen(sellerPeer(), buyerMux);
      const firstOpen = decodeFreeUsageOpen(decodeSentFrame(buyerConn.frames[0]!).payload);
      buyerManager.handleAck(seller.peerId, {
        channelId: firstOpen.channelId,
        acceptedSequence: '0',
      });

      await buyerManager.prepareOpen(sellerPeer(), buyerMux);
      const secondOpen = decodeFreeUsageOpen(decodeSentFrame(buyerConn.frames[1]!).payload);
      buyerManager.handleAck(seller.peerId, {
        channelId: secondOpen.channelId,
        acceptedSequence: '0',
      });

      expect(store.getChannel(firstOpen.channelId)?.status).toBe(CHANNEL_STATUS.GHOST);
      expect(store.getChannel(secondOpen.channelId)?.status).toBe(CHANNEL_STATUS.ACTIVE);

      const restartedManager = new BuyerFreeUsageManager(buyer, freeUsageConfig(), undefined, store);
      expect((restartedManager as any)._sessions.get(seller.peerId).channelId).toBe(secondOpen.channelId);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists free usage accounting in the shared channel store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-usage-channel-store-'));
    const store = new ChannelStore(dir);
    try {
      const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig(), undefined, store);
      const buyerConn = makeConn();
      const buyerMux = new PaymentMux(buyerConn.conn as any);

      await buyerManager.prepareOpen(sellerPeer(), buyerMux);
      const openPayload = decodeFreeUsageOpen(decodeSentFrame(buyerConn.frames[0]!).payload);

      await buyerManager.handleNeedAuth(seller.peerId, {
        channelId: openPayload.channelId,
        requiredSequence: '1',
        currentAcceptedSequence: '0',
        requestId: 'req-free-store',
        inputTokens: '12',
        outputTokens: '7',
        service: 'gpt-free',
      }, buyerMux);

      expect(store.getActiveChannelByPeer(seller.peerId, CHANNEL_ROLE.BUYER)).toBeNull();
      const freeChannel = store.getActiveChannelByPeer(seller.peerId, CHANNEL_ROLE.BUYER, CHANNEL_KIND.FREE);
      expect(freeChannel).toMatchObject({
        sessionId: openPayload.channelId,
        channelKind: CHANNEL_KIND.FREE,
        authMax: '0',
        tokensDelivered: '12',
        previousConsumption: '7',
        requestCount: 1,
      });
      expect(freeChannel!.latestMetadata).toBe(decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[1]!).payload).metadata);

      const serviceTotals = store.getServiceTotals(openPayload.channelId);
      expect(serviceTotals).toEqual([
        expect.objectContaining({
          serviceId: getServiceMetadataId('gpt-free'),
          cumulativeAmount: '0',
          cumulativeInputTokens: '12',
          cumulativeCachedInputTokens: '0',
          cumulativeOutputTokens: '7',
          cumulativeRequestCount: '1',
        }),
      ]);

      const restartedManager = new BuyerFreeUsageManager(buyer, freeUsageConfig(), undefined, store);
      const restartedConn = makeConn();
      const restartedMux = new PaymentMux(restartedConn.conn as any);
      await restartedManager.prepareOpen(sellerPeer(), restartedMux);
      expect(restartedConn.frames).toHaveLength(0);

      restartedManager.trackRequestService('req-free-store-2', 'gpt-free');
      await restartedManager.handleNeedAuth(seller.peerId, {
        channelId: openPayload.channelId,
        requiredSequence: '2',
        currentAcceptedSequence: '1',
        requestId: 'req-free-store-2',
        inputTokens: '3',
        outputTokens: '2',
      }, restartedMux);

      const restartedAuth = decodeFreeUsageAuth(decodeSentFrame(restartedConn.frames[0]!).payload);
      expect(restartedAuth.sequence).toBe('2');
      const updatedFreeChannel = store.getActiveChannelByPeer(seller.peerId, CHANNEL_ROLE.BUYER, CHANNEL_KIND.FREE)!;
      expect(updatedFreeChannel.requestCount).toBe(2);
      expect(updatedFreeChannel.tokensDelivered).toBe('15');
      expect(updatedFreeChannel.previousConsumption).toBe('9');
      expect(store.getServiceTotals(openPayload.channelId)).toEqual([
        expect.objectContaining({
          serviceId: getServiceMetadataId('gpt-free'),
          cumulativeAmount: '0',
          cumulativeInputTokens: '15',
          cumulativeCachedInputTokens: '0',
          cumulativeOutputTokens: '9',
          cumulativeRequestCount: '2',
        }),
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not advance buyer sequence state when sending usage auth fails', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const openPayload = await prepareOpen(buyerManager);
    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    buyerManager.trackRequestService('req-free-send-fails', 'gpt-free');

    const failingMux = new PaymentMux({
      send: vi.fn(() => {
        throw new Error('datachannel closed');
      }),
    } as any);

    await expect(buyerManager.handleNeedAuth(seller.peerId, {
      channelId: openPayload.channelId,
      requiredSequence: '1',
      currentAcceptedSequence: '0',
      requestId: 'req-free-send-fails',
      inputTokens: '12',
      outputTokens: '7',
    }, failingMux)).rejects.toThrow('datachannel closed');

    const retryConn = makeConn();
    const retryMux = new PaymentMux(retryConn.conn as any);
    await buyerManager.handleNeedAuth(seller.peerId, {
      channelId: openPayload.channelId,
      requiredSequence: '1',
      currentAcceptedSequence: '0',
      requestId: 'req-free-send-fails',
      inputTokens: '12',
      outputTokens: '7',
    }, retryMux);

    const authPayload = decodeFreeUsageAuth(decodeSentFrame(retryConn.frames[0]!).payload);
    expect(authPayload.sequence).toBe('1');
    expect(authPayload.cumulativeInputTokens).toBe('12');
    expect(authPayload.cumulativeOutputTokens).toBe('7');
  });

  it('serializes concurrent buyer free usage auth requests per seller', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const openPayload = await prepareOpen(buyerManager);
    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    buyerManager.trackRequestService('req-free-concurrent-1', 'gpt-free');
    buyerManager.trackRequestService('req-free-concurrent-2', 'gpt-free');

    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);

    await Promise.all([
      buyerManager.handleNeedAuth(seller.peerId, {
        channelId: openPayload.channelId,
        requiredSequence: '1',
        currentAcceptedSequence: '0',
        requestId: 'req-free-concurrent-1',
        inputTokens: '12',
        outputTokens: '7',
      }, buyerMux),
      buyerManager.handleNeedAuth(seller.peerId, {
        channelId: openPayload.channelId,
        requiredSequence: '2',
        currentAcceptedSequence: '0',
        requestId: 'req-free-concurrent-2',
        inputTokens: '7',
        outputTokens: '3',
      }, buyerMux),
    ]);

    const authPayloads = buyerConn.frames
      .map((frame) => decodeFreeUsageAuth(decodeSentFrame(frame).payload))
      .sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence)));
    expect(authPayloads).toHaveLength(2);
    expect(authPayloads[0]).toMatchObject({
      sequence: '1',
      cumulativeInputTokens: '12',
      cumulativeOutputTokens: '7',
    });
    expect(authPayloads[1]).toMatchObject({
      sequence: '2',
      cumulativeInputTokens: '19',
      cumulativeOutputTokens: '10',
    });
    expect(authPayloads[1]!.metadata).toBe(encodeFreeUsageMetadata({
      cumulativeInputTokens: 19n,
      cumulativeOutputTokens: 10n,
      cumulativeRequestCount: 2n,
      services: [{
        serviceId: getServiceMetadataId('gpt-free'),
        cumulativeAmount: 0n,
        cumulativeInputTokens: 19n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 10n,
        cumulativeRequestCount: 2n,
      }],
    }));
  });

  it('seller verifies open, requests usage auth, and reports the buyer signature', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig({ recordBatchSize: 1 }));
    const client = installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    await openSellerSession(sellerManager, openPayload, sellerMux);

    expect(client.open).toHaveBeenCalledWith(
      seller.wallet,
      peerIdToAddress(buyer.peerId),
      openPayload.salt,
      BigInt(openPayload.deadline),
      openPayload.openSig,
    );
    const openAckFrame = decodeSentFrame(sellerConn.frames[0]!);
    expect(openAckFrame.type).toBe(MessageType.FreeUsageAck);
    expect(decodeFreeUsageAck(openAckFrame.payload)).toEqual({
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });

    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    buyerManager.trackRequestService('req-free-1', 'gpt-free');
    sellerConn.frames.length = 0;

    sellerManager.reportUsageRequest(buyer.peerId, sellerMux, {
      requestId: 'req-free-1',
      inputTokens: 12,
      outputTokens: 7,
      service: 'gpt-free',
    });

    const needFrame = decodeSentFrame(sellerConn.frames[0]!);
    expect(needFrame.type).toBe(MessageType.NeedFreeUsageAuth);
    const needPayload = decodeNeedFreeUsageAuth(needFrame.payload);
    expect(needPayload).toMatchObject({
      channelId: openPayload.channelId,
      requiredSequence: '1',
      currentAcceptedSequence: '0',
      requestId: 'req-free-1',
      inputTokens: '12',
      outputTokens: '7',
      service: 'gpt-free',
    });

    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);
    await buyerManager.handleNeedAuth(seller.peerId, needPayload, buyerMux);
    const authPayload = decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[0]!).payload);

    sellerConn.frames.length = 0;
    sellerManager.handleAuth(buyer.peerId, authPayload, sellerMux);
    await vi.waitFor(() => {
      expect(client.record).toHaveBeenCalledOnce();
    });

    expect(client.record).toHaveBeenCalledWith(
      seller.wallet,
      openPayload.channelId,
      1n,
      authPayload.metadata,
      BigInt(authPayload.deadline),
      authPayload.usageSig,
    );
    const recordAck = decodeFreeUsageAck(decodeSentFrame(sellerConn.frames[0]!).payload);
    expect(recordAck).toEqual({
      channelId: openPayload.channelId,
      acceptedSequence: '1',
    });
  });

  it('seller batches free usage records after local auth acceptance', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig({
      recordBatchSize: 2,
      recordFlushIntervalMs: 60_000,
    }));
    const client = installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    await openSellerSession(sellerManager, openPayload, sellerMux);
    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    sellerConn.frames.length = 0;

    sellerManager.reportUsageRequest(buyer.peerId, sellerMux, {
      requestId: 'req-free-batch-1',
      inputTokens: 12,
      outputTokens: 7,
      service: 'gpt-free',
    });
    buyerManager.trackRequestService('req-free-batch-1', 'gpt-free');
    await buyerManager.handleNeedAuth(
      seller.peerId,
      decodeNeedFreeUsageAuth(decodeSentFrame(sellerConn.frames[0]!).payload),
      buyerMux,
    );
    sellerConn.frames.length = 0;
    sellerManager.handleAuth(buyer.peerId, decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[0]!).payload), sellerMux);
    await flushAsync();

    expect(client.record).not.toHaveBeenCalled();
    expect(decodeFreeUsageAck(decodeSentFrame(sellerConn.frames[0]!).payload)).toEqual({
      channelId: openPayload.channelId,
      acceptedSequence: '1',
    });

    sellerConn.frames.length = 0;
    buyerConn.frames.length = 0;
    sellerManager.reportUsageRequest(buyer.peerId, sellerMux, {
      requestId: 'req-free-batch-2',
      inputTokens: 5,
      outputTokens: 3,
      service: 'gpt-free',
    });
    buyerManager.trackRequestService('req-free-batch-2', 'gpt-free');
    await buyerManager.handleNeedAuth(
      seller.peerId,
      decodeNeedFreeUsageAuth(decodeSentFrame(sellerConn.frames[0]!).payload),
      buyerMux,
    );
    const secondAuth = decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[0]!).payload);
    sellerManager.handleAuth(buyer.peerId, secondAuth, sellerMux);

    await vi.waitFor(() => {
      expect(client.record).toHaveBeenCalledOnce();
    });
    expect(client.record).toHaveBeenCalledWith(
      seller.wallet,
      openPayload.channelId,
      2n,
      secondAuth.metadata,
      BigInt(secondAuth.deadline),
      secondAuth.usageSig,
    );
  });

  it('seller stops retrying a pending free usage record once the channel has expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig({ defaultAuthDurationSecs: 2 }));
      const sellerManager = new SellerFreeUsageManager(seller, sellerConfig({ recordFlushIntervalMs: 60_000 }));
      const client = installMockClient(sellerManager);
      client.record.mockRejectedValue(new Error('execution reverted'));
      const sellerConn = makeConn();
      const sellerMux = new PaymentMux(sellerConn.conn as any);
      const buyerConn = makeConn();
      const buyerMux = new PaymentMux(buyerConn.conn as any);
      const openPayload = await prepareOpen(buyerManager);

      await openSellerSession(sellerManager, openPayload, sellerMux);
      buyerManager.handleAck(seller.peerId, {
        channelId: openPayload.channelId,
        acceptedSequence: '0',
      });
      sellerConn.frames.length = 0;

      sellerManager.reportUsageRequest(buyer.peerId, sellerMux, {
        requestId: 'req-free-expired',
        inputTokens: 12,
        outputTokens: 7,
        service: 'gpt-free',
      });
      buyerManager.trackRequestService('req-free-expired', 'gpt-free');
      await buyerManager.handleNeedAuth(
        seller.peerId,
        decodeNeedFreeUsageAuth(decodeSentFrame(sellerConn.frames[0]!).payload),
        buyerMux,
      );
      sellerManager.handleAuth(buyer.peerId, decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[0]!).payload), sellerMux);

      // The flush is clamped to the channel deadline: one attempt before it fails and is retried,
      // the retry lands after the deadline and must drop the record instead of rescheduling.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.record).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.record).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(client.record).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('seller closes the latest pending free usage record on disconnect', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig({
      recordBatchSize: 10,
      recordFlushIntervalMs: 60_000,
    }));
    const client = installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    await openSellerSession(sellerManager, openPayload, sellerMux);
    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    sellerConn.frames.length = 0;

    sellerManager.reportUsageRequest(buyer.peerId, sellerMux, {
      requestId: 'req-free-close',
      inputTokens: 12,
      outputTokens: 7,
      service: 'gpt-free',
    });
    buyerManager.trackRequestService('req-free-close', 'gpt-free');
    await buyerManager.handleNeedAuth(
      seller.peerId,
      decodeNeedFreeUsageAuth(decodeSentFrame(sellerConn.frames[0]!).payload),
      buyerMux,
    );
    const authPayload = decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[0]!).payload);
    sellerManager.handleAuth(buyer.peerId, authPayload, sellerMux);
    await flushAsync();

    expect(client.record).not.toHaveBeenCalled();
    sellerManager.onPeerDisconnect(buyer.peerId);

    await vi.waitFor(() => {
      expect(client.close).toHaveBeenCalledOnce();
    });
    expect(client.close).toHaveBeenCalledWith(
      seller.wallet,
      openPayload.channelId,
      1n,
      authPayload.metadata,
      BigInt(authPayload.deadline),
      authPayload.usageSig,
    );
    expect(client.record).not.toHaveBeenCalled();
  });

  it('seller rejects wrong channel, wrong signer, metadata mismatch, and stale sequences', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig({ recordBatchSize: 1 }));
    const client = installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    await openSellerSession(sellerManager, openPayload, sellerMux);
    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    sellerManager.reportUsageRequest(buyer.peerId, sellerMux, {
      requestId: 'req-free-1',
      inputTokens: 12,
      outputTokens: 7,
      service: 'gpt-free',
    });
    sellerConn.frames.length = 0;

    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);
    buyerManager.trackRequestService('req-free-1', 'gpt-free');
    await buyerManager.handleNeedAuth(seller.peerId, {
      channelId: openPayload.channelId,
      requiredSequence: '1',
      currentAcceptedSequence: '0',
      requestId: 'req-free-1',
      inputTokens: '12',
      outputTokens: '7',
    }, buyerMux);
    const validAuth = decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[0]!).payload);

    client.record.mockClear();
    sellerConn.frames.length = 0;
    sellerManager.handleAuth(buyer.peerId, {
      ...validAuth,
      channelId: '0x' + '44'.repeat(32),
    }, sellerMux);
    await flushAsync();
    expect(client.record).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    const metadataHashMismatch: FreeUsageAuthPayload = {
      ...validAuth,
      metadataHash: '0x' + '99'.repeat(32),
    };
    sellerManager.handleAuth(buyer.peerId, metadataHashMismatch, sellerMux);
    await flushAsync();
    expect(client.record).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    const metadata = encodeFreeUsageMetadata({
      cumulativeInputTokens: 12n,
      cumulativeOutputTokens: 7n,
      cumulativeRequestCount: 1n,
      services: [{
        serviceId: getServiceMetadataId('gpt-free'),
        cumulativeAmount: 0n,
        cumulativeInputTokens: 12n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 7n,
        cumulativeRequestCount: 1n,
      }],
    });
    const wrongSignerAuth: FreeUsageAuthPayload = {
      ...validAuth,
      metadata,
      metadataHash: keccak256(metadata),
      usageSig: await signFreeUsageAuth(
        attacker.wallet,
        makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
        {
          channelId: openPayload.channelId,
          sequence: 1n,
          metadataHash: keccak256(metadata),
          deadline: BigInt(validAuth.deadline),
        },
      ),
    };
    sellerManager.handleAuth(buyer.peerId, wrongSignerAuth, sellerMux);
    await flushAsync();
    expect(client.record).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    const mismatchedMetadata = encodeFreeUsageMetadata({
      cumulativeInputTokens: 13n,
      cumulativeOutputTokens: 7n,
      cumulativeRequestCount: 1n,
      services: [{
        serviceId: getServiceMetadataId('gpt-free'),
        cumulativeAmount: 0n,
        cumulativeInputTokens: 13n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 7n,
        cumulativeRequestCount: 1n,
      }],
    });
    const mismatchedTotalsAuth: FreeUsageAuthPayload = {
      ...validAuth,
      cumulativeInputTokens: '13',
      metadata: mismatchedMetadata,
      metadataHash: keccak256(mismatchedMetadata),
      usageSig: await signFreeUsageAuth(
        buyer.wallet,
        makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
        {
          channelId: openPayload.channelId,
          sequence: 1n,
          metadataHash: keccak256(mismatchedMetadata),
          deadline: BigInt(validAuth.deadline),
        },
      ),
    };
    sellerManager.handleAuth(buyer.peerId, mismatchedTotalsAuth, sellerMux);
    await flushAsync();
    expect(client.record).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    sellerManager.handleAuth(buyer.peerId, validAuth, sellerMux);
    await vi.waitFor(() => {
      expect(client.record).toHaveBeenCalledOnce();
    });

    client.record.mockClear();
    sellerConn.frames.length = 0;
    sellerManager.handleAuth(buyer.peerId, validAuth, sellerMux);
    await flushAsync();

    expect(client.record).not.toHaveBeenCalled();
    expect(decodeFreeUsageAck(decodeSentFrame(sellerConn.frames[0]!).payload)).toEqual({
      channelId: openPayload.channelId,
      acceptedSequence: '1',
    });
  });

  it('seller rejects FreeUsageOpen with a mismatched channel id or signer', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig());
    const client = installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    sellerManager.handleOpen(buyer.peerId, {
      ...openPayload,
      channelId: '0x' + '55'.repeat(32),
    }, sellerMux);
    await flushAsync();
    expect(client.open).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    const attackerChannelId = computeFreeUsageChannelId(
      attacker.wallet.address,
      seller.wallet.address,
      openPayload.salt,
    );
    const attackerOpenSig = await attacker.wallet.signTypedData(
      makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
      FREE_USAGE_OPEN_TYPES,
      { channelId: attackerChannelId, deadline: BigInt(openPayload.deadline) },
    );

    sellerManager.handleOpen(buyer.peerId, {
      ...openPayload,
      openSig: attackerOpenSig,
    }, sellerMux);
    await flushAsync();
    expect(client.open).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);
  });

  it('seller clears provisional free usage sessions when open fails on-chain', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig());
    const client = installMockClient(sellerManager);
    client.open.mockRejectedValueOnce(new Error('open reverted'));
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    sellerManager.handleOpen(buyer.peerId, openPayload, sellerMux);

    await vi.waitFor(() => {
      expect(client.open).toHaveBeenCalledOnce();
      expect((sellerManager as any)._sessions.size).toBe(0);
    });
    expect(sellerConn.frames).toHaveLength(0);
  });

  it('cleans up free usage sessions on peer disconnect', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig());
    installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    await openSellerSession(sellerManager, openPayload, sellerMux);
    expect((buyerManager as any)._sessions.size).toBe(1);
    expect((sellerManager as any)._sessions.size).toBe(1);
    expect((sellerManager as any)._buyerLocks.size).toBe(1);

    buyerManager.onPeerDisconnect(seller.peerId);
    sellerManager.onPeerDisconnect(buyer.peerId);

    expect((buyerManager as any)._sessions.size).toBe(0);
    expect((sellerManager as any)._sessions.size).toBe(0);
    expect((sellerManager as any)._buyerLocks.size).toBe(0);
  });
});
