import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../src/payments/buyer-payment-negotiator.js';
import { SellerPaymentManager } from '../src/payments/seller-payment-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import { DepositsClient } from '../src/payments/evm/deposits-client.js';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { ProxyMux } from '../src/proxy/proxy-mux.js';
import { VerificationMux } from '../src/verification/verification-mux.js';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { ResourceOwnershipStore } from '../src/resources/resource-ownership-store.js';
import { FrameDecoder } from '../src/p2p/message-protocol.js';
import { ConnectionState } from '../src/types/connection.js';
import { toPeerId, type PeerInfo } from '../src/types/peer.js';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { SpendingAuthPayload } from '../src/types/protocol.js';

/**
 * End-to-end video reserve flow over the real buyer and seller stacks.
 *
 * Both sides run their production request handlers, payment managers and
 * negotiator, connected by an in-memory framed transport. Only the chain is
 * faked: one shared channel record that reserve()/topUp()/close() mutate and
 * getSession() reads, following AntseedChannels semantics (topUp settles the
 * signed serious fee and requires TOP_UP_SETTLED_THRESHOLD_BPS (8500 here) of
 * the old deposit to be settled first).
 */

const VIDEO_PRICE = 4_200_000n;
const VIDEO_FILE = mp4Video(5_000);
const CHAT_DELIVERED = 100_000n;
const FIRST_RESERVE = 1_000_000n;
const BUFFERED_CEILING = CHAT_DELIVERED + VIDEO_PRICE + FIRST_RESERVE;
const ADVANCE = 850_000n;
// Output-only chat pricing: 1,000 completion tokens at $100/M = $0.10.
const CHAT_PRICING = { inputUsdPerMillion: 0, outputUsdPerMillion: 100 };
const VIDEO_UNIT_MODEL = { version: 1 as const, components: [{ unit: 'video_generations' as const, priceUsd: 4.2 }] };

function identity(): Identity {
  const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));
  return {
    wallet,
    peerId: toPeerId(wallet.address.slice(2).toLowerCase()),
    privateKey: Buffer.from(wallet.privateKey.slice(2), 'hex'),
  };
}

type Listener = (...args: any[]) => void;

/** Two ends of an in-memory framed connection. Delivery is async like a real socket. */
function connectionPair(): { buyerSide: PeerConnection; sellerSide: PeerConnection } {
  const make = () => {
    const listeners = new Map<string, Set<Listener>>();
    const end: any = {
      state: ConnectionState.Open,
      remoteAddress: '203.0.113.9',
      hasRemoteCapability: () => false,
      on(event: string, listener: Listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      },
      off(event: string, listener: Listener) { listeners.get(event)?.delete(listener); },
      emitMessage(data: Uint8Array) { for (const listener of listeners.get('message') ?? []) listener(data); },
      send: (_data: Uint8Array) => {},
    };
    return end;
  };
  const buyerSide = make();
  const sellerSide = make();
  buyerSide.send = (data: Uint8Array) => { const copy = data.slice(); setImmediate(() => sellerSide.emitMessage(copy)); };
  sellerSide.send = (data: Uint8Array) => { const copy = data.slice(); setImmediate(() => buyerSide.emitMessage(copy)); };
  return { buyerSide, sellerSide };
}

/** Route incoming frames the same way AntseedNode._wireConnection does. */
function wireFrames(conn: PeerConnection, muxes: { proxy: { handleFrame(frame: any): Promise<unknown> }; payment: PaymentMux; verification: VerificationMux }): void {
  const decoder = new FrameDecoder();
  conn.on('message', (data: Uint8Array) => {
    for (const frame of decoder.feed(data)) {
      const target = PaymentMux.isPaymentMessage(frame.type)
        ? muxes.payment
        : VerificationMux.isVerificationMessage(frame.type) ? muxes.verification : muxes.proxy;
      void target.handleFrame(frame).catch(() => {});
    }
  });
}

