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
import { computeChannelId } from '@antseed/protocol/signatures';

interface ChainChannel { deposit: bigint; settled: bigint; status: number }

/**
 * End-to-end one-off video channel flow over the real buyer and seller stacks.
 *
 * Both sides run their production request handlers, payment managers and
 * negotiator, connected by an in-memory framed transport. Only the chain is
 * faked: a map of channel records keyed by channelId that reserve()/topUp()/
 * settle()/close() mutate and getSession() reads, following AntseedChannels
 * semantics (FIRST_SIGN_CAP caps reserve(); topUp settles the threshold
 * authorization and requires TOP_UP_SETTLED_THRESHOLD_BPS (8500 here) of the
 * old deposit to be settled first).
 */

const VIDEO_PRICE = 4_200_000n;
const VIDEO_FILE = mp4Video(5_000);
const CHAT_DELIVERED = 100_000n;
const FIRST_RESERVE = 1_000_000n;
const FIRST_SIGN_CAP = 1_000_000n;
const SERIOUS_FEE = 850_000n;
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
  chain: Map<string, ChainChannel>;
  sessionChannelId(): string;
  oneOffChannelIds(): string[];
  reserve: ReturnType<typeof vi.fn>;
  topUp: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  disconnect(): void;
  providerCreates: SerializedHttpRequest[];
  sentAuths: SpendingAuthPayload[];
  releaseTopUp(): void;
  send(request: SerializedHttpRequest): ReturnType<BuyerRequestHandler['sendRequest']>;
  videoRequest(requestId: string, duration?: string): SerializedHttpRequest;
  retrieveRequest(requestId: string, queueId: string): SerializedHttpRequest;
  chatRequest(requestId: string): SerializedHttpRequest;
  settle(): Promise<void>;
  /** A fresh buyer payment manager on the same identity and channel store, as after a restart. */
  restartBuyer(): BuyerPaymentManager;
}

