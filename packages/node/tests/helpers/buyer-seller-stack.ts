/**
 * The real buyer stack (BuyerRequestHandler, BuyerPaymentNegotiator,
 * BuyerPaymentManager, ChannelStore) talks to the real seller stack
 * (SellerRequestHandler, SellerPaymentManager) over an in-memory framed
 * connection. Only the chain is faked (as in video-reserve-flow.test.ts).
 *
 * What the buyer sees (its peer view) and what the seller bills (its provider
 * pricing) are set separately, so an announcement and a bill can differ.
 */
import { vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { BuyerPaymentManager } from '../../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../../src/payments/buyer-payment-negotiator.js';
import { SellerPaymentManager } from '../../src/payments/seller-payment-manager.js';
import { ChannelStore } from '../../src/payments/channel-store.js';
import { DepositsClient } from '../../src/payments/evm/deposits-client.js';
import { PaymentMux } from '../../src/p2p/payment-mux.js';
import { ProxyMux } from '../../src/proxy/proxy-mux.js';
import { VerificationMux } from '../../src/verification/verification-mux.js';
import { BuyerRequestHandler } from '../../src/buyer-request-handler.js';
import { SellerRequestHandler } from '../../src/seller-request-handler.js';
import { ResourceOwnershipStore } from '../../src/resources/resource-ownership-store.js';
import { FrameDecoder } from '../../src/p2p/message-protocol.js';
import { ConnectionState } from '../../src/types/connection.js';
import { toPeerId, type PeerInfo } from '../../src/types/peer.js';
import type { Identity } from '../../src/p2p/identity.js';
import type { PeerConnection } from '../../src/p2p/connection-manager.js';
import type { Provider } from '../../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../../src/types/http.js';
import type { SpendingAuthPayload } from '../../src/types/protocol.js';
import { computeChannelId } from '@antseed/protocol/signatures';

export interface ChainChannel { deposit: bigint; settled: bigint; status: number }

const FIRST_SIGN_CAP = 1_000_000n;

function identity(): Identity {
  const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));
  return { wallet, peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey: Buffer.from(wallet.privateKey.slice(2), 'hex') };
}

type Listener = (...args: any[]) => void;

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

export interface Usage { promptTokens: number; cachedTokens: number; completionTokens: number }

export interface BuyerSellerStackOptions {
  /** What the seller bills by (its provider's pricing). */
  sellerPricing: Provider['pricing'];
  /** What the buyer's peer view announces (fields merged into the PeerInfo). */
  announced: Partial<PeerInfo>;
  /** Usage the seller's upstream reports for every chat. */
  usage: Usage;
  maxPerRequestUsdc: bigint;
  maxReserveAmountUsdc: bigint;
  /** Services the seller offers besides `chat-model`. */
  extraServices?: string[];
}

export interface BuyerSellerStack {
  /** Channels the fake chain holds, by channel id. */
  chain: Map<string, ChainChannel>;
  /** Every SpendingAuth the buyer sent. */
  sentAuths: SpendingAuthPayload[];
  /** The seller's `reserve()` on the fake chain: one call per channel opened. */
  reserve: ReturnType<typeof vi.fn>;
  chat(requestId: string, service?: string): SerializedHttpRequest;
  send(request: SerializedHttpRequest): ReturnType<BuyerRequestHandler['sendRequest']>;
  /** Lets the seller's NeedAuth prompts and the buyer's answers finish. */
  settle(): Promise<void>;
  /** Highest cumulative the buyer signed, per channel. */
  signedByChannel(): Map<string, bigint>;
  /** Sum over channels of the highest signed cumulative. */
  totalSigned(): bigint;
  cleanup(): void;
}

