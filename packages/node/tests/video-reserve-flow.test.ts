import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, Wallet } from 'ethers';
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
import { connectionPair, wireFrames } from './helpers/framed-connection.js';
import { fakeChannelChain, type ChainChannel } from './helpers/fake-channel-chain.js';
import { ConnectionState } from '../src/types/connection.js';
import { toPeerId, type PeerInfo } from '../src/types/peer.js';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { NeedAuthPayload, SpendingAuthPayload } from '../src/types/protocol.js';


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

interface Harness {
  buyerIdentity: Identity;
  sellerIdentity: Identity;
  peer: PeerInfo;
  buyer: BuyerPaymentManager;
  seller: SellerPaymentManager;
  buyerHandler: BuyerRequestHandler;
  negotiator: BuyerPaymentNegotiator;
  buyerConn: PeerConnection;
  chain: Map<string, ChainChannel>;
  sessionChannelId(): string;
  oneOffChannelIds(): string[];
  reserve: ReturnType<typeof vi.fn>;
  topUp: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  /** What the seller's read of the buyer's available deposits returns from now on. */
  setSellerAvailable(amount: bigint): void;
  /** Lets a create held by `holdCreates` reach the provider's answer. */
  releaseCreate(): void;
  /** A fresh seller payment manager on the same identity, channel store and chain, as after a restart. */
  restartSeller(): SellerPaymentManager;
  disconnect(): void;
  providerCreates: SerializedHttpRequest[];
  sentAuths: SpendingAuthPayload[];
  releaseTopUp(): void;
  send(request: SerializedHttpRequest, stream?: { onResponseStart(): void; onResponseChunk(): void }): ReturnType<BuyerRequestHandler['sendRequest']>;
  videoRequest(requestId: string, duration?: string): SerializedHttpRequest;
  retrieveRequest(requestId: string, queueId: string): SerializedHttpRequest;
  chatRequest(requestId: string): SerializedHttpRequest;
  settle(): Promise<void>;
  /** A fresh buyer payment manager on the same identity and channel store, as after a restart. */
  restartBuyer(): BuyerPaymentManager;
  /** A negotiator for a restarted buyer, on the same store and chain. */
  negotiatorFor(bpm: BuyerPaymentManager): BuyerPaymentNegotiator;
  buyerStore: ChannelStore;
  buyerChannel(channelId: string): { status: string } | null;
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
    retrieveStatus?: 'FAILED' | 'REFUSED_400' | 'BUSY_429';
    createResponse?: 'rejected';
    /** Hold each video create at the provider until releaseCreate(). */
    holdCreates?: boolean;
    availableBalance?: bigint;
    /** Available deposits the seller's own read sees, when it differs from the buyer's (funds withdrawn or spent meanwhile). */
    sellerAvailableBalance?: bigint;
    reserveEstimateOverdraftUsdc?: bigint;
    freeTier?: { consume: ReturnType<typeof vi.fn>; reportUsageRequest: ReturnType<typeof vi.fn> };
    /** Chat request IDs the seller's upstream answers with a 502. */
    failChats?: string[];
    /** A streamed upstream answer for a chat, or null to fall through to the buffered one. */
    streamChat?: (request: SerializedHttpRequest, callbacks: { onResponseStart(start: any): void; onResponseChunk(chunk: any): void | Promise<void> }) => Promise<any | null>;
    chatBody?: (request: SerializedHttpRequest) => { statusCode: number; body: unknown } | null;
    maxPerRequestUsdc?: bigint;
    requestTimeoutMs?: number;
    /** Deliver frames sent together as one chunk (see connectionPair). */
    coalesceFrames?: boolean;
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
      maxPerRequestUsdc: options.maxPerRequestUsdc ?? 500_000n,
      maxReserveAmountUsdc: FIRST_RESERVE,
      maxVideoRequestUsdc: 5_000_000n,
      dataDir: join(directory, 'buyer'),
    };
    const buyer = new BuyerPaymentManager(buyerIdentity, buyerConfig, buyerStore);
    buyer.setSigner(buyerIdentity.wallet);
    let sellerAvailable = options.sellerAvailableBalance ?? options.availableBalance ?? 20_000_000n;
    const sellerConfig = {
      ...common, dataDir: join(directory, 'seller'), minBudgetPerRequest: '10000',
      readBuyerAvailableDeposit: vi.fn(async () => sellerAvailable),
    };
    const seller = new SellerPaymentManager(sellerIdentity, sellerConfig, sellerStore);

    // Every on-chain channel, keyed by channelId, shared by both sides through the same ChannelsClient.
    let releaseTopUp: (() => void) | null = null;
    const topUpBehavior = options.topUpBehavior ?? 'land';
    const { chain, reserve, topUp, close } = fakeChannelChain(seller.channelsClient, {
      buyerAddress: buyerIdentity.wallet.address,
      sellerAddress: sellerIdentity.wallet.address,
      firstSignCap: FIRST_SIGN_CAP,
      beforeTopUp: async () => {
        if (topUpBehavior === 'revert') throw new Error('execution reverted: InsufficientBalance');
        if (topUpBehavior === 'slow') await new Promise<void>((resolve) => { releaseTopUp = resolve; });
      },
    });

    const providerCreates: SerializedHttpRequest[] = [];
    const heldCreates: Array<() => void> = [];
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
        if (options.streamChat && request.path === '/v1/chat/completions') {
          const streamed = await options.streamChat(request, callbacks);
          if (streamed) return streamed;
        }
        if (!request.path.endsWith('/video/retrieve')) return provider.handleRequest(request);
        if (options.retrieveStatus === 'REFUSED_400' || options.retrieveStatus === 'BUSY_429') {
          const refused = options.retrieveStatus === 'REFUSED_400';
          return {
            requestId: request.requestId, statusCode: refused ? 400 : 429,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ message: refused ? 'No person detected' : 'slow down', status: refused ? 400 : 429 })),
          };
        }
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
          if (options.holdCreates) await new Promise<void>((resolve) => { heldCreates.push(resolve); });
          if (options.createResponse === 'rejected') {
            return { requestId: request.requestId, statusCode: 400, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: 'content policy' })) };
          }
          jobCounter += 1;
          return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ queue_id: `job-${jobCounter}`, status: 'PENDING' })) };
        }
        const custom = options.chatBody?.(request);
        if (custom) return { requestId: request.requestId, statusCode: custom.statusCode, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(custom.body)) };
        if (options.failChats?.includes(request.requestId)) {
          return { requestId: request.requestId, statusCode: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: 'upstream unavailable' })) };
        }
        return {
          requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ id: 'chat', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 1000, total_tokens: 1000 } })),
        };
      }),
    };

    const { buyerSide, sellerSide } = connectionPair(options.coalesceFrames);

    // Seller side, wired like AntseedNode._handleIncomingConnection.
    const sellerPayment = new PaymentMux(sellerSide);
    const sellerVerification = new VerificationMux(sellerSide);
    sellerPayment.onSpendingAuth((payload) => { void seller.handleSpendingAuth(buyerIdentity.peerId, payload, sellerPayment); });
    sellerPayment.onCloseChannelRequest((payload) => {
      void seller.handleCloseChannelRequest(buyerIdentity.peerId, payload, sellerPayment).then((result) => sellerPayment.sendCloseChannelResult(result));
    });
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
    const buyerHandler = new BuyerRequestHandler({ requestTimeoutMs: options.requestTimeoutMs ?? 120_000 }, {
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
      buyerIdentity, sellerIdentity, peer, buyer, seller, buyerHandler, negotiator, buyerConn: buyerSide, chain, sessionChannelId, oneOffChannelIds,
      reserve, topUp, close, providerCreates, sentAuths,
      setSellerAvailable: (amount) => { sellerAvailable = amount; },
      releaseCreate: () => { const release = heldCreates.shift(); expect(release).toBeDefined(); release!(); },
      restartSeller: () => {
        const restarted = new SellerPaymentManager(sellerIdentity, sellerConfig, sellerStore);
        // The same chain: the restarted seller's transactions and reads reach the fake contract.
        (restarted as unknown as { _channelsClient: unknown })._channelsClient = seller.channelsClient;
        return restarted;
      },
      disconnect: () => seller.onBuyerDisconnect(buyerIdentity.peerId),
      releaseTopUp: () => { expect(releaseTopUp).not.toBeNull(); releaseTopUp!(); },
      send: (request, stream) => buyerHandler.sendRequest(peer, request, stream ?? (request.path.endsWith('/video/retrieve') ? { onResponseStart() {}, onResponseChunk() {} } : undefined)),
      videoRequest,
      retrieveRequest,
      chatRequest,
      // Several rounds: a delivery's charge (NeedAuth → SpendingAuth → close) crosses the wire more than once,
      // and one fixed wait was too short on a loaded machine.
      settle: async () => {
        for (let round = 0; round < 4; round += 1) {
          await negotiator.drainPendingNeedAuth();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      restartBuyer: () => new BuyerPaymentManager(buyerIdentity, buyerConfig, buyerStore),
      negotiatorFor: (bpm) => new BuyerPaymentNegotiator(buyerIdentity, bpm, new DepositsClient({
        rpcUrl: common.rpcUrl, contractAddress: '0x' + 'dd'.repeat(20), usdcAddress: '0x' + 'ee'.repeat(20), evmChainId: 31337,
      } as any), seller.channelsClient, buyerStore, {}, { emit: vi.fn() }),
      buyerStore,
      buyerChannel: (channelId) => buyerStore.getChannel(channelId) as { status: string } | null,
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

  it('charges each chat once through the seller NeedAuth the request handler made chargeable', async () => {
    const h = setup();
    const needAuth = vi.spyOn(h.buyer, 'handleNeedAuth');
    await openChannelWithChat(h);
    expect((await h.send(h.chatRequest('chat-2'))).statusCode).toBe(200);
    await h.settle();
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(2n * CHAT_DELIVERED);

    // Both charges came from the seller's NeedAuth, each naming the request the handler sent.
    const charges = needAuth.mock.calls.map(([, payload]) => payload).filter((payload) => payload.lastRequestCost != null);
    expect(charges.map((payload) => [payload.requestId, payload.lastRequestCost])).toEqual([
      ['chat-1', CHAT_DELIVERED.toString()],
      ['chat-2', CHAT_DELIVERED.toString()],
    ]);

    // Replaying a charge, or charging a request the buyer never sent, signs nothing.
    const mux = { sendSpendingAuth: vi.fn() } as unknown as PaymentMux;
    await h.buyer.handleNeedAuth(h.peer.peerId, { ...charges[1]!, requiredCumulativeAmount: (3n * CHAT_DELIVERED).toString() }, mux);
    await h.buyer.handleNeedAuth(h.peer.peerId, { ...charges[1]!, requestId: 'never-sent', requiredCumulativeAmount: (3n * CHAT_DELIVERED).toString() }, mux);
    expect(mux.sendSpendingAuth).not.toHaveBeenCalled();
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(2n * CHAT_DELIVERED);
  });

  it('counts a seller cost only up to what the chat response the buyer received shows', async () => {
    const h = setup();
    await openChannelWithChat(h);
    // The seller serves chat-2 but claims five times its cost, with token counts to match.
    const honest: NeedAuthPayload[] = [];
    const handle = h.buyer.handleNeedAuth.bind(h.buyer);
    vi.spyOn(h.buyer, 'handleNeedAuth').mockImplementation((peerId, payload, mux) => {
      if (payload.lastRequestCost == null) return handle(peerId, payload, mux);
      honest.push(payload);
      const times5 = (value: string | undefined): string => (BigInt(value ?? '0') * 5n).toString();
      return handle(peerId, {
        ...payload,
        lastRequestCost: times5(payload.lastRequestCost),
        inputTokens: times5(payload.inputTokens),
        freshInputTokens: times5(payload.freshInputTokens),
        outputTokens: times5(payload.outputTokens),
        requiredCumulativeAmount: (CHAT_DELIVERED + 5n * CHAT_DELIVERED).toString(),
      }, mux);
    });
    expect((await h.send(h.chatRequest('chat-2'))).statusCode).toBe(200);
    await h.settle();
    expect(honest.map((payload) => [payload.requestId, payload.lastRequestCost])).toEqual([['chat-2', CHAT_DELIVERED.toString()]]);

    // The buyer priced chat-2 from the response it received: that much, within
    // the 1.4x cost tolerance, is verified. The rest of the claim is not.
    const verified = CHAT_DELIVERED + CHAT_DELIVERED * 14n / 10n;
    expect(h.buyer.getVerifiedCost(h.peer.peerId), 'verified a cost the response does not show').toBe(verified);
    // The seller asked for 6x a chat in total and got what is verified plus the overdraft window.
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(6n * CHAT_DELIVERED < verified + 500_000n ? 6n * CHAT_DELIVERED : verified + 500_000n);

    // chat-2 is counted: its honest frame, sent now, adds nothing.
    const mux = { sendSpendingAuth: vi.fn() } as unknown as PaymentMux;
    await handle(h.peer.peerId, { ...honest[0]!, requiredCumulativeAmount: (10n * CHAT_DELIVERED).toString() }, mux);
    expect(mux.sendSpendingAuth).not.toHaveBeenCalled();
    expect(h.buyer.getVerifiedCost(h.peer.peerId)).toBe(verified);
  });

  it('charges parallel chats exactly once each', async () => {
    const h = setup();
    await openChannelWithChat(h);
    const answers = await Promise.all(['chat-2', 'chat-3', 'chat-4', 'chat-5'].map((id) => h.send(h.chatRequest(id))));
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200, 200]);
    await h.settle();
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(5n * CHAT_DELIVERED);
    expect(h.buyer.getVerifiedCost(h.peer.peerId)).toBe(5n * CHAT_DELIVERED);
  });

  it('does not sign for a chat whose upstream failed, whatever the seller claims for it', async () => {
    const h = setup({ failChats: ['chat-2'] });
    await openChannelWithChat(h);
    // The seller claims a full chat's cost for the request its upstream failed.
    const handle = h.buyer.handleNeedAuth.bind(h.buyer);
    vi.spyOn(h.buyer, 'handleNeedAuth').mockImplementation((peerId, payload, mux) => handle(peerId, payload.requestId === 'chat-2' ? {
      ...payload,
      lastRequestCost: CHAT_DELIVERED.toString(), outputTokens: '1000',
      requiredCumulativeAmount: (2n * CHAT_DELIVERED).toString(),
    } : payload, mux));
    expect((await h.send(h.chatRequest('chat-2'))).statusCode).toBe(502);
    await h.settle();
    expect(h.buyer.getCumulativeAmount(h.peer.peerId), 'signed for a failed chat').toBe(CHAT_DELIVERED);
    expect(h.buyer.getVerifiedCost(h.peer.peerId)).toBe(CHAT_DELIVERED);

    // The next chat is served and charged as usual.
    expect((await h.send(h.chatRequest('chat-3'))).statusCode).toBe(200);
    await h.settle();
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(2n * CHAT_DELIVERED);
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

  it('records a delivery whose request billing other requests evicted while it streamed', async () => {
    const h = setup();
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);

    const evict = () => { for (let i = 0; i < 600; i += 1) h.buyer.trackRequestBilling(`other-${i}`, { context: { service: 'chat' } } as never); };
    const delivered = await h.send(h.retrieveRequest('retrieve-1', 'job-1'), { onResponseStart: evict, onResponseChunk() {} });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.headers['x-antseed-video-delivered']).toBe('1');
    await h.settle();

    expect(h.close.mock.calls.find((call) => call[1] === channelId)?.[2]).toBe(VIDEO_PRICE);
    // Delivered once and never again: the job is no longer chargeable.
    expect(h.buyer.trackVideoRetrieve(h.peer.peerId, 'venice-video', 'job-1', 'retrieve-2')).toBe(false);
  });

  it('pays the seller but does not report a delivery while the job cannot be removed from storage', async () => {
    const h = setup();
    await h.send(h.videoRequest('video-1'));
    await h.settle();

    // A job still stored comes back after a restart and could be charged again: the download is not a delivery.
    const store = (h.buyer as unknown as { _channelStore: { upsertChannel: (record: { channelKind?: string; oneOffVideoJob?: string | null }) => unknown } })._channelStore;
    const upsert = store.upsertChannel.bind(store);
    let failing: ReturnType<typeof vi.spyOn> | null = null;
    // Only the write that clears the delivered job fails (for example a lock held just then).
    const failWrites = () => {
      failing = vi.spyOn(store, 'upsertChannel').mockImplementation((record) => {
        // Cleared is null in an older row, a record without a job in a newer one.
        const stored = record.oneOffVideoJob ? JSON.parse(record.oneOffVideoJob) : null;
        const clearsJob = record.channelKind === 'one_off' && (stored === null || (stored.v === 2 && !stored.jobId && !stored.job));
        if (clearsJob) throw new Error('database is locked');
        return upsert(record);
      });
    };
    const response = await h.send(h.retrieveRequest('retrieve-1', 'job-1'), { onResponseStart: failWrites, onResponseChunk() {} });
    // The file is fine and the seller is paid for it, but the job is not reported delivered (nor retired).
    expect(response.headers['x-antseed-video-delivered']).toBe('unrecorded');
    await h.settle();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(VIDEO_PRICE);
    expect((await h.send(h.retrieveRequest('retrieve-2', 'job-1'))).headers['x-antseed-video-delivered']).toBe('unrecorded');

    failing!.mockRestore();
    const again = await h.send(h.retrieveRequest('retrieve-3', 'job-1'));
    expect(again.headers['x-antseed-video-delivered']).toBe('1');
    await h.settle();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('does not mark a download delivered when its job is no longer tracked', async () => {
    const h = setup();
    await h.send(h.videoRequest('video-1'));
    await h.settle();

    // Another path ended the job while its file streamed: the stream is not a delivery the job can be charged for.
    const forget = () => { (h.buyer as unknown as { _videoJobs: Map<string, unknown> })._videoJobs.clear(); };
    const response = await h.send(h.retrieveRequest('retrieve-1', 'job-1'), { onResponseStart: forget, onResponseChunk() {} });
    expect(response.headers['x-antseed-video-delivered']).toBeUndefined();
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

  it.each(['flat', 'per-second'] as const)('counts the delivered video in signed metadata for %s pricing', async (videoPricing) => {
    const h = setup({ videoPricing });
    await openChannelWithChat(h);
    expect((await h.send(h.videoRequest('video-counted'))).statusCode).toBe(200);
    await h.settle();
    expect((await h.send(h.retrieveRequest('download-counted', 'job-1'))).statusCode).toBe(200);
    await h.settle();

    expect(h.close).toHaveBeenCalledOnce();
    const [, , , , , videoGenerations, videoSeconds] = AbiCoder.defaultAbiCoder().decode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      h.close.mock.calls[0]![3] as string,
    );
    expect(videoGenerations).toBe(1n);
    expect(videoSeconds).toBe(5n);
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
    // The buyer forgets the channel, but keeps it stored as active so it can still request-close it.
    expect(h.buyerChannel(channelId)?.status).toBe('active');
    expect(h.buyer.getOneOffChannelForRequest(h.peer.peerId, 'video-1')).toBeNull();
  });

  it('keeps the job open when retrieve answers a JSON 400, so a bad retrieve cannot close a live job', async () => {
    const h = setup({ retrieveStatus: 'REFUSED_400' });
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);
    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(400);
    await h.settle();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.buyerChannel(channelId)?.status).toBe('active');
  });

  it('keeps the job open when retrieve is only rate limited', async () => {
    const h = setup({ retrieveStatus: 'BUSY_429' });
    await h.send(h.videoRequest('video-1'));
    await h.settle();
    const { channelId } = onlyOneOff(h);
    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(429);
    await h.settle();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.buyerChannel(channelId)?.status).toBe('active');
  });

  it('closes at 0 with no topUp when the provider refuses the create', async () => {
    const h = setup({ createResponse: 'rejected' });

    const response = await h.send(h.videoRequest('video-1'));
    await h.settle();

    expect(response.statusCode).toBe(400);
    const { channelId } = onlyOneOff(h);
    // The buyer's threshold auth and top-up were held, never sent: nothing was settled.
    expect(h.topUp).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(0n);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n, status: 2 });
    expect(h.seller.getChannel(channelId)).toMatchObject({ status: 'settled', settledAmount: '0' });
    expect(h.buyer.getOneOffChannelForRequest(h.peer.peerId, 'video-1')).toBeNull();
  });

  it('keeps the threshold auth out of every stored or settleable place until the create is accepted', async () => {
    const h = setup({ holdCreates: true, createResponse: 'rejected' });

    const pending = h.send(h.videoRequest('video-1'));
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));
    const { channelId } = onlyOneOff(h);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n, status: 1 });
    expect(h.seller.getChannel(channelId)).toMatchObject({ authMax: '0', latestSpendingAuthSig: null });
    expect(h.seller.getAcceptedCumulative(channelId)).toBe(0n);
    expect(h.topUp).not.toHaveBeenCalled();

    h.releaseCreate();
    expect((await pending).statusCode).toBe(400);
    await h.settle();
    expect(h.close.mock.calls.map((call) => call[2])).toEqual([0n]);
  });

  it('closes a refused create at 0 through the timed-out retry when its closes keep failing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = setup({ createResponse: 'rejected' });
    const landOnChain = h.close.getMockImplementation()!;
    h.close.mockImplementation(async () => { throw new Error('execution reverted: SomethingElse'); });

    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(400);
    await h.settle();
    const { channelId } = onlyOneOff(h);
    // Three failed closes give the channel up to the slow timed-out retry.
    for (let attempt = 0; attempt < 3; attempt += 1) await h.seller.checkTimeouts();
    expect(h.seller.isOneOffChannel(channelId)).toBe(false);
    expect(h.seller.getChannel(channelId)?.status).toBe('timeout');

    h.close.mockImplementation(landOnChain);
    advanceClock(11 * 60_000);
    await h.seller.checkTimeouts();

    expect(h.close.mock.calls.every((call) => call[2] === 0n)).toBe(true);
    expect(h.chain.get(channelId)).toMatchObject({ settled: 0n, status: 2 });
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
    expect(h.close.mock.calls[1]![2]).toBe(0n);
    expect(h.chain.get(channelId)).toMatchObject({ settled: 0n, status: 2 });
    expect(h.seller.isOneOffChannel(channelId)).toBe(false);
  });

  it('keeps a job whose topUp after accept reverts at the serious fee, and holds the buyer back like an unpaid video', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = setup({ topUpBehavior: 'revert' });
    await openChannelWithChat(h);

    // The buyer withdrew the rest of the price after the seller's check: the create runs, its topUp reverts.
    const response = await h.send(h.videoRequest('video-1'));
    await h.settle();

    expect(response.statusCode).toBe(200);
    expect(h.providerCreates).toHaveLength(1);
    const { channelId } = onlyOneOff(h);
    expect(h.topUp).toHaveBeenCalledOnce();
    // The channel stays at its opening reserve, with the threshold auth as the most it can settle.
    expect(h.close).not.toHaveBeenCalled();
    expect(h.chain.get(channelId)).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n, status: 1 });
    expect(h.seller.getAcceptedCumulative(channelId)).toBe(SERIOUS_FEE);
    expect(h.seller.getChannel(channelId)).toMatchObject({ authMax: SERIOUS_FEE.toString(), latestReserveAuthSig: null });
    // One running job alone does not hold the buyer back.
    expect(h.seller.videoJobHold(h.buyerIdentity.peerId, 'next')).toBeNull();

    // Its delivery cannot be paid on this channel: the buyer is held back as for any video it took without paying.
    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.seller.videoJobHold(h.buyerIdentity.peerId, 'next')?.code).toBe('video_payment_pending');

    // The TTL closes it at no more than the serious fee.
    advanceClock(24 * 60 * 60_000 + 1);
    await h.seller.checkTimeouts();
    expect(h.close.mock.calls.map((call) => [call[1], call[2]])).toEqual([[channelId, SERIOUS_FEE]]);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: FIRST_RESERVE, settled: SERIOUS_FEE, status: 2 });
    expect(h.chain.get(h.sessionChannelId())).toMatchObject({ status: 1 });
  });

  it('runs no more jobs whose topUp fails than the open-jobs limit allows', async () => {
    const h = setup({ topUpBehavior: 'revert' });

    const answers = await sendVideos(h, UNPAID_LIMIT + 2, 'unfunded');

    expect(statusesOf(answers)).toEqual([...repeat(200, UNPAID_LIMIT), 409, 409]);
    expect(errorOf(answers.at(-1)!).code).toBe('video_jobs_open_limit');
    expect(h.providerCreates).toHaveLength(UNPAID_LIMIT);
    expect(h.close).not.toHaveBeenCalled();
  }, 60_000);

  it('does not run a create sent before the AuthAck while the deposit check is still reading', async () => {
    const h = setup();
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    const config = (h.seller as unknown as { _config: { readBuyerAvailableDeposit: () => Promise<bigint> } })._config;
    const read = vi.fn(async () => { await readHeld; return 0n; });
    config.readBuyerAvailableDeposit = read;

    const waitingForAck = h.send(h.videoRequest('video-1'));
    waitingForAck.catch(() => undefined);
    await vi.waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 3_000 });
    const { channelId } = onlyOneOff(h);

    // A buyer that does not wait for the AuthAck: the channel cannot be claimed yet.
    expect(h.seller.getOneOffChannelForRequest(h.buyerIdentity.peerId, 'video-1')).toBeNull();
    expect(h.seller.claimOneOffChannel(channelId)).toBe(false);

    releaseRead();
    await expect(waitingForAck).rejects.toMatchObject({ code: 'buyer-session-state' });
    await h.settle();
    expect(h.providerCreates).toHaveLength(0);
    expect(h.close.mock.calls.map((call) => call[2])).toEqual([0n]);
  });

  it('does not hand out a job its channel closed under, and charges nothing for it', async () => {
    const h = setup({ holdCreates: true });
    const pending = h.send(h.videoRequest('video-1'));
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));
    const { channelId } = onlyOneOff(h);

    // Something closes the channel while the create is with the provider.
    expect(await h.seller.closeOneOffChannel(channelId, 'closed under the create')).toBe(true);
    h.releaseCreate();
    const response = await pending;
    await h.settle();

    expect(response.statusCode).toBe(503);
    expect(h.topUp).not.toHaveBeenCalled();
    expect(h.close.mock.calls.map((call) => call[2])).toEqual([0n]);
    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).not.toBe(200);
  });

  it('keeps an accepted, topped-up channel open when the periodic check read it before the accept', async () => {
    const h = setup({ holdCreates: true });
    const pending = h.send(h.videoRequest('video-1'));
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));
    const { channelId } = onlyOneOff(h);

    // The periodic check reads the store, then waits on the chain read.
    const readChain = vi.mocked(h.seller.channelsClient.getSession).getMockImplementation()!;
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    let holdNext = true;
    vi.mocked(h.seller.channelsClient.getSession).mockImplementation(async (id) => {
      if (holdNext) { holdNext = false; await readHeld; }
      return readChain(id);
    });
    const check = h.seller.checkTimeouts();

    // Meanwhile the provider accepts and the topUp lands.
    h.releaseCreate();
    expect((await pending).statusCode).toBe(200);
    await vi.waitFor(() => expect(h.seller.getReserveMax(channelId)).toBe(VIDEO_PRICE));

    releaseRead();
    await check;
    await h.settle();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.chain.get(channelId)).toMatchObject({ deposit: VIDEO_PRICE, settled: SERIOUS_FEE, status: 1 });

    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close.mock.calls.map((call) => call[2])).toEqual([VIDEO_PRICE]);
  });

  it('runs only as many parallel creates as the buyer deposits can top up', async () => {
    const h = setup();
    // Deposits cover the rest of one price beyond its opening reserve; a landed topUp locks it.
    const rest = VIDEO_PRICE - FIRST_RESERVE;
    const config = (h.seller as unknown as { _config: { readBuyerAvailableDeposit: () => Promise<bigint> } })._config;
    config.readBuyerAvailableDeposit = async () => {
      const locked = [...h.chain.values()].filter((channel) => channel.status === 1 && channel.deposit > FIRST_RESERVE)
        .reduce((sum, channel) => sum + channel.deposit - FIRST_RESERVE, 0n);
      return rest - locked;
    };

    const answers = await Promise.all([h.send(h.videoRequest('video-a')), h.send(h.videoRequest('video-b'))]);
    await h.settle();

    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    const refused = answers.find((answer) => answer.statusCode === 409)!;
    expect(errorOf(refused).code).toBe('one_off_channel_unfunded');
    expect(h.providerCreates).toHaveLength(1);
    expect(h.topUp).toHaveBeenCalledOnce();
    expect(h.close.mock.calls.map((call) => call[2])).toEqual([0n]);
  });

  it('refuses the create before it runs when the buyer deposits cannot cover the rest of the price', async () => {
    // The buyer could cover the whole price when it checked; by the seller's read it no longer can.
    const h = setup({ sellerAvailableBalance: VIDEO_PRICE - FIRST_RESERVE - 1n });
    await openChannelWithChat(h);

    await expect(h.send(h.videoRequest('video-1'))).rejects.toMatchObject({ code: 'buyer-session-state' });
    await h.settle();

    expect(h.providerCreates).toHaveLength(0);
    expect(h.topUp).not.toHaveBeenCalled();
    const sessionId = h.sessionChannelId();
    const videoChannels = [...h.chain.keys()].filter((channelId) => channelId !== sessionId);
    expect(videoChannels).toHaveLength(1);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![1]).toBe(videoChannels[0]);
    expect(h.close.mock.calls[0]![2]).toBe(0n);
    expect(h.chain.get(videoChannels[0]!)).toMatchObject({ settled: 0n, status: 2 });
    expect(h.buyer.getOneOffChannelForRequest(h.peer.peerId, 'video-1')).toBeNull();
    expect(h.chain.get(sessionId)).toMatchObject({ status: 1 });
  });

  it('sends the topUp only after the provider accepts the create, and charges the price on delivery', async () => {
    const h = setup();
    const landOnChain = h.topUp.getMockImplementation()!;
    let createsSeenByTopUp = -1;
    h.topUp.mockImplementation(async (...args: unknown[]) => {
      createsSeenByTopUp = h.providerCreates.length;
      return landOnChain(...args);
    });

    const response = await h.send(h.videoRequest('video-1'));
    await h.settle();

    expect(response.statusCode).toBe(200);
    expect(h.topUp).toHaveBeenCalledOnce();
    expect(createsSeenByTopUp).toBe(1);
    const { channelId } = onlyOneOff(h);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: VIDEO_PRICE, settled: SERIOUS_FEE, status: 1 });
    expect(h.seller.getReserveMax(channelId)).toBe(VIDEO_PRICE);

    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(VIDEO_PRICE);
    expect(h.chain.get(channelId)).toMatchObject({ settled: VIDEO_PRICE, status: 2 });
  });

  it('charges a delivery that arrives while the topUp after accept is still mining, once it lands', async () => {
    const h = setup({ topUpBehavior: 'slow' });

    // The create is answered while the topUp is still mining.
    const response = await Promise.race([h.send(h.videoRequest('video-1')), new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000))]);
    expect(response?.statusCode).toBe(200);
    await vi.waitFor(() => expect(h.topUp).toHaveBeenCalledOnce());
    const { channelId } = onlyOneOff(h);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n });

    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close).not.toHaveBeenCalled();

    h.releaseTopUp();
    await h.settle();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0]![2]).toBe(VIDEO_PRICE);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: VIDEO_PRICE, settled: VIDEO_PRICE, status: 2 });
  });

  it('keeps the serious fee when the buyer requests close while the create is with the provider', async () => {
    const h = setup({ holdCreates: true });
    const pending = h.send(h.videoRequest('video-1'));
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));
    const { channelId } = onlyOneOff(h);

    // The buyer's operator calls requestClose() on-chain; the contract then refuses the topUp.
    const readChain = vi.mocked(h.seller.channelsClient.getSession).getMockImplementation()!;
    vi.mocked(h.seller.channelsClient.getSession).mockImplementation(async (id) => ({ ...(await readChain(id)), closeRequestedAt: 1n }));
    await h.seller.handleCloseRequested(channelId);
    h.topUp.mockImplementation(async () => { throw new Error('execution reverted: CloseAlreadyRequested'); });
    h.releaseCreate();
    expect((await pending).statusCode).toBe(200);
    await h.settle();

    expect(h.close.mock.calls.map((call) => call[2])).toEqual([SERIOUS_FEE]);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: FIRST_RESERVE, settled: SERIOUS_FEE, status: 2 });
  });

  it('closes at 0 after a seller restart between the reserve and the create being accepted', async () => {
    const h = setup({ holdCreates: true });
    const pending = h.send(h.videoRequest('video-1'));
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));
    const { channelId } = onlyOneOff(h);

    const restarted = h.restartSeller();
    await restarted.validateHydratedChannels();

    expect(h.topUp).not.toHaveBeenCalled();
    expect(h.close.mock.calls.map((call) => [call[1], call[2]])).toEqual([[channelId, 0n]]);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n, status: 2 });
    expect(restarted.isOneOffChannel(channelId)).toBe(false);
    expect(restarted.getChannel(channelId)).toMatchObject({ status: 'settled', settledAmount: '0' });
  });

  it('tops up after a seller restart between the create being accepted and its topUp landing', async () => {
    const h = setup();
    const landOnChain = h.topUp.getMockImplementation()!;
    // The first topUp is sent but never mines before the seller stops.
    h.topUp.mockImplementationOnce(() => new Promise<string>(() => {}));
    const pending = h.send(h.videoRequest('video-1'));
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(h.topUp).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(h.providerCreates).toHaveLength(1);
    const { channelId } = onlyOneOff(h);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: FIRST_RESERVE, settled: 0n, status: 1 });

    h.topUp.mockImplementation(landOnChain);
    const restarted = h.restartSeller();
    await restarted.validateHydratedChannels();
    await vi.waitFor(() => expect(h.topUp).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(restarted.getReserveMax(channelId)).toBe(VIDEO_PRICE));

    expect(h.topUp.mock.calls[1]![2]).toBe(SERIOUS_FEE);
    expect(h.topUp.mock.calls[1]![5]).toBe(VIDEO_PRICE);
    expect(h.chain.get(channelId)).toMatchObject({ deposit: VIDEO_PRICE, settled: SERIOUS_FEE, status: 1 });
    expect(h.close).not.toHaveBeenCalled();
  });

  it('retries a top-up whose RPC node has not seen the reserve yet', async () => {
    const h = setup();
    await openChannelWithChat(h);
    h.topUp.mockImplementationOnce(async () => {
      throw new Error('estimateGas reverted data="0xac853123"');
    });

    const response = await h.send(h.videoRequest('video-1'));
    await h.settle();

    expect(response.statusCode).toBe(200);
    // The top-up runs after accept, in the background: its retry lands after a short wait.
    await vi.waitFor(() => expect(h.topUp).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(h.seller.getReserveMax(onlyOneOff(h).channelId)).toBe(VIDEO_PRICE));
    expect(h.close).not.toHaveBeenCalled();
  });

  it('keeps a reserved channel whose deposit check and release both failed, and closes it on the next check', async () => {
    const h = setup({ sellerAvailableBalance: 0n });
    await openChannelWithChat(h);
    const landOnChain = h.close.getMockImplementation()!;
    h.close.mockImplementationOnce(async () => {
      throw new Error('execution reverted: ChannelNotActive');
    });

    // The buyer keeps waiting for the channel while the seller still holds it.
    const pending = h.send(h.videoRequest('video-1'));
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce());

    const sessionId = h.sessionChannelId();
    const [videoChannel] = [...h.chain.keys()].filter((channelId) => channelId !== sessionId);
    expect(h.chain.get(videoChannel!)).toMatchObject({ status: 1 });
    // The seller still knows the channel, so it is not orphaned on-chain.
    expect(h.seller.isOneOffChannel(videoChannel!)).toBe(true);
    // It cost the seller gas and is still open, so it keeps counting against the buyer.
    const offer = { openingReserveAmount: '800000', requiredCumulativeAmount: '0', requestCost: '800000' };
    for (let index = 1; index < 16; index += 1) expect(h.seller.registerOneOffPlan(h.buyerIdentity.peerId, `offer-${index}`, offer)).toBeNull();
    expect(h.seller.registerOneOffPlan(h.buyerIdentity.peerId, 'one-too-many', offer)).toBe(5);

    h.close.mockImplementation(landOnChain);
    await h.seller.checkTimeouts();
    await expect(pending).rejects.toMatchObject({ code: 'buyer-session-state' });

    expect(h.close).toHaveBeenCalledTimes(2);
    expect(h.close.mock.calls[1]![1]).toBe(videoChannel);
    expect(h.close.mock.calls[1]![2]).toBe(0n);
    expect(h.chain.get(videoChannel!)).toMatchObject({ settled: 0n, status: 2 });
    expect(h.seller.isOneOffChannel(videoChannel!)).toBe(false);
  });

  it('reports the serious fee as spent only once the channel holds it', async () => {
    const opened = setup();
    await openChannelWithChat(opened);
    const openedSpends: string[] = [];
    opened.buyer.setSpendListener((event) => { openedSpends.push(event.amountUsdc); });
    expect((await opened.send(opened.videoRequest('video-1'))).statusCode).toBe(200);
    expect(openedSpends).toEqual([SERIOUS_FEE.toString()]);

    const failed = setup({ sellerAvailableBalance: 0n });
    await openChannelWithChat(failed);
    const failedSpends: string[] = [];
    failed.buyer.setSpendListener((event) => { failedSpends.push(event.amountUsdc); });
    await expect(failed.send(failed.videoRequest('video-1'))).rejects.toMatchObject({ code: 'buyer-session-state' });
    expect(failedSpends).toEqual([]);
  });

  it('reports nothing as spent for a create the provider refuses', async () => {
    const h = setup({ createResponse: 'rejected' });
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });

    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(400);
    await h.settle();

    expect(h.chain.get(onlyOneOff(h).channelId)).toMatchObject({ settled: 0n, status: 2 });
    expect(spends).toEqual([]);
  });

  it('reports the serious fee for a refused create an older seller had already taken it for', async () => {
    const h = setup({ createResponse: 'rejected', holdCreates: true });
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });

    const pending = h.send(h.videoRequest('video-1'));
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));
    // An older seller tops up, taking the serious fee, before it sends the create on.
    Object.assign(h.chain.get(onlyOneOff(h).channelId)!, { deposit: VIDEO_PRICE, settled: SERIOUS_FEE });
    h.releaseCreate();
    expect((await pending).statusCode).toBe(400);
    await h.settle();

    expect(spends).toEqual([SERIOUS_FEE.toString()]);
  });

  it('reports the serious fee when the create is accepted, and the rest of the price on delivery', async () => {
    const h = setup();
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });

    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(200);
    expect(spends).toEqual([SERIOUS_FEE.toString()]);

    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(spends).toEqual([SERIOUS_FEE.toString(), (VIDEO_PRICE - SERIOUS_FEE).toString()]);
  });

  it('reports the serious fee of a create that got no answer at once, and only once', async () => {
    for (const outcome of ['refused', 'accepted'] as const) {
      const h = setup({ holdCreates: true, requestTimeoutMs: 300, ...(outcome === 'refused' ? { createResponse: 'rejected' as const } : {}) });
      const spends: string[] = [];
      h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });

      await expect(h.send(h.videoRequest('video-1'))).rejects.toBeDefined();
      // Nothing more will tell the buyer whether the seller took the fee: it is reported while the request is attributable.
      expect(spends).toEqual([SERIOUS_FEE.toString()]);

      h.releaseCreate();
      const { channelId } = onlyOneOff(h);
      if (outcome === 'refused') {
        await vi.waitFor(() => expect(h.chain.get(channelId)).toMatchObject({ settled: 0n, status: 2 }));
      } else {
        await vi.waitFor(() => expect(h.chain.get(channelId)).toMatchObject({ settled: SERIOUS_FEE }));
        // The seller closes an uncollected job at the serious fee.
        h.chain.get(channelId)!.status = 2;
      }
      await h.negotiator.reconcileChannelsWithChain();

      expect(h.buyerChannel(channelId)?.status).not.toBe('active');
      expect(spends).toEqual([SERIOUS_FEE.toString()]);
    }
  });

  it('reports a fee a refused channel settles after the buyer read it, once the reconcile sees the close', async () => {
    const h = setup({ createResponse: 'rejected' });
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });
    let releaseClose!: () => void;
    const closeHeld = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.close.mockImplementationOnce(async (_signer: unknown, id: string) => {
      await closeHeld;
      Object.assign(h.chain.get(id)!, { settled: SERIOUS_FEE, status: 2 });
      return '0xclose';
    });

    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(400);
    await h.settle();
    const { channelId } = onlyOneOff(h);
    expect(h.chain.get(channelId)).toMatchObject({ settled: 0n, status: 1 });
    // Still open: the buyer waits for the close instead of taking 0 as final.
    expect(h.buyerChannel(channelId)?.status).toBe('active');
    expect(h.buyer.getOneOffChannelForRequest(h.peer.peerId, 'video-1')).toBeNull();
    expect(spends).toEqual([]);

    releaseClose();
    await vi.waitFor(() => expect(h.chain.get(channelId)).toMatchObject({ settled: SERIOUS_FEE, status: 2 }));
    await h.negotiator.reconcileChannelsWithChain();
    await h.negotiator.reconcileChannelsWithChain();

    expect(h.buyerChannel(channelId)?.status).not.toBe('active');
    expect(spends).toEqual([SERIOUS_FEE.toString()]);
  });

  it('reports the fee of a channel another process retired beside the running buyer', async () => {
    const { reconcileStoredChannels } = await import('@antseed/buyer-core');
    const h = setup({ createResponse: 'rejected', holdCreates: true });
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });
    let releaseClose!: () => void;
    const closeHeld = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.close.mockImplementationOnce(async (_signer: unknown, id: string) => {
      await closeHeld;
      Object.assign(h.chain.get(id)!, { settled: SERIOUS_FEE, status: 2 });
      return '0xclose';
    });
    const pending = h.send(h.videoRequest('video-1'));
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));
    h.releaseCreate();
    expect((await pending).statusCode).toBe(400);
    const { channelId } = onlyOneOff(h);
    releaseClose();
    await vi.waitFor(() => expect(h.chain.get(channelId)).toMatchObject({ status: 2 }));

    // `antseed buyer status` beside the running buyer: it retires the row and tells nobody.
    await reconcileStoredChannels({
      store: h.buyerStore, channels: h.seller.channelsClient, buyerEvmAddr: h.buyerIdentity.wallet.address,
      sessions: { mayEndSession: () => false, sessionEnded: () => {}, oneOffEnded: () => {} },
    });
    expect(h.buyerChannel(channelId)?.status).not.toBe('active');
    await h.negotiator.reconcileChannelsWithChain();

    expect(spends).toEqual([SERIOUS_FEE.toString()]);
  });

  it('reports an accepted job that failed once across a buyer restart', async () => {
    const h = setup({ retrieveStatus: 'FAILED' });
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });
    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(200);
    const { channelId } = onlyOneOff(h);
    await h.send(h.retrieveRequest('retrieve-1', 'job-1'));
    await h.settle();
    expect(h.chain.get(channelId)).toMatchObject({ settled: SERIOUS_FEE, status: 2 });
    expect(spends).toEqual([SERIOUS_FEE.toString()]);

    const restarted = h.restartBuyer();
    restarted.setSpendListener((event) => { spends.push(event.amountUsdc); });
    await h.negotiatorFor(restarted).reconcileChannelsWithChain();

    expect(spends).toEqual([SERIOUS_FEE.toString()]);
  });

  it('reports a delivered job once when the buyer restarts before signing for it', async () => {
    const h = setup();
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });
    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(200);
    const { channelId } = onlyOneOff(h);
    h.buyer.recordVideoDelivered(h.peer.peerId, 'venice-video', 'job-1', 'retrieve-x');

    const restarted = h.restartBuyer();
    restarted.setSpendListener((event) => { spends.push(event.amountUsdc); });
    Object.assign(h.chain.get(channelId)!, { settled: SERIOUS_FEE, status: 2 });
    await h.negotiatorFor(restarted).reconcileChannelsWithChain();

    expect(spends).toEqual([SERIOUS_FEE.toString()]);
  });

  it('reports the fee of a create whose outcome a buyer restart lost, at the first sweep', async () => {
    const h = setup({ holdCreates: true });
    const pending = h.send(h.videoRequest('video-1'));
    pending.catch(() => {});
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));

    // The buyer stops with the create at the provider; the restarted one never hears its answer.
    const restarted = h.restartBuyer();
    const spends: string[] = [];
    restarted.setSpendListener((event) => { spends.push(event.amountUsdc); });
    const negotiator = h.negotiatorFor(restarted);
    await negotiator.reconcileChannelsWithChain();
    expect(spends).toEqual([SERIOUS_FEE.toString()]);

    h.releaseCreate();
    const { channelId } = onlyOneOff(h);
    await vi.waitFor(() => expect(h.chain.get(channelId)).toMatchObject({ settled: SERIOUS_FEE }));
    h.chain.get(channelId)!.status = 2;
    await negotiator.reconcileChannelsWithChain();
    expect(spends).toEqual([SERIOUS_FEE.toString()]);
  });

  it('reports nothing for a create the caller gave up on before it was sent', async () => {
    const h = setup();
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });
    const handleAuthAck = h.buyer.handleAuthAck.bind(h.buyer);
    const held: Array<() => Promise<void>> = [];
    vi.spyOn(h.buyer, 'handleAuthAck').mockImplementation(async (peerId, payload) => {
      if (!h.oneOffChannelIds().includes(payload.channelId)) return handleAuthAck(peerId, payload);
      held.push(() => handleAuthAck(peerId, payload));
    });
    const controller = new AbortController();
    const pending = h.buyerHandler.sendRequest(h.peer, h.videoRequest('video-1'), undefined, { signal: controller.signal });
    pending.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    controller.abort(new DOMException('caller gave up', 'AbortError'));
    await held[0]!();
    await expect(pending).rejects.toBeDefined();
    await h.settle();

    expect(h.providerCreates).toHaveLength(0);
    const { channelId } = onlyOneOff(h);
    // The seller releases the unclaimed channel at 0.
    h.chain.get(channelId)!.status = 2;
    await h.negotiator.reconcileChannelsWithChain();
    expect(spends).toEqual([]);
  });

  it('reports the fee of a refused channel its seller leaves open past the grace', async () => {
    const h = setup({ createResponse: 'rejected' });
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });
    // A seller that refuses and keeps the channel, holding the fee signature.
    h.close.mockImplementation(async () => { throw new Error('execution reverted: not yet'); });
    vi.useFakeTimers({ toFake: ['Date'] });
    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(400);
    await h.settle();
    await h.negotiator.reconcileChannelsWithChain();
    expect(spends).toEqual([]);

    // Inside the hour a gateway still counts it.
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await h.negotiator.reconcileChannelsWithChain();
    expect(spends).toEqual([SERIOUS_FEE.toString()]);
    await h.negotiator.reconcileChannelsWithChain();
    expect(spends).toEqual([SERIOUS_FEE.toString()]);
  });

  it('waits for a pass that reads the chain before reporting a restored create whose outcome is unknown', async () => {
    const h = setup({ holdCreates: true, createResponse: 'rejected' });
    const pending = h.send(h.videoRequest('video-1'));
    pending.catch(() => {});
    await vi.waitFor(() => expect(h.providerCreates).toHaveLength(1));
    // The first process stops here and hears nothing more.
    vi.spyOn(h.buyer, 'retireRefusedOneOffChannel').mockResolvedValue();
    const restarted = h.restartBuyer();
    const spends: string[] = [];
    restarted.setSpendListener((event) => { spends.push(event.amountUsdc); });
    const negotiator = h.negotiatorFor(restarted);
    h.releaseCreate();
    const { channelId } = onlyOneOff(h);
    await vi.waitFor(() => expect(h.chain.get(channelId)).toMatchObject({ settled: 0n, status: 2 }));

    const getSession = vi.spyOn(h.seller.channelsClient, 'getSession').mockRejectedValue(new Error('rpc down'));
    await negotiator.reconcileChannelsWithChain();
    expect(spends).toEqual([]);
    getSession.mockRestore();
    await negotiator.reconcileChannelsWithChain();

    // Read closed at 0: nothing was spent.
    expect(spends).toEqual([]);
  });

  it('stores a video channel record an older release still reads', async () => {
    const h = setup();
    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(200);
    const { channelId } = onlyOneOff(h);
    // An older release reads the record as the job itself.
    const accepted = JSON.parse(h.buyerStore.getChannel(channelId)!.oneOffVideoJob!);
    expect(accepted).toMatchObject({ protocol: 'venice-video', jobId: 'job-1', reported: SERIOUS_FEE.toString() });
    expect(Date.now() - accepted.createdAtMs).toBeLessThan(60_000);
    expect(accepted.entry.context.sellerPeerId).toBe(h.peer.peerId);

    h.buyer.recordVideoFailed(h.peer.peerId, 'venice-video', 'job-1');
    // With no job left, it is one that release drops as expired.
    expect(JSON.parse(h.buyerStore.getChannel(channelId)!.oneOffVideoJob!)).toMatchObject({ createdAtMs: 0, reported: SERIOUS_FEE.toString() });
  });

  it('does not send the create early to a seller that acknowledges only after a slow topUp', async () => {
    const h = setup();
    const handleAuthAck = h.buyer.handleAuthAck.bind(h.buyer);
    const heldAcks: Array<() => Promise<void>> = [];
    vi.spyOn(h.buyer, 'handleAuthAck').mockImplementation(async (peerId, payload) => {
      if (!h.oneOffChannelIds().includes(payload.channelId)) return handleAuthAck(peerId, payload);
      heldAcks.push(() => handleAuthAck(peerId, payload));
    });
    vi.useFakeTimers({ toFake: ['Date'] });

    const pending = h.send(h.videoRequest('video-1'));
    pending.catch(() => {});
    await vi.waitFor(() => expect(heldAcks).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    // Well past the full-reserve grace, with only the opening reserve on-chain: an older seller still mining its topUp.
    vi.setSystemTime(Date.now() + 31_000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(h.providerCreates).toHaveLength(0);

    await heldAcks[0]!();
    expect((await pending).statusCode).toBe(200);
    expect(h.providerCreates).toHaveLength(1);
  }, 15_000);

  it('does not report an accepted job again when its channel closes after a buyer restart', async () => {
    const h = setup();
    expect((await h.send(h.videoRequest('video-1'))).statusCode).toBe(200);
    const { channelId } = onlyOneOff(h);
    const restarted = h.restartBuyer();
    const spends: string[] = [];
    restarted.setSpendListener((event) => { spends.push(event.amountUsdc); });

    restarted.forgetOneOffChannel(channelId, SERIOUS_FEE);

    expect(spends).toEqual([]);
  });

  it('confirms a video channel from the chain at its opening reserve when the AuthAck is lost', async () => {
    const h = setup();
    const handleAuthAck = h.buyer.handleAuthAck.bind(h.buyer);
    vi.spyOn(h.buyer, 'handleAuthAck').mockImplementation(async (peerId, payload) => {
      if (h.oneOffChannelIds().includes(payload.channelId)) return;
      return handleAuthAck(peerId, payload);
    });
    vi.useFakeTimers({ toFake: ['Date'] });

    const pending = h.send(h.videoRequest('video-1'));
    pending.catch(() => {});
    await vi.waitFor(() => expect(h.oneOffChannelIds()).toHaveLength(1));
    await vi.waitFor(() => expect(h.chain.get(h.oneOffChannelIds()[0]!)).toMatchObject({ deposit: FIRST_RESERVE, status: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    // The wait runs out with the opening reserve on-chain and no AuthAck.
    vi.setSystemTime(Date.now() + 46_000);

    const response = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5_000))]);
    expect(response).toMatchObject({ statusCode: 200 });
    expect(h.topUp).toHaveBeenCalledOnce();
  }, 15_000);

  it('reports the serious fee once when an AuthAck and an on-chain confirmation overlap', async () => {
    const h = setup({ topUpBehavior: 'slow' });
    await openChannelWithChat(h);
    const spends: string[] = [];
    h.buyer.setSpendListener((event) => { spends.push(event.amountUsdc); });
    const pending = h.send(h.videoRequest('video-1'));
    await vi.waitFor(() => expect(h.topUp).toHaveBeenCalledOnce());
    const [channelId] = h.oneOffChannelIds();

    // Hold both confirmations inside the channel-store flush.
    let releaseFlush!: () => void;
    const flushed = new Promise<void>((resolve) => { releaseFlush = resolve; });
    Object.assign((h.buyer as unknown as { _channelStore: object })._channelStore, { flush: () => flushed });
    const confirmations = Promise.all([
      h.buyer.handleAuthAck(h.peer.peerId, { channelId: channelId! }),
      h.buyer.confirmOneOffChannelOnChain(channelId!, VIDEO_PRICE),
    ]);
    releaseFlush();
    await confirmations;
    h.releaseTopUp();
    expect((await pending).statusCode).toBe(200);

    expect(spends).toEqual([SERIOUS_FEE.toString()]);
  });

  it('does not evict a just-reserved channel the chain read does not show yet', async () => {
    const h = setup();
    await openChannelWithChat(h);
    const response = await h.send(h.videoRequest('video-1'));
    await h.settle();
    expect(response.statusCode).toBe(200);
    const { channelId } = onlyOneOff(h);
    const record = h.chain.get(channelId)!;
    h.chain.delete(channelId);

    await h.seller.checkTimeouts();

    expect(h.seller.isOneOffChannel(channelId)).toBe(true);
    h.chain.set(channelId, record);
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

  // ── Channels that earn the seller nothing ──────────────────────────────

  /** One-off channels a buyer may have earning nothing before the seller stops offering more. */
  const UNPAID_LIMIT = 16;

  /** A client looping on an answer: the same create, one at a time, each under a new request ID. */
  async function sendVideos(h: Harness, count: number, label: string) {
    const answers: Array<Awaited<ReturnType<Harness['send']>>> = [];
    for (let index = 0; index < count; index += 1) answers.push(await h.send(h.videoRequest(`${label}-${index}`)));
    await h.settle();
    return answers;
  }

  const statusesOf = (answers: Array<{ statusCode: number }>) => answers.map((answer) => answer.statusCode);
  const errorOf = (answer: { body: Uint8Array }) => JSON.parse(Buffer.from(answer.body).toString()).error as { code: string; message: string; jobs: Array<{ id: string; protocol: string }> };
  const jobIdsOf = (answer: { body: Uint8Array }) => errorOf(answer).jobs.map((job) => job.id);
  const repeat = <T,>(value: T, count: number): T[] => Array.from({ length: count }, () => value);
  const advanceClock = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it('stops reserving for a buyer whose creates the provider keeps refusing', async () => {
    const h = setup({ videoPricing: 'cheap', createResponse: 'rejected' });

    const answers = await sendVideos(h, UNPAID_LIMIT + 4, 'refused');

    expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT);
    expect(h.close).toHaveBeenCalledTimes(UNPAID_LIMIT);
    expect(h.providerCreates).toHaveLength(UNPAID_LIMIT);
    expect(statusesOf(answers)).toEqual([...repeat(400, UNPAID_LIMIT), ...repeat(429, 4)]);
    const heldBack = answers.at(-1)!;
    expect(JSON.parse(Buffer.from(heldBack.body).toString()).error.code).toBe('one_off_channel_backoff');
    expect(Number(heldBack.headers['retry-after'])).toBeGreaterThan(0);
  }, 30_000);

  it('offers one more channel each time the wait has passed, doubling the wait up to an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = setup({ videoPricing: 'cheap', createResponse: 'rejected' });
    await sendVideos(h, UNPAID_LIMIT, 'refused');

    const waits = [60, 120, 240, 480, 960, 1_920, 3_600, 3_600];
    for (const [index, waitSeconds] of waits.entries()) {
      const early = await h.send(h.videoRequest(`early-${index}`));
      expect(early.statusCode).toBe(429);
      expect(early.headers['retry-after']).toBe(String(waitSeconds));

      advanceClock(waitSeconds * 1_000);
      expect((await h.send(h.videoRequest(`probe-${index}`))).statusCode).toBe(400);
      await h.settle();
      expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT + index + 1);
    }
  }, 30_000);

  it('stops counting channels closed more than a day ago', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = setup({ videoPricing: 'cheap', createResponse: 'rejected' });
    await sendVideos(h, UNPAID_LIMIT, 'refused');
    expect((await h.send(h.videoRequest('held-back'))).statusCode).toBe(429);

    advanceClock(24 * 60 * 60_000 + 1);

    expect(statusesOf(await sendVideos(h, UNPAID_LIMIT, 'next-day'))).toEqual(repeat(400, UNPAID_LIMIT));
    expect((await h.send(h.videoRequest('held-back-again'))).statusCode).toBe(429);
  }, 30_000);

  it('bounds a burst of parallel creates, which all arrive before any is refused', async () => {
    const h = setup({ videoPricing: 'cheap', createResponse: 'rejected' });

    const answers = await Promise.all(Array.from({ length: UNPAID_LIMIT + 8 }, (_, index) => h.send(h.videoRequest(`burst-${index}`))));
    await h.settle();

    expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT);
    expect(statusesOf(answers).filter((status) => status === 429)).toHaveLength(8);
  }, 30_000);

  it('serves a whole parallel batch up to the limit, and charges each video', async () => {
    const h = setup({ videoPricing: 'cheap' });

    const answers = await Promise.all(Array.from({ length: UNPAID_LIMIT }, (_, index) => h.send(h.videoRequest(`batch-${index}`))));
    await h.settle();

    expect(statusesOf(answers)).toEqual(repeat(200, UNPAID_LIMIT));
    expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT);
    for (let job = 1; job <= UNPAID_LIMIT; job += 1) expect((await h.send(h.retrieveRequest(`retrieve-${job}`, `job-${job}`))).statusCode).toBe(200);
    await h.settle();
    expect(h.close.mock.calls.map((call) => call[2])).toEqual(repeat(800_000n, UNPAID_LIMIT));
  }, 30_000);

  it('asks the rest of a batch above the limit to retry shortly, and serves it once the buyer collects as many', async () => {
    const h = setup({ videoPricing: 'cheap' });

    const answers = await Promise.all(Array.from({ length: UNPAID_LIMIT + 4 }, (_, index) => h.send(h.videoRequest(`batch-${index}`))));
    await h.settle();

    const heldBack = answers.flatMap((answer, index) => (answer.statusCode === 429 ? [{ answer, index }] : []));
    expect(heldBack).toHaveLength(4);
    for (const { answer } of heldBack) expect(answer.headers['retry-after']).toBe('5');

    // The accepted batch is still uncollected: the retries wait for it.
    const tooEarly = await Promise.all(heldBack.map(({ index }) => h.send(h.videoRequest(`batch-${index}`))));
    expect(statusesOf(tooEarly)).toEqual(repeat(409, 4));
    for (const answer of tooEarly) expect(errorOf(answer).code).toBe('video_jobs_open_limit');

    for (let job = 1; job <= 4; job += 1) expect((await h.send(h.retrieveRequest(`retrieve-${job}`, `job-${job}`))).statusCode).toBe(200);
    await h.settle();

    const retried = await Promise.all(heldBack.map(({ index }) => h.send(h.videoRequest(`batch-${index}`))));
    expect(statusesOf(retried)).toEqual(repeat(200, 4));
    expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT + 4);
  }, 30_000);

  it('starts counting again once the buyer pays for a video, which is charged as usual', async () => {
    const options: { videoPricing: 'cheap'; createResponse?: 'rejected' } = { videoPricing: 'cheap', createResponse: 'rejected' };
    const h = setup(options);
    expect(statusesOf(await sendVideos(h, UNPAID_LIMIT - 1, 'before'))).toEqual(repeat(400, UNPAID_LIMIT - 1));

    delete options.createResponse;
    expect((await h.send(h.videoRequest('accepted'))).statusCode).toBe(200);
    await h.settle();
    const closesBeforeDelivery = h.close.mock.calls.length;
    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close).toHaveBeenCalledTimes(closesBeforeDelivery + 1);
    expect(h.close.mock.calls.at(-1)![2]).toBe(800_000n);

    options.createResponse = 'rejected';
    expect(statusesOf(await sendVideos(h, UNPAID_LIMIT - 1, 'after'))).toEqual(repeat(400, UNPAID_LIMIT - 1));
  }, 30_000);

  it('holds back a buyer with as many uncollected jobs as the limit, until it collects one', async () => {
    const h = setup({ videoPricing: 'cheap' });

    const answers = await sendVideos(h, UNPAID_LIMIT + 2, 'running');
    expect(statusesOf(answers)).toEqual([...repeat(200, UNPAID_LIMIT), 409, 409]);
    expect(answers.at(-1)!.headers['retry-after']).toBe('5');
    expect(errorOf(answers.at(-1)!)).toMatchObject({
      code: 'video_jobs_open_limit',
      message: `You have ${UNPAID_LIMIT} videos on this seller that are not downloaded yet. Download one before starting another here. Their job IDs are in error.jobs.`,
    });
    expect(jobIdsOf(answers.at(-1)!)).toEqual(Array.from({ length: UNPAID_LIMIT }, (_, index) => `job-${index + 1}`));
    expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT);
    expect(h.close).not.toHaveBeenCalled();

    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close.mock.calls.map((call) => call[2])).toEqual([800_000n]);

    expect((await h.send(h.videoRequest('after-collecting'))).statusCode).toBe(200);
    expect((await h.send(h.videoRequest('limit-again'))).statusCode).toBe(409);
  }, 30_000);

  it('does not hold back a buyer for one job left uncollected for over an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = setup({ videoPricing: 'cheap' });
    expect((await h.send(h.videoRequest('first'))).statusCode).toBe(200);
    await h.settle();

    // A job stuck upstream stays uncollected however often the buyer polls; it counts toward the limit only.
    advanceClock(2 * 60 * 60_000);
    expect((await h.send(h.videoRequest('after-an-old-job'))).statusCode).toBe(200);
    expect(h.reserve).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('holds back a buyer that took a video without signing for it', async () => {
    const h = setup({ videoPricing: 'cheap' });
    vi.spyOn(h.buyer, 'handleNeedAuth').mockResolvedValue(undefined);
    expect((await h.send(h.videoRequest('first'))).statusCode).toBe(200);
    expect((await h.send(h.retrieveRequest('retrieve-1', 'job-1'))).statusCode).toBe(200);
    await h.settle();
    expect(h.close).not.toHaveBeenCalled();

    const heldBack = await h.send(h.videoRequest('unpaid'));
    expect(heldBack.statusCode).toBe(409);
    expect(errorOf(heldBack).code).toBe('video_payment_pending');
    expect(jobIdsOf(heldBack)).toEqual(['job-1']);
    expect(heldBack.headers['retry-after']).toBe('5');
    expect(h.reserve).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('counts a video that was accepted and then failed: the buyer paid nothing for it', async () => {
    const h = setup({ videoPricing: 'cheap', retrieveStatus: 'FAILED' });

    for (let index = 1; index <= UNPAID_LIMIT; index += 1) {
      expect((await h.send(h.videoRequest(`video-${index}`))).statusCode).toBe(200);
      await h.send(h.retrieveRequest(`retrieve-${index}`, `job-${index}`));
      await h.settle();
    }

    expect(h.close).toHaveBeenCalledTimes(UNPAID_LIMIT);
    expect((await h.send(h.videoRequest('next'))).statusCode).toBe(429);
    expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT);
  }, 30_000);

  it('counts refused creates above the first-sign cap, which now close at 0', async () => {
    const h = setup({ createResponse: 'rejected' });

    const answers = await sendVideos(h, UNPAID_LIMIT + 4, 'refused');

    expect(statusesOf(answers)).toEqual([...repeat(400, UNPAID_LIMIT), ...repeat(429, 4)]);
    expect(JSON.parse(Buffer.from(answers.at(-1)!.body).toString()).error.code).toBe('one_off_channel_backoff');
    expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT);
    expect(h.topUp).not.toHaveBeenCalled();
    expect(h.close.mock.calls.map((call) => call[2])).toEqual(repeat(0n, UNPAID_LIMIT));
  }, 30_000);

  it('counts a channel refused for want of deposits: the buyer paid nothing for it', async () => {
    const h = setup({ sellerAvailableBalance: 0n });

    const answers = await Promise.allSettled(Array.from({ length: UNPAID_LIMIT + 4 }, (_, index) => h.send(h.videoRequest(`burst-${index}`))));
    await h.settle();

    expect(h.reserve).toHaveBeenCalledTimes(UNPAID_LIMIT);
    expect(answers.filter((answer) => answer.status === 'rejected')).toHaveLength(UNPAID_LIMIT);
    expect((await h.send(h.videoRequest('after'))).statusCode).toBe(429);
  }, 60_000);

  it('spends one reserve on a buyer retrying a refused chat, whose channel stays open for the retries', async () => {
    const h = setup({ chatBody: () => ({ statusCode: 400, body: { error: 'refused' } }) });

    for (let index = 0; index < 5; index += 1) expect((await h.send(h.chatRequest(`chat-${index}`))).statusCode).toBe(400);
    await h.settle();

    expect(h.reserve).toHaveBeenCalledOnce();
    expect(h.close).not.toHaveBeenCalled();
  });

  // ── Review probes ──────────────────────────────────────────────────────

  const sse = (events: unknown[]): Uint8Array => Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const spentOnSession = (h: Harness): bigint => h.seller.getCumulativeSpend(h.sessionChannelId());

  /** An OpenAI chat stream of `completionTokens` output tokens (priced at $100/M), held open at `gate` after its first chunk. */
  function streamedChat(completionTokens: number, gate?: Promise<void>, only?: string[]) {
    return async (request: SerializedHttpRequest, callbacks: { onResponseStart(start: any): void; onResponseChunk(chunk: any): void | Promise<void> }) => {
      if (only && !only.includes(request.requestId)) return null;
      const start = { requestId: request.requestId, statusCode: 200, body: new Uint8Array(0), headers: { 'content-type': 'text/event-stream', 'x-antseed-streaming': '1' } };
      const first = sse([{ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hel' } }] }]);
      const rest = Buffer.concat([sse([
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] },
        { id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens } },
      ]), Buffer.from('data: [DONE]\n\n')]);
      callbacks.onResponseStart(start);
      await callbacks.onResponseChunk({ requestId: request.requestId, data: first, done: false });
      if (gate) await gate;
      await callbacks.onResponseChunk({ requestId: request.requestId, data: rest, done: false });
      await callbacks.onResponseChunk({ requestId: request.requestId, data: new Uint8Array(0), done: true });
      return { ...start, body: Buffer.concat([first, rest]) };
    };
  }

  /** The seller holds the whole stream until `gate`, so a buyer that gives up first has received nothing. */
  function heldChat(completionTokens: number, gate: Promise<void>, only: string[]) {
    const streamed = streamedChat(completionTokens, undefined, only);
    return async (request: SerializedHttpRequest, callbacks: { onResponseStart(start: any): void; onResponseChunk(chunk: any): void | Promise<void> }) => {
      if (!only.includes(request.requestId)) return null;
      await gate;
      return streamed(request, callbacks);
    };
  }

  it('pays the seller for a request the buyer aborted before any byte arrived, up to the output the request allows, without parking the next chat', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // A $0.05 window: smaller than the aborted chat, so only the request's own limit can verify it.
    const h = setup({ maxPerRequestUsdc: 50_000n, streamChat: heldChat(1_000, gate, ['chat-2']) });
    await openChannelWithChat(h);
    const abort = new AbortController();
    const aborted = h.buyerHandler.sendRequest(h.peer, h.chatRequest('chat-2'), { onResponseStart() {}, onResponseChunk() {} }, { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    await expect(aborted).rejects.toThrow(/aborted/);
    // The seller finishes it anyway: 1,000 output tokens, the request's max_tokens.
    release();
    await h.settle();
    expect(spentOnSession(h)).toBe(2n * CHAT_DELIVERED);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId), 'the aborted chat was not paid').toBe(2n * CHAT_DELIVERED);

    const startedAt = Date.now();
    expect((await h.send(h.chatRequest('chat-3'))).statusCode).toBe(200);
    expect(Date.now() - startedAt, 'parked for the seller catch-up wait').toBeLessThan(4_500);
    await h.settle();
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(spentOnSession(h));
  }, 30_000);

  it('a streamed chat the buyer receives in full is charged exactly once, at the cost both sides parse from the stream', async () => {
    const h = setup({ streamChat: streamedChat(2_000, undefined, ['chat-2']) });
    await openChannelWithChat(h);
    const response = await h.buyerHandler.sendRequest(h.peer, h.chatRequest('chat-2'), { onResponseStart() {}, onResponseChunk() {} });
    expect(response.statusCode).toBe(200);
    await h.settle();
    expect(spentOnSession(h)).toBe(CHAT_DELIVERED + 200_000n);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED + 200_000n);
    expect(h.buyer.getVerifiedCost(h.peer.peerId)).toBe(CHAT_DELIVERED + 200_000n);
  });

  it('a response and its cost frame that arrive in one chunk: the response is recorded before the frame is judged', async () => {
    // The seller sends its cost frame right behind the response. Nothing waits for the buyer's response path:
    // it must have recorded the response by the time the frame is judged, or every such claim would be refused.
    const h = setup({ coalesceFrames: true, streamChat: streamedChat(2_000, undefined, ['chat-2']) });
    await openChannelWithChat(h);
    expect((await h.buyerHandler.sendRequest(h.peer, h.chatRequest('chat-2'), { onResponseStart() {}, onResponseChunk() {} })).statusCode).toBe(200);
    const startedAt = Date.now();
    expect((await h.send(h.chatRequest('chat-3'))).statusCode).toBe(200);
    expect(Date.now() - startedAt, 'parked for the seller catch-up wait').toBeLessThan(4_500);
    await h.settle();
    expect(spentOnSession(h)).toBe(2n * CHAT_DELIVERED + 200_000n);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(spentOnSession(h));
    expect(h.buyer.getVerifiedCost(h.peer.peerId), 'a claim was judged before its response was recorded').toBe(spentOnSession(h));
  }, 30_000);

  it('cooperative close right after a chat: the channel closes at exactly what was served', async () => {
    const h = setup();
    await openChannelWithChat(h);
    expect((await h.send(h.chatRequest('chat-2'))).statusCode).toBe(200);
    // No settle(): the close races the seller's NeedAuth for chat-2.
    let result = await h.negotiator.requestChannelClose(h.peer.peerId, h.buyerConn as any);
    for (let attempt = 0; attempt < 5 && result.status !== 'closed' && result.code === 'busy'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      result = await h.negotiator.requestChannelClose(h.peer.peerId, h.buyerConn as any);
    }
    expect(`${result.status}:${result.code ?? ''}`).toBe('closed:');
    expect(result.finalAmount).toBe((2n * CHAT_DELIVERED).toString());
  }, 30_000);

  it('pays the seller for a stream the buyer aborted, priced up to what the request allows, and the next chat is not parked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The aborted chat costs $0.60, above the $0.50 overdraft window.
    const h = setup({ streamChat: streamedChat(6_000, gate, ['chat-2']) });
    await openChannelWithChat(h);

    const abort = new AbortController();
    const aborted = h.buyerHandler.sendRequest(h.peer, h.chatRequest('chat-2'), {
      onResponseStart() {},
      onResponseChunk() { abort.abort(); },
    }, { signal: abort.signal });
    await expect(aborted).rejects.toThrow(/aborted/);
    // The seller is not told: it finishes the stream and bills it.
    release();
    await h.settle();
    expect(spentOnSession(h), 'the seller billed the aborted chat').toBe(CHAT_DELIVERED + 600_000n);
    const signedAfterAbort = h.buyer.getCumulativeAmount(h.peer.peerId);

    const startedAt = Date.now();
    const next = await h.send(h.chatRequest('chat-3'));
    const elapsed = Date.now() - startedAt;
    await h.settle();
    console.log(`[probe] aborted $0.60 stream: signed right after=${signedAfterAbort}; next chat status=${next.statusCode} after ${elapsed}ms; signed=${h.buyer.getCumulativeAmount(h.peer.peerId)} verified=${h.buyer.getVerifiedCost(h.peer.peerId)} spent=${spentOnSession(h)}`);
    expect(next.statusCode).toBe(200);
    expect(signedAfterAbort, 'the cost frame for the aborted chat is answered').toBe(CHAT_DELIVERED + 600_000n);
    expect(elapsed, 'parked for the seller catch-up wait').toBeLessThan(4_500);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(spentOnSession(h));
  }, 30_000);

  it('closes cooperatively after an aborted stream above the window', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = setup({ streamChat: streamedChat(6_000, gate, ['chat-2']) });
    await openChannelWithChat(h);
    const abort = new AbortController();
    const aborted = h.buyerHandler.sendRequest(h.peer, h.chatRequest('chat-2'), {
      onResponseStart() {},
      onResponseChunk() { abort.abort(); },
    }, { signal: abort.signal });
    await expect(aborted).rejects.toThrow(/aborted/);
    release();
    await h.settle();

    const spentBeforeClose = spentOnSession(h);
    const outcomes: string[] = [];
    let finalAmount: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await h.negotiator.requestChannelClose(h.peer.peerId, h.buyerConn as any);
      finalAmount = result.finalAmount;
      outcomes.push(`${result.status}:${result.code ?? ''}`);
      await h.settle();
      if (result.status === 'closed') break;
    }
    console.log(`[probe] close after an aborted $0.60 stream: ${outcomes.join(', ')}; signed=${h.buyer.getCumulativeAmount(h.peer.peerId)} spent=${spentBeforeClose}`);
    expect(outcomes.at(-1)).toBe('closed:');
    expect(spentBeforeClose).toBe(CHAT_DELIVERED + 600_000n);
    expect(finalAmount, 'closed at what the seller served').toBe(spentBeforeClose.toString());
  }, 60_000);

  it('pays nothing for an error answer that carries a usage block, by NeedAuth or at close', async () => {
    const h = setup({ chatBody: (request) => request.requestId === 'chat-2'
      ? { statusCode: 500, body: { error: 'boom', usage: { prompt_tokens: 0, completion_tokens: 3_000, total_tokens: 3_000 } } }
      : null });
    await openChannelWithChat(h);
    const needAuth = vi.spyOn(h.buyer, 'handleNeedAuth');
    const ownSigning = vi.spyOn(h.buyer, 'signPerRequestAuth');
    expect((await h.send(h.chatRequest('chat-2'))).statusCode).toBe(500);
    await h.settle();
    const afterError = h.buyer.getCumulativeAmount(h.peer.peerId);
    const claimed = needAuth.mock.calls.map(([, payload]) => payload).find((payload) => payload.requestId === 'chat-2');
    const sentBeforeClose = h.sentAuths.length;
    const result = await h.negotiator.requestChannelClose(h.peer.peerId, h.buyerConn as any);
    const ownSigned = ownSigning.mock.calls.map(([, stats]) => `${stats.requestId}:${stats.sellerClaimedCost}`);
    const signedByBuyerItself = h.sentAuths[sentBeforeClose]?.cumulativeAmount;
    console.log(`[probe] error answer with usage: seller claimed ${claimed?.lastRequestCost}; signed after the error=${afterError}; buyer's own signing at close=${ownSigned.join(',')} -> cumulative ${signedByBuyerItself}; close=${result.status}:${result.code ?? ''} finalAmount=${result.finalAmount}`);
    expect(afterError, 'the NeedAuth cost for the error answer is refused').toBe(CHAT_DELIVERED);
    expect(ownSigned, 'the close signs for the last response, not the error answer').toEqual(['chat-1:100000']);
    expect(signedByBuyerItself, 'the error answer was paid at close').toBe(CHAT_DELIVERED.toString());
  }, 30_000);

  it('a seller billing a cut-off stream past what the request allows is paid inside the overdraft window, and the next chat on a new channel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = setup({ maxPerRequestUsdc: 200_000n, streamChat: streamedChat(7_000, gate, ['chat-2']) });
    await openChannelWithChat(h);
    const abort = new AbortController();
    const aborted = h.buyerHandler.sendRequest(h.peer, h.chatRequest('chat-2'), {
      onResponseStart() {},
      onResponseChunk() { abort.abort(); },
    }, { signal: abort.signal });
    await expect(aborted).rejects.toThrow(/aborted/);
    release();
    await h.settle();
    expect(spentOnSession(h)).toBe(CHAT_DELIVERED + 700_000n);
    // The mock streams 7,000 output tokens for a request that allows 1,000. The buyer counts chat-2
    // at the most the request allows within the 1.4x tolerance ($0.14) and signs the rest of the claim
    // only inside the $0.20 overdraft window: $0.10 + $0.14 + $0.20.
    const firstChannel = h.sessionChannelId();
    const signedOnFirst = 440_000n;
    expect(h.buyer.getVerifiedCost(h.peer.peerId)).toBe(CHAT_DELIVERED + 140_000n);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(signedOnFirst);

    const startedAt = Date.now();
    const next = await h.send(h.chatRequest('chat-3'));
    const elapsed = Date.now() - startedAt;
    await h.settle();
    console.log(`[probe] $0.20 window, aborted $0.70 stream: next chat status=${next.statusCode} ${Buffer.from(next.body).toString().slice(0, 120)} after ${elapsed}ms; signed=${h.buyer.getCumulativeAmount(h.peer.peerId)} spent=${spentOnSession(h)}`);
    // The seller holds chat-3 for its catch-up wait, then answers 402 for the rest of chat-2. The buyer
    // received nothing it has not paid for, so its retry signs nothing more: it retires the channel and
    // pays chat-3 on a new one.
    const highestSigned = (channelId: string): bigint => h.sentAuths
      .filter((auth) => auth.channelId === channelId)
      .reduce((highest, auth) => (BigInt(auth.cumulativeAmount) > highest ? BigInt(auth.cumulativeAmount) : highest), 0n);
    expect(highestSigned(firstChannel), 'signed more on the first channel after the 402').toBe(signedOnFirst);
    expect(h.buyerChannel(firstChannel)?.status).toBe('ghost');
    expect(h.sessionChannelId()).not.toBe(firstChannel);
    expect(h.reserve).toHaveBeenCalledTimes(2);
    expect(next.statusCode).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(highestSigned(h.sessionChannelId())).toBe(CHAT_DELIVERED);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(spentOnSession(h));
  }, 60_000);

  // An attempt the seller can end itself: only the overdraft window pays for it.

  /**
   * The seller answers nothing for the chats in `only` until the test releases them (in the order they arrived),
   * then bills 1,400 output tokens for a request that allows 1,000: the most the cost tolerance would let through.
   */
  function stalledChats(only: string[]) {
    const gates: Array<() => void> = [];
    const streamChat = async (request: SerializedHttpRequest, callbacks: { onResponseStart(start: any): void; onResponseChunk(chunk: any): void | Promise<void> }) => {
      if (!only.includes(request.requestId)) return null;
      return heldChat(1_400, new Promise<void>((resolve) => { gates.push(resolve); }), only)(request, callbacks);
    };
    return { streamChat, gates };
  }

  it('a seller that drops the connection on every request has nothing verified and is paid at most the overdraft window', async () => {
    const ids = ['drop-1', 'drop-2', 'drop-3', 'drop-4', 'drop-5', 'drop-6'];
    const { streamChat, gates } = stalledChats(ids);
    const h = setup({ streamChat });
    await openChannelWithChat(h);
    for (const id of ids) {
      const dropped = h.buyerHandler.sendRequest(h.peer, h.chatRequest(id), { onResponseStart() {}, onResponseChunk() {} });
      // The buyer sees the connection close with nothing received.
      setTimeout(() => (h.buyerConn as any).emitState(ConnectionState.Closed), 20);
      await expect(dropped).rejects.toThrow(/closed during request/);
      // Once its bills have used up the window, the seller holds the next request for its catch-up wait.
      const release = gates.shift();
      if (!release) break;
      release();
      await h.settle();
    }
    console.log(`[probe] requests the seller dropped, billing 140000 each: signed=${h.buyer.getCumulativeAmount(h.peer.peerId)} verified=${h.buyer.getVerifiedCost(h.peer.peerId)} spent=${spentOnSession(h)}`);
    expect(h.buyer.getVerifiedCost(h.peer.peerId), 'requests the seller dropped count as verified').toBe(CHAT_DELIVERED);
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED + 500_000n);
  }, 60_000);

  it('a request that times out, or that the caller gives up on the seller for, is paid only inside the overdraft window', async () => {
    const { streamChat, gates } = stalledChats(['slow', 'given-up']);
    const h = setup({ requestTimeoutMs: 200, streamChat });
    await openChannelWithChat(h);
    await expect(h.send(h.chatRequest('slow'))).rejects.toThrow(/timed out/);
    gates.shift()!();
    await h.settle();
    // The proxy's attempt timeout: it aborts with an error and moves on to another seller.
    const attempt = new AbortController();
    const givenUp = h.buyerHandler.sendRequest(h.peer, h.chatRequest('given-up'), undefined, { signal: attempt.signal });
    setTimeout(() => attempt.abort(new Error('no answer within 1s')), 50);
    await expect(givenUp).rejects.toThrow(/aborted/);
    gates.shift()!();
    await h.settle();
    expect(spentOnSession(h)).toBe(CHAT_DELIVERED + 280_000n);
    expect(h.buyer.getVerifiedCost(h.peer.peerId), 'an attempt the seller let run out counts as verified').toBe(CHAT_DELIVERED);
    // A slow honest seller is still paid: its bills fit the window.
    expect(h.buyer.getCumulativeAmount(h.peer.peerId)).toBe(CHAT_DELIVERED + 280_000n);
  }, 30_000);
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