describe('one-off video channel flow over the real buyer and seller stacks', () => {
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

  function setup(options: {
    topUpBehavior?: 'land' | 'revert' | 'slow';
    videoPricing?: 'flat' | 'per-second' | 'resolution-tiered' | 'cheap';
    processingPolls?: number;
    retrieveStatus?: 'FAILED';
    createResponse?: 'rejected';
    availableBalance?: bigint;
    reserveEstimateOverdraftUsdc?: bigint;
    freeTier?: { consume: ReturnType<typeof vi.fn>; reportUsageRequest: ReturnType<typeof vi.fn> };
  } = {}): Harness {
    const buyerIdentity = identity();
    const sellerIdentity = identity();
    const buyerStore = new ChannelStore(join(directory, 'buyer'));
    const sellerStore = new ChannelStore(join(directory, 'seller'));
    const ownership = new ResourceOwnershipStore(join(directory, 'metering.db'));
    cleanups.push(() => { buyerStore.close(); sellerStore.close(); ownership.close(); });

    vi.spyOn(DepositsClient.prototype, 'getBuyerBalance').mockResolvedValue({
      available: options.availableBalance ?? 20_000_000n, reserved: 0n, lastActivityAt: 0n,
    });

    const common = { rpcUrl: 'http://127.0.0.1:1', chainId: 31337, channelsContractAddress: '0x' + 'cc'.repeat(20) };
    const buyerConfig = {
      ...common,
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 500_000n,
      maxReserveAmountUsdc: FIRST_RESERVE,
      maxVideoRequestUsdc: 5_000_000n,
      dataDir: join(directory, 'buyer'),
    };
    const buyer = new BuyerPaymentManager(buyerIdentity, buyerConfig, buyerStore);
    buyer.setSigner(buyerIdentity.wallet);
    const seller = new SellerPaymentManager(sellerIdentity, {
      ...common, dataDir: join(directory, 'seller'), minBudgetPerRequest: '10000',
    }, sellerStore);

    // Every on-chain channel, keyed by channelId, shared by both sides through the same ChannelsClient.
    const chain = new Map<string, ChainChannel>();
    const channelOf = (channelId: string): ChainChannel => {
      const channel = chain.get(channelId);
      if (!channel) throw new Error('execution reverted: ChannelNotFound');
      return channel;
    };
    let releaseTopUp: (() => void) | null = null;
    const topUpBehavior = options.topUpBehavior ?? 'land';
    vi.spyOn(seller.channelsClient, 'getFirstSignCap').mockResolvedValue(FIRST_SIGN_CAP);
    vi.spyOn(seller.channelsClient, 'getTopUpSettledThresholdBps').mockResolvedValue(8_500n);
    const reserve = vi.spyOn(seller.channelsClient, 'reserve').mockImplementation(async (_signer, buyerAddr, salt, maxAmount) => {
      if (maxAmount > FIRST_SIGN_CAP) throw new Error('execution reverted: FirstSignCapExceeded');
      const channelId = computeChannelId(buyerAddr, sellerIdentity.wallet.address, salt);
      if (chain.has(channelId)) throw new Error('execution reverted: ChannelExists');
      chain.set(channelId, { deposit: maxAmount, settled: 0n, status: 1 });
      return '0xreserve';
    }) as unknown as ReturnType<typeof vi.fn>;
    const topUp = vi.spyOn(seller.channelsClient, 'topUp').mockImplementation(async (_signer, channelId, cumulative, _meta, _sig, newMax) => {
      if (topUpBehavior === 'revert') throw new Error('execution reverted: InsufficientBalance');
      if (topUpBehavior === 'slow') await new Promise<void>((resolve) => { releaseTopUp = resolve; });
      const channel = channelOf(channelId);
      if (cumulative > channel.deposit) throw new Error('execution reverted: InvalidAmount');
      if (cumulative > channel.settled) channel.settled = cumulative;
      if (channel.settled * 10_000n < channel.deposit * 8_500n) throw new Error('execution reverted: TopUpThresholdNotMet');
      channel.deposit = newMax;
      return '0xtopup';
    }) as unknown as ReturnType<typeof vi.fn>;
    const close = vi.spyOn(seller.channelsClient, 'close').mockImplementation(async (_signer, channelId, finalAmount) => {
      const channel = channelOf(channelId);
      if (channel.status !== 1) throw new Error('execution reverted: ChannelNotActive');
      if (finalAmount < channel.settled) throw new Error('execution reverted: FinalAmountBelowSettled');
      if (finalAmount > channel.deposit) throw new Error('execution reverted: InvalidAmount');
      channel.settled = finalAmount;
      channel.status = 2;
      return '0xclose';
    }) as unknown as ReturnType<typeof vi.fn>;
    vi.spyOn(seller.channelsClient, 'settle').mockImplementation(async (_signer, channelId, amount) => {
      channelOf(channelId).settled = amount;
      return '0xsettle';
    });
    vi.spyOn(seller.channelsClient, 'getSession').mockImplementation(async (channelId) => {
      const channel = chain.get(channelId) ?? { deposit: 0n, settled: 0n, status: 0 };
      return {
        buyer: buyerIdentity.wallet.address, seller: sellerIdentity.wallet.address,
        deposit: channel.deposit, settled: channel.settled, metadataHash: '0x' + '00'.repeat(32),
        deadline: 0n, settledAt: 0n, closeRequestedAt: 0n, status: channel.status,
      };
    });

    const providerCreates: SerializedHttpRequest[] = [];
    let jobCounter = 0;
    let processingPolls = options.processingPolls ?? 0;
    const videoUnitModel = options.videoPricing === 'resolution-tiered'
      ? { version: 1 as const, components: [
        { unit: 'video_seconds' as const, priceUsd: 0.42, match: { resolution: '720p' } },
        { unit: 'video_seconds' as const, priceUsd: 0.84, match: { resolution: '1080p' } },
      ] }
      : options.videoPricing === 'per-second'
        ? { version: 1 as const, components: [{ unit: 'video_seconds' as const, priceUsd: 0.84 }] }
        : options.videoPricing === 'cheap'
          ? { version: 1 as const, components: [{ unit: 'video_generations' as const, priceUsd: 0.8 }] }
          : VIDEO_UNIT_MODEL;
    const provider: Provider = {
      name: 'venice',
      services: ['video-model', 'chat-model'],
      pricing: {
        defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        services: { 'chat-model': CHAT_PRICING },
      },
      serviceApiProtocols: { 'video-model': ['venice-video'], 'chat-model': ['openai-chat-completions'] },
      serviceUnitBillingModels: { 'video-model': { 'venice-video': videoUnitModel } },
      maxConcurrency: 4,
      getCapacity: () => ({ current: 0, max: 4 }),
      // The finished video streams as a real 5 s MP4, so it passes the delivery check.
      async handleRequestStream(request, callbacks) {
        if (!request.path.endsWith('/video/retrieve')) return provider.handleRequest(request);
        if (options.retrieveStatus) {
          return {
            requestId: request.requestId, statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ status: options.retrieveStatus })),
          };
        }
        if (processingPolls > 0) {
          processingPolls -= 1;
          return {
            requestId: request.requestId, statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ status: 'PROCESSING' })),
          };
        }
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
          if (options.createResponse === 'rejected') {
            return { requestId: request.requestId, statusCode: 400, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: 'content policy' })) };
          }
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
      reserveEstimateOverdraftUsdc: options.reserveEstimateOverdraftUsdc,
      ...(options.freeTier ? {
        sellerFreeTierLimiter: { maxRequestsPerAddress: 1, maxRequestsPerIp: 1, windowMs: 60_000, consume: options.freeTier.consume } as any,
        sellerFreeUsageManager: { reportUsageRequest: options.freeTier.reportUsageRequest } as any,
      } : {}),
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
      providerServiceUnitBillingModels: { venice: { services: { 'video-model': { 'venice-video': videoUnitModel } } } },
      providerPricing: { venice: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: { 'chat-model': CHAT_PRICING } } },
    } as unknown as PeerInfo;

    const videoRequest = (requestId: string, duration = '5s'): SerializedHttpRequest => ({
      requestId,
      method: 'POST',
      path: '/api/v1/video/queue',
      headers: {
        'content-type': 'application/json',
        'x-antseed-service': 'video-model',
        'x-antseed-provider': 'venice',
      },
      body: Buffer.from(JSON.stringify({ model: 'video-model', prompt: 'a cat', duration, resolution: '1080p' })),
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
      body: Buffer.from(JSON.stringify({ model: 'chat-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 })),
    });

    const sessionChannelId = () => {
      const session = seller.getChannelByPeer(buyerIdentity.peerId);
      if (!session) throw new Error('no session channel');
      return session.sessionId;
    };
    const oneOffChannelIds = () => [...chain.keys()].filter((channelId) => sellerStore.getChannel(channelId)?.channelKind === 'one_off');

    return {
      buyerIdentity, sellerIdentity, peer, buyer, seller, buyerHandler, chain, sessionChannelId, oneOffChannelIds,
      reserve, topUp, close, providerCreates, sentAuths,
      disconnect: () => seller.onBuyerDisconnect(buyerIdentity.peerId),
      releaseTopUp: () => { expect(releaseTopUp).not.toBeNull(); releaseTopUp!(); },
      send: (request) => buyerHandler.sendRequest(peer, request, request.path.endsWith('/video/retrieve') ? { onResponseStart() {}, onResponseChunk() {} } : undefined),
      videoRequest,
      retrieveRequest,
      chatRequest,
      settle: async () => { await negotiator.drainPendingNeedAuth(); await new Promise((resolve) => setTimeout(resolve, 20)); },
      restartBuyer: () => new BuyerPaymentManager(buyerIdentity, buyerConfig, buyerStore),
    };
  }

  /** Open the session channel and deliver one $0.10 chat on it. */
  async function openChannelWithChat(h: Harness): Promise<void> {
    const response = await h.send(h.chatRequest('chat-1'));
    if (response.statusCode !== 200) throw new Error(`chat failed: ${response.statusCode} ${Buffer.from(response.body).toString()}`);
    await h.settle();
    expect(h.chain.get(h.sessionChannelId())).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n, status: 1 });
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED);
  }

  function onlyOneOff(h: Harness): ChainChannel & { channelId: string } {
    const ids = h.oneOffChannelIds();
    expect(ids).toHaveLength(1);
    return { channelId: ids[0]!, ...h.chain.get(ids[0]!)! };
  }

  it('opens a separate channel for the video and leaves the chat channel untouched', async () => {
    const h = setup();
    await openChannelWithChat(h);
    const sessionId = h.sessionChannelId();

    const response = await h.send(h.videoRequest('video-1'));
    await h.settle();

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(Buffer.from(response.body).toString()).queue_id).toBe('job-1');
    expect(h.providerCreates).toHaveLength(1);
    const video = onlyOneOff(h);
    expect(video.channelId).not.toBe(sessionId);
    // reserve() at the first-sign cap, then topUp() to the price with the serious fee settled.
    expect(video).toMatchObject({ deposit: VIDEO_PRICE, settled: SERIOUS_FEE, status: 1 });
    expect(h.topUp).toHaveBeenCalledOnce();
    expect(h.topUp.mock.calls[0]![1]).toBe(video.channelId);
    expect(h.topUp.mock.calls[0]![2]).toBe(SERIOUS_FEE);
    expect(h.topUp.mock.calls[0]![5]).toBe(VIDEO_PRICE);
    // The chat channel is not closed, superseded or charged.
    expect(h.close).not.toHaveBeenCalled();
    expect(h.seller.getChannelByPeer(h.buyerIdentity.peerId)?.sessionId).toBe(sessionId);
    expect(h.chain.get(sessionId)).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n, status: 1 });
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED);
  });

  it('opens a video channel without any chat session, and hasSession stays false', async () => {
    const h = setup();

    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(200);
    await h.settle();

    expect(onlyOneOff(h)).toMatchObject({ deposit: VIDEO_PRICE, settled: SERIOUS_FEE, status: 1 });
    expect(h.seller.hasSession(h.buyerIdentity.peerId)).toBe(false);
    expect(h.seller.getChannelByPeer(h.buyerIdentity.peerId)).toBeFalsy();
  });

  it('keeps chat spending on the chat channel while a video is pending', async () => {
    const h = setup();
    await openChannelWithChat(h);
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const before = onlyOneOff(h);

    expect((await h.send(h.chatRequest('chat-2'))).statusCode).toBe(200);
    await h.settle();

    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED * 2n);
    expect(h.seller.getCumulativeSpend(h.sessionChannelId())).toBe(CHAT_DELIVERED * 2n);
    expect(onlyOneOff(h)).toEqual(before);
    expect(h.seller.getCumulativeSpend(before.channelId)).toBe(0n);
  });

  it('closes the video channel at the price on delivery', async () => {
    const h = setup();
    await openChannelWithChat(h);
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);

    const delivered = await h.send(h.retrieveRequest('retrieve-1', 'job-1'));
    expect(delivered.statusCode).toBe(200);
    expect(delivered.headers['content-type']).toBe('video/mp4');
    await h.settle();

    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![1]).toBe(channelId);
    expect(h.close.mock.calls[0]![2]).toBe(VIDEO_PRICE);
    expect(h.chain.get(channelId)).toMatchObject({ settled: VIDEO_PRICE, status: 2 });
    expect(h.seller.isOneOffChannel(channelId)).toBe(false);
    // The chat channel is still open and still at its own spend.
    expect(h.chain.get(h.sessionChannelId())).toMatchObject({ settled: 0n, status: 1 });
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED);
  });

  it('still charges the video on delivery after the chat session is cleaned up', async () => {
    const h = setup();
    await openChannelWithChat(h);
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);

    h.buyer.cleanupSession(h.peer.peerId);

    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close.mock.calls.find((call) => call[1] === channelId)?.[2]).toBe(VIDEO_PRICE);
  });

  it('keeps an accepted video job across a buyer restart', async () => {
    const h = setup();
    await h.send(h.videoRequest('video-1'));
    await h.settle();

    const restarted = h.restartBuyer();

    expect(restarted.trackVideoRetrieve(h.peer.peerId, 'venice-video', 'job-1', 'retrieve-after-restart')).toBe(true);
    expect(h.buyer.trackVideoRetrieve(h.peer.peerId, 'venice-video', 'job-unknown', 'retrieve-unknown')).toBe(false);
  });

  it('polls and downloads a paid video without using the free tier', async () => {
    const freeTier = {
      consume: vi.fn(() => ({ allowed: false, retryAfterMs: 60_000, limitedBy: 'address', buyerAddress: 'buyer', remoteIp: null })),
      reportUsageRequest: vi.fn(),
    };
    const h = setup({ processingPolls: 1, freeTier });
    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(200);
    await h.settle();

    const processing = await h.send(h.retrieveRequest('poll-1', 'job-1'));
    expect(processing.statusCode).toBe(200);
    const delivered = await h.send(h.retrieveRequest('retrieve-1', 'job-1'));
    expect(delivered.statusCode).toBe(200);
    expect(delivered.headers['content-type']).toBe('video/mp4');
    await h.settle();

    expect(freeTier.consume).not.toHaveBeenCalled();
    expect(freeTier.reportUsageRequest).not.toHaveBeenCalled();
    expect(h.close.mock.calls[0]![2]).toBe(VIDEO_PRICE);
  });

  it.each(['flat', 'per-second', 'resolution-tiered'] as const)('polls and delivers a %s video without repricing or charging twice', async (videoPricing) => {
    const h = setup({ videoPricing, processingPolls: 1 });
    await openChannelWithChat(h);
    expect((await h.send(h.videoRequest('video-priced'))).statusCode).toBe(200);
    await h.settle();
    const authsBeforePoll = h.sentAuths.length;

    const processing = await h.send(h.retrieveRequest('poll-priced', 'job-1'));
    expect(processing.statusCode).toBe(200);
    expect(JSON.parse(Buffer.from(processing.body).toString())).toEqual({ status: 'PROCESSING' });
    await h.settle();
    expect(h.sentAuths).toHaveLength(authsBeforePoll);
    expect(h.close).not.toHaveBeenCalled();

    expect((await h.send(h.retrieveRequest('download-priced', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    const authsAfterDelivery = h.sentAuths.length;
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(VIDEO_PRICE);

    expect((await h.send(h.retrieveRequest('repeat-priced', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.sentAuths).toHaveLength(authsAfterDelivery);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.providerCreates).toHaveLength(1);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED);
  });

  it('runs two videos in parallel on two separate channels', async () => {
    const h = setup();
    await openChannelWithChat(h);

    const [first, second] = await Promise.all([h.send(h.videoRequest('video-a')), h.send(h.videoRequest('video-b'))]);
    await h.settle();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(h.providerCreates).toHaveLength(2);
    const ids = h.oneOffChannelIds();
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(h.chain.get(id)).toMatchObject({ deposit: VIDEO_PRICE, settled: SERIOUS_FEE, status: 1 });

    expect((await h.send(h.retrieveRequest('retrieve-a', 'job-1'))).statusCode).toBe(200);
    expect((await h.send(h.retrieveRequest('retrieve-b', 'job-2'))).statusCode).toBe(200);
    await h.settle();

    expect(h.close).toHaveBeenCalledTimes(2);
    for (const id of ids) expect(h.chain.get(id)).toMatchObject({ settled: VIDEO_PRICE, status: 2 });
    expect(h.chain.get(h.sessionChannelId())).toMatchObject({ settled: 0n, status: 1 });
  });

  it('opens a video at or below the first-sign cap with no serious fee and no top-up', async () => {
    const h = setup({ videoPricing: 'cheap' });

    expect((await h.send(h.videoRequest('video-cheap'))).statusCode).toBe(200);
    await h.settle();
    expect(onlyOneOff(h)).toMatchObject({ deposit: 800_000n, settled: 0n, status: 1 });
    expect(h.topUp).not.toHaveBeenCalled();
    expect(h.sentAuths.some((auth) => auth.reserveBatch)).toBe(false);

    expect((await h.send(h.retrieveRequest('retrieve-cheap', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(800_000n);
  });

  it('closes at the serious fee when the generation fails upstream', async () => {
    const h = setup({ retrieveStatus: 'FAILED' });
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);

    const failed = await h.send(h.retrieveRequest('retrieve-1', 'job-1'));
    expect(JSON.parse(Buffer.from(failed.body).toString())).toEqual({ status: 'FAILED' });
    await h.settle();

    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(SERIOUS_FEE);
    expect(h.chain.get(channelId)).toMatchObject({ settled: SERIOUS_FEE, status: 2 });
  });

  it('closes at the serious fee when the provider rejects the create', async () => {
    const h = setup({ createResponse: 'rejected' });

    const response = await h.send(h.videoRequest('video-1'));
    await h.settle();

    expect(response.statusCode).toBe(400);
    const { channelId } = onlyOneOff(h);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(SERIOUS_FEE);
    expect(h.chain.get(channelId)).toMatchObject({ status: 2 });
    expect(h.buyer.getOneOffChannelForRequest(h.peer.peerId, 'video-1')).toBeNull();
  });

  it('retries a failed close of a rejected video on the next timeout check', async () => {
    const h = setup({ createResponse: 'rejected' });
    // The first close reaches an RPC node that has not seen the reserve yet.
    const landOnChain = h.close.getMockImplementation()!;
    h.close.mockImplementationOnce(async () => {
      throw new Error('execution reverted: ChannelNotActive');
    });

    const response = await h.send(h.videoRequest('video-1'));
    await h.settle();

    expect(response.statusCode).toBe(400);
    const { channelId } = onlyOneOff(h);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.chain.get(channelId)).toMatchObject({ status: 1 });

    h.close.mockImplementation(landOnChain);
    await h.seller.checkTimeouts();

    expect(h.close).toHaveBeenCalledTimes(2);
    expect(h.close.mock.calls[1]![1]).toBe(channelId);
    expect(h.close.mock.calls[1]![2]).toBe(SERIOUS_FEE);
    expect(h.chain.get(channelId)).toMatchObject({ status: 2 });
    expect(h.seller.isOneOffChannel(channelId)).toBe(false);
  });

  it('releases the whole reserve and does not send the create when topUp reverts', async () => {
    const h = setup({ topUpBehavior: 'revert' });
    await openChannelWithChat(h);

    await expect(h.send(h.videoRequest('video-1'))).rejects.toMatchObject({ code: 'buyer-session-state' });
    await h.settle();

    expect(h.providerCreates).toHaveLength(0);
    const sessionId = h.sessionChannelId();
    const videoChannels = [...h.chain.keys()].filter((channelId) => channelId !== sessionId);
    expect(videoChannels).toHaveLength(1);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![1]).toBe(videoChannels[0]);
    expect(h.close.mock.calls[0]![2]).toBe(0n);
    expect(h.chain.get(videoChannels[0]!)).toMatchObject({ settled: 0n, status: 2 });
    expect(h.buyer.getOneOffChannelForRequest(h.peer.peerId, 'video-1')).toBeNull();
    expect(h.chain.get(h.sessionChannelId())).toMatchObject({ status: 1 });
  });

  it('does not open a channel for an invalid create', async () => {
    const h = setup();
    await openChannelWithChat(h);
    const authsBefore = h.sentAuths.length;

    await expect(h.send(h.videoRequest('video-bad', '0s'))).rejects.toMatchObject({ code: 'invalid-request' });
    await h.settle();

    expect(h.providerCreates).toHaveLength(0);
    expect(h.sentAuths).toHaveLength(authsBefore);
    expect(h.oneOffChannelIds()).toHaveLength(0);
  });

  it('returns insufficient deposits without opening a channel when the buyer cannot cover the video', async () => {
    const h = setup({ availableBalance: VIDEO_PRICE - 1n });

    const response = await h.send(h.videoRequest('video-1'));

    expect(response.statusCode).toBe(402);
    expect(JSON.parse(Buffer.from(response.body).toString()).code).toBe('insufficient_deposits');
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.providerCreates).toHaveLength(0);
  });

  it('leaves a pending video channel alone when the buyer disconnects', async () => {
    const h = setup();
    await openChannelWithChat(h);
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);

    h.disconnect();
    await h.seller.settleSession(h.buyerIdentity.peerId);

    for (const call of h.close.mock.calls) expect(call[1]).not.toBe(channelId);
    expect(h.chain.get(channelId)).toMatchObject({ settled: SERIOUS_FEE, status: 1 });
    expect(h.seller.isOneOffChannel(channelId)).toBe(true);
  });

  it('refuses to start a second job on a channel that already ran its create', async () => {
    const h = setup();
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);

    // A replay of the same create reuses the same requestId and its claimed channel.
    expect(h.seller.claimOneOffChannel(channelId)).toBe(false);
    expect(h.providerCreates).toHaveLength(1);
  });

  it('keeps a one-off channel claimed after its delivery is charged', async () => {
    const h = setup();
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);

    h.seller.recordSpend(channelId, VIDEO_PRICE);

    expect(h.seller.claimOneOffChannel(channelId)).toBe(false);
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