export function setupBuyerSellerStack(options: BuyerSellerStackOptions): BuyerSellerStack {
  const directory = mkdtempSync(join(tmpdir(), 'antseed-buyer-seller-'));
  const service = 'chat-model';
  const providerName = 'venice';
  const buyerIdentity = identity();
  const sellerIdentity = identity();
  const buyerStore = new ChannelStore(join(directory, 'buyer'));
  const sellerStore = new ChannelStore(join(directory, 'seller'));
  const ownership = new ResourceOwnershipStore(join(directory, 'metering.db'));

  vi.spyOn(DepositsClient.prototype, 'getBuyerBalance').mockResolvedValue({ available: 50_000_000n, reserved: 0n, lastActivityAt: 0n });

  const common = { rpcUrl: 'http://127.0.0.1:1', chainId: 31337, channelsContractAddress: '0x' + 'cc'.repeat(20) };
  const buyer = new BuyerPaymentManager(buyerIdentity, {
    ...common,
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: options.maxPerRequestUsdc,
    maxReserveAmountUsdc: options.maxReserveAmountUsdc,
    dataDir: join(directory, 'buyer'),
  }, buyerStore);
  buyer.setSigner(buyerIdentity.wallet);
  const seller = new SellerPaymentManager(sellerIdentity, { ...common, dataDir: join(directory, 'seller'), minBudgetPerRequest: '10000' }, sellerStore);

  const chain = new Map<string, ChainChannel>();
  const channelOf = (channelId: string): ChainChannel => {
    const channel = chain.get(channelId);
    if (!channel) throw new Error('execution reverted: ChannelNotFound');
    return channel;
  };
  vi.spyOn(seller.channelsClient, 'getFirstSignCap').mockResolvedValue(FIRST_SIGN_CAP);
  vi.spyOn(seller.channelsClient, 'getTopUpSettledThresholdBps').mockResolvedValue(8_500n);
  const reserve = vi.spyOn(seller.channelsClient, 'reserve').mockImplementation(async (_signer, buyerAddr, salt, maxAmount) => {
    if (maxAmount > FIRST_SIGN_CAP) throw new Error('execution reverted: FirstSignCapExceeded');
    const channelId = computeChannelId(buyerAddr, sellerIdentity.wallet.address, salt);
    if (chain.has(channelId)) throw new Error('execution reverted: ChannelExists');
    chain.set(channelId, { deposit: maxAmount, settled: 0n, status: 1 });
    return '0xreserve';
  }) as unknown as ReturnType<typeof vi.fn>;
  vi.spyOn(seller.channelsClient, 'topUp').mockImplementation(async (_signer, channelId, cumulative, _meta, _sig, newMax) => {
    const channel = channelOf(channelId);
    if (cumulative > channel.deposit) throw new Error('execution reverted: InvalidAmount');
    if (cumulative > channel.settled) channel.settled = cumulative;
    if (channel.settled * 10_000n < channel.deposit * 8_500n) throw new Error('execution reverted: TopUpThresholdNotMet');
    channel.deposit = newMax;
    return '0xtopup';
  });
  vi.spyOn(seller.channelsClient, 'close').mockImplementation(async (_signer, channelId, finalAmount) => {
    const channel = channelOf(channelId);
    if (channel.status !== 1) throw new Error('execution reverted: ChannelNotActive');
    if (finalAmount < channel.settled) throw new Error('execution reverted: FinalAmountBelowSettled');
    if (finalAmount > channel.deposit) throw new Error('execution reverted: InvalidAmount');
    channel.settled = finalAmount;
    channel.status = 2;
    return '0xclose';
  });
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

  const { usage } = options;
  const provider: Provider = {
    name: providerName,
    services: [service, ...(options.extraServices ?? [])],
    pricing: options.sellerPricing,
    serviceApiProtocols: Object.fromEntries([service, ...(options.extraServices ?? [])].map((s) => [s, ['openai-chat-completions']])),
    maxConcurrency: 8,
    getCapacity: () => ({ current: 0, max: 8 }),
    handleRequest: vi.fn(async (request: SerializedHttpRequest) => ({
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        id: 'chat', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens,
          prompt_tokens_details: { cached_tokens: usage.cachedTokens },
        },
      })),
    })),
  } as unknown as Provider;

  const { buyerSide, sellerSide } = connectionPair();
  const sellerPayment = new PaymentMux(sellerSide);
  const sellerVerification = new VerificationMux(sellerSide);
  sellerPayment.onSpendingAuth((payload) => { void seller.handleSpendingAuth(buyerIdentity.peerId, payload, sellerPayment); });
  sellerPayment.onCloseChannelRequest((payload) => {
    void seller.handleCloseChannelRequest(buyerIdentity.peerId, payload, sellerPayment).then((result) => sellerPayment.sendCloseChannelResult(result));
  });
  const sellerHandler = new SellerRequestHandler({
    identity: sellerIdentity, providers: [provider], sellerPaymentManager: seller, sessionTracker: null,
    channelsClient: seller.channelsClient, announcer: null, emit: () => false, resourceOwnershipStore: ownership,
  });
  const { mux: sellerProxy } = sellerHandler.handleConnection(sellerSide, buyerIdentity.peerId, sellerPayment, sellerVerification);
  wireFrames(sellerSide, { proxy: sellerProxy, payment: sellerPayment, verification: sellerVerification });

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
    providers: [providerName],
    providerServiceApiProtocols: { [providerName]: { services: { [service]: ['openai-chat-completions'] } } },
    ...options.announced,
  } as unknown as PeerInfo;

  const chat = (requestId: string, svc = service): SerializedHttpRequest => ({
    requestId,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'x-antseed-service': svc, 'x-antseed-provider': providerName },
    body: Buffer.from(JSON.stringify({ model: svc, messages: [{ role: 'user', content: 'hi' }], max_tokens: usage.completionTokens })),
  });

  const signedByChannel = () => {
    const out = new Map<string, bigint>();
    for (const auth of sentAuths) {
      const amount = BigInt(auth.cumulativeAmount);
      const prev = out.get(auth.channelId) ?? 0n;
      if (amount > prev) out.set(auth.channelId, amount);
      else if (!out.has(auth.channelId)) out.set(auth.channelId, prev);
    }
    return out;
  };

  return {
    chain, sentAuths, reserve, chat,
    send: (request) => buyerHandler.sendRequest(peer, request),
    settle: async () => {
      for (let round = 0; round < 4; round += 1) {
        await negotiator.drainPendingNeedAuth();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    signedByChannel,
    totalSigned: () => [...signedByChannel().values()].reduce((a, b) => a + b, 0n),
    cleanup: () => {
      negotiator.cleanup();
      buyerStore.close(); sellerStore.close(); ownership.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
