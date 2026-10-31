import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { Wallet } from 'ethers';
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  ConnectionState,
  type PeerMetadata,
} from '@antseed/protocol';
import { CHANNEL_ROLE, CHANNEL_STATUS } from '@antseed/buyer-core';
import { AntseedWebClient, SellerSession, sellerSummaryFromMetadata } from './client.js';
import { SellerConnection } from './connection.js';
import { MemoryChannelStore } from './channel-store.js';
import {
  BuyerAlreadyActiveError,
  type WebLockLike,
  type WebLockManagerLike,
} from './tab-lock.js';

afterEach(() => vi.restoreAllMocks());

describe('AntseedWebClient.create', () => {
  it('fails a second tab closed and permits takeover after close', async () => {
    const locks = new FakeLockManager();
    const wallet = Wallet.createRandom();
    const databaseName = `antseed-client-${crypto.randomUUID()}`;
    const options = {
      relayUrl: 'http://relay.invalid',
      wallet,
      payment: { rpcUrl: '' },
      persistence: { databaseName, indexedDB, locks },
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    };

    const first = await AntseedWebClient.create(options);
    await expect(AntseedWebClient.create(options)).rejects.toBeInstanceOf(
      BuyerAlreadyActiveError,
    );
    await first.close();

    const successor = await AntseedWebClient.create(options);
    expect(successor.peerId).toBe(wallet.address.slice(2).toLowerCase());
    await successor.close();
    await deleteDatabase(databaseName);
  });

  it('single-flights concurrent connection attempts to one seller', async () => {
    const connection = {
      isOpen: true,
      state: ConnectionState.Open,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      onFrame: () => {},
      onClose: () => {},
    } as unknown as SellerConnection;
    const connect = vi.spyOn(SellerConnection, 'connect').mockResolvedValue(connection);
    const client = AntseedWebClient.ephemeral({
      relayUrl: 'http://relay.invalid',
      wallet: Wallet.createRandom(),
      payment: { rpcUrl: '' },
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    });
    const peerId = '77'.repeat(20);

    const [first, second] = await Promise.all([
      client.connect(peerId),
      client.connect(peerId),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(first.peer.peerId).toBe(second.peer.peerId);
    await client.close();
  });

  it('returns static sellers while ignoring a stale DHT snapshot', async () => {
    const staticPeerId = '66'.repeat(20);
    const stalePeerId = '55'.repeat(20);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      peers: [{
        peerId: stalePeerId,
        version: 12,
        region: 'global',
        timestamp: Date.now() - 60_000,
        signature: '0xsig',
        capabilities: [],
        providers: [],
      }],
      static: [{ peerId: staticPeerId, host: 'static.example', port: 8917 }],
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    }), { status: 200 }));
    const client = AntseedWebClient.ephemeral({
      relayUrl: 'http://relay.invalid',
      wallet: Wallet.createRandom(),
      payment: { rpcUrl: '' },
      maxSellerSnapshotAgeMs: 1_000,
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    });

    await expect(client.sellers()).resolves.toEqual([{
      peerId: staticPeerId,
      providers: [],
      publicAddress: 'static.example:8917',
    }]);
    await client.close();
  });

  it('replaces the payment mux when reconnecting a stale transport', async () => {
    const oldConnection = mockConnection(true);
    const newConnection = mockConnection(true);
    vi.spyOn(SellerConnection, 'connect')
      .mockResolvedValueOnce(oldConnection.connection)
      .mockResolvedValueOnce(newConnection.connection);
    const client = AntseedWebClient.ephemeral({
      relayUrl: 'http://relay.invalid',
      wallet: Wallet.createRandom(),
      payment: { rpcUrl: '' },
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    });
    const peerId = '79'.repeat(20);

    await client.connect(peerId);
    const firstMux = client.negotiator.getPaymentMux(peerId);
    oldConnection.state.isOpen = false;
    await client.connect(peerId);

    expect(oldConnection.state.close).toHaveBeenCalledOnce();
    expect(client.negotiator.getPaymentMux(peerId)).not.toBe(firstMux);
    await client.close();
  });

  it('recovers a pending reserve before the first browser request is sent', async () => {
    const connection = {
      isOpen: true,
      state: ConnectionState.Open,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      onFrame: () => {},
      onClose: () => {},
    } as unknown as SellerConnection;
    vi.spyOn(SellerConnection, 'connect').mockResolvedValue(connection);
    const client = AntseedWebClient.ephemeral({
      relayUrl: 'http://relay.invalid',
      wallet: Wallet.createRandom(),
      payment: { rpcUrl: '' },
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    });
    const peerId = '78'.repeat(20);
    const recoveryError = new Error('pending reserve reconciliation failed');
    const recover = vi.spyOn(client.negotiator, 'recoverPendingReserveBeforeRequest')
      .mockRejectedValue(recoveryError);

    await expect(client.sendRequest({ peerId }, {
      requestId: 'recover-before-request',
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: new Uint8Array(),
    })).rejects.toBe(recoveryError);

    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({ peerId }),
      connection,
    );
    expect(connection.send).not.toHaveBeenCalled();
    await client.close();
  });

  it('closes a transport that finishes opening after the client closes', async () => {
    const connection = {
      isOpen: true,
      state: ConnectionState.Open,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      onFrame: () => {},
      onClose: () => {},
    } as unknown as SellerConnection;
    let resolveConnect!: (value: SellerConnection) => void;
    vi.spyOn(SellerConnection, 'connect').mockReturnValue(new Promise((resolve) => {
      resolveConnect = resolve;
    }));
    const client = AntseedWebClient.ephemeral({
      relayUrl: 'http://relay.invalid',
      wallet: Wallet.createRandom(),
      payment: { rpcUrl: '' },
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    });

    const opening = client.connect('88'.repeat(20));
    const rejected = expect(opening).rejects.toThrow('AntseedWebClient is closed');
    await client.close();
    resolveConnect(connection);
    await rejected;
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('drains in-flight payment authorization before cleanup and storage close', async () => {
    const store = new MemoryChannelStore();
    const flush = vi.spyOn(store, 'flush');
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const client = AntseedWebClient.ephemeral({
      relayUrl: 'http://relay.invalid',
      wallet: Wallet.createRandom(),
      payment: { rpcUrl: '' },
      channelStore: store,
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    });
    const drain = vi.spyOn(client.negotiator, 'drainPendingNeedAuth')
      .mockReturnValue(drainGate);
    const cleanup = vi.spyOn(client.negotiator, 'cleanup');

    const closing = client.close();
    await Promise.resolve();

    expect(drain).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();

    releaseDrain();
    await closing;

    expect(cleanup).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
  });

  it('exposes the generic operator fallback for unresolved channels', async () => {
    const wallet = Wallet.createRandom();
    const store = new MemoryChannelStore();
    const now = Date.now();
    const channelId = `0x${'11'.repeat(32)}`;
    store.upsertChannel({
      sessionId: channelId,
      peerId: '99'.repeat(20),
      role: CHANNEL_ROLE.BUYER,
      sellerEvmAddr: `0x${'99'.repeat(20)}`,
      buyerEvmAddr: wallet.address,
      nonce: 0,
      authMax: '0',
      deadline: Math.floor(now / 1000) + 900,
      previousSessionId: `0x${'00'.repeat(32)}`,
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: null,
      latestSpendingAuthSig: null,
      latestMetadata: null,
      createdAt: now,
      updatedAt: now,
    });
    const channelsClient = {
      requestClose: vi.fn().mockResolvedValue('0xrequest'),
      withdraw: vi.fn().mockResolvedValue('0xwithdraw'),
    };
    const client = AntseedWebClient.ephemeral({
      relayUrl: 'http://relay.invalid',
      wallet,
      payment: { rpcUrl: '' },
      channelStore: store,
      channelsClient: channelsClient as never,
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    });
    const operator = Wallet.createRandom();

    await expect(client.requestOnChainClose(channelId, operator)).resolves.toBe('0xrequest');
    await expect(client.withdrawTimedOutChannel(channelId, operator)).resolves.toBe('0xwithdraw');
    expect(channelsClient.requestClose).toHaveBeenCalledWith(operator, channelId);
    expect(channelsClient.withdraw).toHaveBeenCalledWith(operator, channelId);
    expect(store.getChannel(channelId)?.status).toBe(CHANNEL_STATUS.TIMEOUT);
    await client.close();
  });

  it('targets the latest active channel for seller-level lifecycle actions', async () => {
    const wallet = Wallet.createRandom();
    const store = new MemoryChannelStore();
    const peerId = '98'.repeat(20);
    const olderChannelId = `0x${'21'.repeat(32)}`;
    const newerChannelId = `0x${'22'.repeat(32)}`;
    const now = Date.now();
    const baseChannel = {
      peerId,
      role: CHANNEL_ROLE.BUYER,
      sellerEvmAddr: `0x${peerId}`,
      buyerEvmAddr: wallet.address,
      nonce: 0,
      authMax: '0',
      deadline: Math.floor(now / 1000) + 900,
      previousSessionId: `0x${'00'.repeat(32)}`,
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: null,
      latestSpendingAuthSig: null,
      latestMetadata: null,
    } as const;
    store.upsertChannel({
      ...baseChannel,
      sessionId: olderChannelId,
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });
    store.upsertChannel({
      ...baseChannel,
      sessionId: newerChannelId,
      createdAt: now,
      updatedAt: now,
    });
    const channelsClient = {
      requestClose: vi.fn().mockResolvedValue('0xrequest'),
    };
    const client = AntseedWebClient.ephemeral({
      relayUrl: 'http://relay.invalid',
      wallet,
      payment: { rpcUrl: '' },
      channelStore: store,
      channelsClient: channelsClient as never,
      env: {
        RTCPeerConnection: class {} as unknown as typeof RTCPeerConnection,
        WebSocket: class {} as never,
      },
    });
    const seller = new SellerSession(client, { peerId });
    const operator = Wallet.createRandom();

    await expect(seller.requestOnChainClose(operator)).resolves.toBe('0xrequest');
    expect(channelsClient.requestClose).toHaveBeenCalledWith(operator, newerChannelId);
    await client.close();
  });
});