interface Harness {
  buyerIdentity: Identity;
  sellerIdentity: Identity;
  peer: PeerInfo;
  buyer: BuyerPaymentManager;
  seller: SellerPaymentManager;
  buyerHandler: BuyerRequestHandler;
  chain: { deposit: bigint; settled: bigint; status: number };
  topUp: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  providerCreates: SerializedHttpRequest[];
  sentAuths: SpendingAuthPayload[];
  releaseTopUp(): void;
  send(request: SerializedHttpRequest): ReturnType<BuyerRequestHandler['sendRequest']>;
  videoRequest(requestId: string, idempotencyKey?: string): SerializedHttpRequest;
  retrieveRequest(requestId: string, queueId: string): SerializedHttpRequest;
  chatRequest(requestId: string): SerializedHttpRequest;
  settle(): Promise<void>;
}

describe('video reserve flow over the real buyer and seller stacks', () => {
  let directory: string;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'antseed-video-reserve-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) cleanup();
    rmSync(directory, { recursive: true, force: true });
  });

  function setup(options: { topUpBehavior?: 'land' | 'revert' | 'slow' } = {}): Harness {
    const buyerIdentity = identity();
    const sellerIdentity = identity();
    const buyerStore = new ChannelStore(join(directory, 'buyer'));
    const sellerStore = new ChannelStore(join(directory, 'seller'));
    const ownership = new ResourceOwnershipStore(join(directory, 'metering.db'));
    cleanups.push(() => { buyerStore.close(); sellerStore.close(); ownership.close(); });

    vi.spyOn(DepositsClient.prototype, 'getBuyerBalance').mockResolvedValue({
      available: 20_000_000n, reserved: 0n, lastActivityAt: 0n,
    });

    const common = { rpcUrl: 'http://127.0.0.1:1', chainId: 31337, channelsContractAddress: '0x' + 'cc'.repeat(20) };
    const buyer = new BuyerPaymentManager(buyerIdentity, {
      ...common,
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 500_000n,
      maxReserveAmountUsdc: FIRST_RESERVE,
      maxVideoRequestUsdc: 5_000_000n,
      dataDir: join(directory, 'buyer'),
    }, buyerStore);
    buyer.setSigner(buyerIdentity.wallet);
    const seller = new SellerPaymentManager(sellerIdentity, {
      ...common, dataDir: join(directory, 'seller'), minBudgetPerRequest: '10000',
    }, sellerStore);

    // One on-chain channel, shared by both sides through the same ChannelsClient.
    const chain = { deposit: 0n, settled: 0n, status: 0 };
    let releaseTopUp: (() => void) | null = null;
    const topUpBehavior = options.topUpBehavior ?? 'land';
    vi.spyOn(seller.channelsClient, 'reserve').mockImplementation(async (_signer, _buyer, _salt, maxAmount) => {
      chain.deposit = maxAmount;
      chain.status = 1;
      return '0xreserve';
    });
    const topUp = vi.spyOn(seller.channelsClient, 'topUp').mockImplementation(async (_signer, _channel, cumulative, _meta, _sig, newMax) => {
      if (topUpBehavior === 'revert') throw new Error('execution reverted: InsufficientBalance');
      if (topUpBehavior === 'slow') await new Promise<void>((resolve) => { releaseTopUp = resolve; });
      if (cumulative > chain.settled) chain.settled = cumulative;
      if (chain.settled * 10_000n < chain.deposit * 8_500n) throw new Error('execution reverted: TopUpThresholdNotMet');
      chain.deposit = newMax;
      return '0xtopup';
    }) as unknown as ReturnType<typeof vi.fn>;
    const close = vi.spyOn(seller.channelsClient, 'close').mockImplementation(async (_signer, _channel, finalAmount) => {
      if (finalAmount < chain.settled) throw new Error('execution reverted: FinalAmountBelowSettled');
      chain.settled = finalAmount;
      chain.status = 2;
      return '0xclose';
    }) as unknown as ReturnType<typeof vi.fn>;
    vi.spyOn(seller.channelsClient, 'settle').mockImplementation(async (_signer, _channel, amount) => {
      chain.settled = amount;
      return '0xsettle';
    });
    vi.spyOn(seller.channelsClient, 'getSession').mockImplementation(async () => ({
      buyer: buyerIdentity.wallet.address, seller: sellerIdentity.wallet.address,
      deposit: chain.deposit, settled: chain.settled, metadataHash: '0x' + '00'.repeat(32),
      deadline: 0n, settledAt: 0n, closeRequestedAt: 0n, status: chain.status,
    }));

    const providerCreates: SerializedHttpRequest[] = [];
    let jobCounter = 0;
    const provider: Provider = {
      name: 'venice',
      services: ['video-model', 'chat-model'],
      pricing: {
        defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        services: { 'chat-model': CHAT_PRICING },
      },
      serviceApiProtocols: { 'video-model': ['venice-video'], 'chat-model': ['openai-chat-completions'] },
      serviceUnitBillingModels: { 'video-model': { 'venice-video': VIDEO_UNIT_MODEL } },
      maxConcurrency: 4,
      getCapacity: () => ({ current: 0, max: 4 }),
      // The finished video streams as a real 5 s MP4, so it passes the delivery check.
      async handleRequestStream(request, callbacks) {
        if (!request.path.endsWith('/video/retrieve')) return provider.handleRequest(request);
        const start = {
          requestId: request.requestId, statusCode: 200, body: new Uint8Array(0),
          headers: { 'content-type': 'video/mp4', 'content-length': String(VIDEO_FILE.length), 'x-antseed-streaming': '1', 'x-antseed-video-download': 'video-stream-v1' },
        };
        callbacks.onResponseStart(start);
        await callbacks.onResponseChunk({ requestId: request.requestId, data: VIDEO_FILE, done: false });
        await callbacks.onResponseChunk({ requestId: request.requestId, data: new Uint8Array(0), done: true });
        return start;
      },
      handleRequest: vi.fn(async (request: SerializedHttpRequest) => {
        if (request.path.endsWith('/video/queue')) {
          providerCreates.push(request);
          jobCounter += 1;
          return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ queue_id: `job-${jobCounter}`, status: 'PENDING' })) };
        }
        return {
          requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ id: 'chat', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 1000, total_tokens: 1000 } })),
        };
      }),
    };

    const { buyerSide, sellerSide } = connectionPair();

    // Seller side, wired like AntseedNode._handleIncomingConnection.
    const sellerPayment = new PaymentMux(sellerSide);
    const sellerVerification = new VerificationMux(sellerSide);
    sellerPayment.onSpendingAuth((payload) => { void seller.handleSpendingAuth(buyerIdentity.peerId, payload, sellerPayment); });
    const sellerHandler = new SellerRequestHandler({
      identity: sellerIdentity, providers: [provider], sellerPaymentManager: seller, sessionTracker: null,
      channelsClient: seller.channelsClient, announcer: null, emit: () => false, resourceOwnershipStore: ownership,
    });
    const { mux: sellerProxy } = sellerHandler.handleConnection(sellerSide, buyerIdentity.peerId, sellerPayment, sellerVerification);
    wireFrames(sellerSide, { proxy: sellerProxy, payment: sellerPayment, verification: sellerVerification });

    // Buyer side, wired like AntseedNode's buyer path.
    const negotiator = new BuyerPaymentNegotiator(buyerIdentity, buyer, new DepositsClient({
      rpcUrl: common.rpcUrl, contractAddress: '0x' + 'dd'.repeat(20), usdcAddress: '0x' + 'ee'.repeat(20), evmChainId: 31337,
    } as any), seller.channelsClient, buyerStore, {}, { emit: vi.fn() });
    const buyerPayment = negotiator.getOrCreatePaymentMux(sellerIdentity.peerId, buyerSide);
    const sentAuths: SpendingAuthPayload[] = [];
    const originalSend = buyerPayment.sendSpendingAuth.bind(buyerPayment);
    buyerPayment.sendSpendingAuth = (payload: SpendingAuthPayload) => { sentAuths.push(payload); originalSend(payload); };
    const buyerProxy = new ProxyMux(buyerSide);
    const buyerVerification = new VerificationMux(buyerSide);
    wireFrames(buyerSide, { proxy: buyerProxy, payment: buyerPayment, verification: buyerVerification });
    const buyerHandler = new BuyerRequestHandler({ requestTimeoutMs: 120_000 }, {
      localPeerId: buyerIdentity.peerId,
      negotiator,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: async () => buyerSide as any,
      getMux: () => buyerProxy,
      getVerificationMux: () => buyerVerification,
      registerPaymentMux: () => {},
    });

    const peer = {
      peerId: sellerIdentity.peerId,
      lastSeen: Date.now(),
      providers: ['venice'],
      providerServiceApiProtocols: { venice: { services: { 'video-model': ['venice-video'], 'chat-model': ['openai-chat-completions'] } } },
      providerServiceUnitBillingModels: { venice: { services: { 'video-model': { 'venice-video': VIDEO_UNIT_MODEL } } } },
      providerPricing: { venice: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: { 'chat-model': CHAT_PRICING } } },
    } as unknown as PeerInfo;

    const videoRequest = (requestId: string, idempotencyKey?: string): SerializedHttpRequest => ({
      requestId,
      method: 'POST',
      path: '/api/v1/video/queue',
      headers: {
        'content-type': 'application/json',
        'x-antseed-service': 'video-model',
        'x-antseed-provider': 'venice',
        ...(idempotencyKey ? { 'x-antseed-idempotency-key': idempotencyKey } : {}),
      },
      body: Buffer.from(JSON.stringify({ model: 'video-model', prompt: 'a cat', duration: '5s' })),
    });
    const retrieveRequest = (requestId: string, queueId: string): SerializedHttpRequest => ({
      requestId,
      method: 'POST',
      path: '/api/v1/video/retrieve',
      headers: { 'content-type': 'application/json', 'x-antseed-service': 'video-model', 'x-antseed-provider': 'venice', 'x-antseed-video-download': 'video-stream-v1' },
      body: Buffer.from(JSON.stringify({ model: 'video-model', queue_id: queueId })),
    });
    const chatRequest = (requestId: string): SerializedHttpRequest => ({
      requestId,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'x-antseed-service': 'chat-model', 'x-antseed-provider': 'venice' },
      body: Buffer.from(JSON.stringify({ model: 'chat-model', messages: [{ role: 'user', content: 'hi' }] })),
    });

    return {
      buyerIdentity, sellerIdentity, peer, buyer, seller, buyerHandler, chain, topUp, close, providerCreates, sentAuths,
      releaseTopUp: () => { expect(releaseTopUp).not.toBeNull(); releaseTopUp!(); },
      send: (request) => buyerHandler.sendRequest(peer, request, request.path.endsWith('/video/retrieve') ? { onResponseStart() {}, onResponseChunk() {} } : undefined),
      videoRequest,
      retrieveRequest,
      chatRequest,
      settle: async () => { await negotiator.drainPendingNeedAuth(); await new Promise((resolve) => setTimeout(resolve, 20)); },
    };
  }

  /** Open the channel and deliver one $0.10 chat so the video starts from a used channel. */
  async function openChannelWithChat(h: Harness): Promise<void> {
    const response = await h.send(h.chatRequest('chat-1'));
    if (response.statusCode !== 200) throw new Error(`chat failed: ${response.statusCode} ${Buffer.from(response.body).toString()}`);
    await h.settle();
    expect(h.chain).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n, status: 1 });
    expect(h.buyer.getDeliveredAmount(h.peer.peerId)).toBe(CHAT_DELIVERED);
  }

  it('pays the serious fee inside topUp(), and charges the rest only after the video is delivered', async () => {
    const h = setup();
    await openChannelWithChat(h);

    const response = await h.send(h.videoRequest('video-1', 'video-key-1'));
    await h.settle();

    // Accepted, not delivered: only the serious fee is paid, and only on-chain
    // inside topUp(). Nothing more is owed yet.
    expect(h.chain.settled).toBe(ADVANCE);
    expect(h.buyer.getDeliveredAmount(h.peer.peerId)).toBe(CHAT_DELIVERED);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(ADVANCE);

    const delivered = await h.send(h.retrieveRequest('retrieve-1', 'job-1'));
    await h.settle();
    expect(delivered.statusCode).toBe(200);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(Buffer.from(response.body).toString()).queue_id).toBe('job-1');
    expect(h.providerCreates).toHaveLength(1);
    expect(h.providerCreates[0]!.headers['x-antseed-idempotency-key']).toBe('video-key-1');
    expect(h.topUp).toHaveBeenCalledOnce();
    expect(h.topUp.mock.calls[0]![2]).toBe(ADVANCE);
    expect(h.topUp.mock.calls[0]![5]).toBe(BUFFERED_CEILING);
    expect(h.chain.deposit).toBe(BUFFERED_CEILING);

    expect(h.buyer.getDeliveredAmount(h.peer.peerId)).toBe(CHAT_DELIVERED + VIDEO_PRICE);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED + VIDEO_PRICE);
    await h.seller.settleSession(h.buyerIdentity.peerId);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(CHAT_DELIVERED + VIDEO_PRICE);
  });

  it('replays the accepted create without another advance, top-up or charge', async () => {
    const h = setup();
    await openChannelWithChat(h);
    await h.send(h.videoRequest('video-1', 'video-key-1'));
    await h.settle();
    const authsBefore = h.sentAuths.length;
    const cumulativeBefore = h.buyer.getCumulativeAmount(h.peer.peerId);

    const replay = await h.send(h.videoRequest('video-1-retry', 'video-key-1'));
    await h.settle();

    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-antseed-idempotent-replay']).toBe('true');
    expect(JSON.parse(Buffer.from(replay.body).toString()).queue_id).toBe('job-1');
    expect(h.providerCreates).toHaveLength(1);
    expect(h.topUp).toHaveBeenCalledOnce();
    expect(h.sentAuths).toHaveLength(authsBefore);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(cumulativeBefore);
  });

  it('does not sign an advance for a create the seller rejects', async () => {
    const h = setup();
    await openChannelWithChat(h);
    const authsBefore = h.sentAuths.length;

    const bad = h.videoRequest('video-bad', 'bad key!');
    const response = await h.send(bad);
    await h.settle();

    expect(response.statusCode).toBe(400);
    expect(h.providerCreates).toHaveLength(0);
    expect(h.topUp).not.toHaveBeenCalled();
    expect(h.sentAuths).toHaveLength(authsBefore);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED);
    expect(h.chain).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n });
  });

  it('does not resend the create when the seller top-up reverts', async () => {
    const h = setup({ topUpBehavior: 'revert' });
    await openChannelWithChat(h);

    await expect(h.send(h.videoRequest('video-1', 'video-key-1'))).rejects.toMatchObject({
      code: 'buyer-session-state',
    });
    await h.settle();

    expect(h.providerCreates).toHaveLength(0);
    expect(h.topUp).toHaveBeenCalledOnce();
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(ADVANCE);
    expect(h.buyer.getDeliveredAmount(h.peer.peerId)).toBe(CHAT_DELIVERED);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBeLessThanOrEqual(ADVANCE);
  });

  it('closes at delivered spend, not the unused advance, when the seller top-up reverts', async () => {
    const h = setup({ topUpBehavior: 'revert' });
    await openChannelWithChat(h);

    await h.send(h.videoRequest('video-1', 'video-key-1')).catch(() => {});
    await h.settle();

    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(CHAT_DELIVERED);
  });

  it('times out a slow top-up without resending, then retries without a second advance once it lands', async () => {
    const h = setup({ topUpBehavior: 'slow' });
    await openChannelWithChat(h);
    const isAdvance = (auth: SpendingAuthPayload) => auth.cumulativeAmount === ADVANCE.toString() && auth.reserveMaxAmount == null;

    // Only the buyer's 45s top-up wait runs on fake time; the transport keeps
    // real async delivery through setImmediate.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        await vi.advanceTimersByTimeAsync(250);
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const first = h.send(h.videoRequest('video-1', 'video-key-1'));
    const firstAssertion = expect(first).rejects.toMatchObject({ code: 'buyer-reserve-topup-timeout' });
    await advance(50_000);
    await firstAssertion;

    expect(h.providerCreates).toHaveLength(0);
    expect(h.topUp).toHaveBeenCalledOnce();
    expect(h.sentAuths.filter(isAdvance)).toHaveLength(1);
    expect(h.chain.deposit).toBe(FIRST_RESERVE);

    // The slow top-up transaction lands, then the user retries the same create.
    h.releaseTopUp();
    await advance(1_000);
    expect(h.chain.deposit).toBe(BUFFERED_CEILING);

    const retry = h.send(h.videoRequest('video-1-retry', 'video-key-1'));
    await advance(5_000);
    const response = await retry;
    await advance(1_000);

    expect(response.statusCode).toBe(200);
    expect(h.providerCreates).toHaveLength(1);
    expect(h.topUp).toHaveBeenCalledOnce();
    expect(h.sentAuths.filter(isAdvance)).toHaveLength(1);
    const download = h.send(h.retrieveRequest('retrieve-1', 'job-1'));
    await advance(1_000);
    expect((await download).statusCode).toBe(200);
    await advance(1_000);
    expect(h.buyer.getDeliveredAmount(h.peer.peerId)).toBe(CHAT_DELIVERED + VIDEO_PRICE);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED + VIDEO_PRICE);
  }, 30_000);
  it('charges a delivered video only once, even when it is downloaded again', async () => {
    const h = setup();
    await openChannelWithChat(h);
    await h.send(h.videoRequest('video-1', 'video-key-1'));
    await h.settle();

    await h.send(h.retrieveRequest('retrieve-1', 'job-1'));
    await h.settle();
    const authsAfterDelivery = h.sentAuths.length;
    await h.send(h.retrieveRequest('retrieve-2', 'job-1'));
    await h.settle();

    expect(h.sentAuths).toHaveLength(authsAfterDelivery);
    expect(h.buyer.getDeliveredAmount(h.peer.peerId)).toBe(CHAT_DELIVERED + VIDEO_PRICE);
  });

  it('keeps only the serious fee when the video is never delivered', async () => {
    const h = setup();
    await openChannelWithChat(h);
    await h.send(h.videoRequest('video-1', 'video-key-1'));
    await h.settle();

    await h.seller.settleSession(h.buyerIdentity.peerId);

    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(ADVANCE);
    expect(h.chain).toMatchObject({ settled: ADVANCE, status: 2 });
  });

  it('never cashes the serious fee on its own when the buyer disconnects before the top-up', async () => {
    const h = setup({ topUpBehavior: 'slow' });
    await openChannelWithChat(h);
    const pending = h.send(h.videoRequest('video-1', 'video-key-1')).catch(() => {});
    for (let attempt = 0; attempt < 100 && h.topUp.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(h.topUp).toHaveBeenCalledOnce();

    // Buyer drops while topUp() is still pending: close must use delivered work only.
    await h.seller.settleSession(h.buyerIdentity.peerId);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(CHAT_DELIVERED);
    h.releaseTopUp();
    void pending;
  });
});

/** Minimal MP4 (ftyp, mvhd duration, small mdat) that passes the delivery check. */
function mp4Video(durationMs: number): Uint8Array {
  const box = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    return out;
  };
  const mvhd = new Uint8Array(20);
  new DataView(mvhd.buffer).setUint32(12, 1000);
  new DataView(mvhd.buffer).setUint32(16, durationMs);
  const parts = [box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom')), box('moov', box('mvhd', mvhd)), box('mdat', new Uint8Array(1024).fill(7))];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