describe('sellerSummaryFromMetadata', () => {
  it('normalizes signed relay metadata into the shared buyer view', () => {
    const metadata: PeerMetadata = {
      peerId: '55'.repeat(20) as PeerMetadata['peerId'],
      version: 12,
      region: 'global',
      timestamp: Date.now(),
      signature: '0xsig',
      capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
      providers: [{
        provider: 'openai',
        services: ['test-model'],
        defaultPricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
        servicePricing: {
          'test-model': { inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
        },
        serviceApiProtocols: { 'test-model': ['openai-chat-completions'] },
        maxConcurrency: 2,
        currentLoad: 0,
      }],
    };

    const seller = sellerSummaryFromMetadata(metadata);
    expect(seller.providers).toEqual(['openai']);
    expect(seller.capabilities).toContain(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1);
    expect(seller.providerPricing?.openai?.services?.['test-model']).toMatchObject({
      inputUsdPerMillion: 4,
      outputUsdPerMillion: 20,
    });
    expect(
      seller.providerServiceApiProtocols?.openai?.services['test-model'],
    ).toEqual(['openai-chat-completions']);
    expect(seller.metadata).toBe(metadata);
  });

  it('takes a service pricing from the healthy upstream among those sharing a provider name', () => {
    const upstream = (price: number, status: 'healthy' | 'failing') => ({
      provider: 'openai',
      services: ['test-model'],
      defaultPricing: { inputUsdPerMillion: price, outputUsdPerMillion: price },
      serviceHealth: { 'test-model': { status } },
      maxConcurrency: 1,
      currentLoad: 0,
    });
    const seller = sellerSummaryFromMetadata({
      peerId: '55'.repeat(20) as PeerMetadata['peerId'],
      version: 13,
      region: 'global',
      timestamp: Date.now(),
      signature: '0xsig',
      providers: [upstream(1, 'healthy'), upstream(9, 'failing')],
    });
    expect(seller.providerPricing?.openai?.services?.['test-model']?.inputUsdPerMillion).toBe(1);
  });
});

class FakeLockManager implements WebLockManagerLike {
  private readonly active = new Set<string>();

  async request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: WebLockLike | null) => Promise<T> | T,
  ): Promise<T> {
    if (this.active.has(name)) {
      if (options.ifAvailable) return callback(null);
      throw new Error('wait mode not implemented by test fake');
    }
    this.active.add(name);
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      this.active.delete(name);
    }
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function mockConnection(initiallyOpen: boolean): {
  connection: SellerConnection;
  state: { isOpen: boolean; close: ReturnType<typeof vi.fn> };
} {
  const state = {
    isOpen: initiallyOpen,
    close: vi.fn(),
  };
  const connection = {
    get isOpen() { return state.isOpen; },
    state: ConnectionState.Open,
    send: vi.fn(),
    close: state.close,
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    onFrame: () => {},
    onClose: () => {},
  } as unknown as SellerConnection;
  return { connection, state };
}
