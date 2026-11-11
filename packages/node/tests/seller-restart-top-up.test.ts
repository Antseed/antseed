/**
 * A seller killed around a top-up, then started again over the same store,
 * against a live buyer. Everything is real except the chain: the seller and
 * buyer managers, the negotiator, both request handlers, the channel stores
 * and the frames. The fake chain applies AntseedChannels' rules for the calls a
 * seller makes (amounts, the top-up threshold, signatures, deposit locks), each
 * call all or nothing, over in-memory channels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, verifyTypedData, Wallet, type AbstractSigner } from 'ethers';
import { computeChannelId } from '@antseed/protocol';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator, type NegotiationEmitter } from '../src/payments/buyer-payment-negotiator.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import { ChannelsClient, type ChannelInfo } from '../src/payments/evm/channels-client.js';
import { makeChannelsDomain, RESERVE_AUTH_TYPES, SPENDING_AUTH_TYPES } from '../src/payments/evm/signatures.js';
import { SellerPaymentManager } from '../src/payments/seller-payment-manager.js';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { ProxyMux } from '../src/proxy/proxy-mux.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { ConnectionState } from '../src/types/connection.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';

const CHAIN_ID = 31337;
const CHANNELS_ADDRESS = '0x' + 'cc'.repeat(20);
const THRESHOLD_BPS = 8_500n;
const OPENING_RESERVE = 250_000n;
const MIN_BUDGET = 10_000n;
const ACTIVE = 1;
const CLOSED = 2;
/** How long a topUp() or close() takes to be mined. */
const MINING_MS = 2_000;
/** One way between buyer and seller. */
const LATENCY_MS = 20;
/** One chain read. */
const READ_MS = 50;
/** Real time a test may take: its fake clock runs fast, but a loaded machine runs it slowly. */
const TEST_TIMEOUT_MS = 60_000;
const DOMAIN = makeChannelsDomain(CHAIN_ID, CHANNELS_ADDRESS);
/** The buyer's answer to the one request whose recovery runs a close the seller declines. */
const RECOVERY_RETRY = '503 retryable payment_negotiation_failed: An existing payment channel could not be recovered automatically. Close or recover the channel and retry.';

/** What a topUp() does while the seller is about to be killed. */
type TopUpFate = 'lands' | 'mined-unseen' | 'never-sent';

/** AntseedChannels' rules for the calls a seller makes, over in-memory channels. */
class FakeChain {
  readonly channels = new Map<string, ChannelInfo>();
  topUpFate: TopUpFate = 'lands';
  /** The buyer's deposits, locked and not. */
  funds = 100_000_000n;

  read(channelId: string): ChannelInfo {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`no channel ${channelId}`);
    return channel;
  }

  /** What `channels(id)` returns: a zero struct for a channel that does not exist. */
  session(channelId: string): ChannelInfo {
    return { ...(this.channels.get(channelId) ?? {
      buyer: '0x' + '00'.repeat(20), seller: '0x' + '00'.repeat(20), deposit: 0n, settled: 0n,
      metadataHash: '0x' + '00'.repeat(32), deadline: 0n, settledAt: 0n, closeRequestedAt: 0n, status: 0,
    }) };
  }

  /** The buyer's deposits not locked in an active channel nor paid out of a closed one. */
  available(): bigint {
    let used = 0n;
    for (const channel of this.channels.values()) used += channel.status === ACTIVE ? channel.deposit : channel.settled;
    return this.funds - used;
  }

  private _lock(amount: bigint): void {
    if (this.available() < amount) throw new Error('execution reverted: InsufficientBalance');
  }

  reserved(): bigint {
    let total = 0n;
    for (const channel of this.channels.values()) {
      if (channel.status === ACTIVE) total += channel.deposit - channel.settled;
    }
    return total;
  }

  private _active(channelId: string): ChannelInfo {
    const channel = this.read(channelId);
    if (channel.status !== ACTIVE) throw new Error('execution reverted: ChannelNotActive');
    return channel;
  }

  /** Checks a SpendingAuth the way `_settleSpend` does, without writing anything. */
  private _verifySpending(channel: ChannelInfo, channelId: string, amount: bigint, metadata: string, sig: string): void {
    const signer = verifyTypedData(DOMAIN, SPENDING_AUTH_TYPES, { channelId, cumulativeAmount: amount, metadataHash: keccak256(metadata) }, sig);
    if (signer.toLowerCase() !== channel.buyer.toLowerCase()) throw new Error('execution reverted: InvalidSignature');
  }

  async reserve(signer: AbstractSigner, buyer: string, salt: string, maxAmount: bigint, deadline: bigint, sig: string): Promise<string> {
    const seller = await signer.getAddress();
    const channelId = computeChannelId(buyer, seller, salt);
    if (this.channels.has(channelId)) throw new Error('execution reverted: ChannelExists');
    const reserveSigner = verifyTypedData(DOMAIN, RESERVE_AUTH_TYPES, { channelId, maxAmount, deadline }, sig);
    if (reserveSigner.toLowerCase() !== buyer.toLowerCase()) throw new Error('execution reverted: InvalidSignature');
    this._lock(maxAmount);
    this.channels.set(channelId, {
      buyer, seller, deposit: maxAmount, settled: 0n, metadataHash: '0x' + '00'.repeat(32),
      deadline, settledAt: 0n, closeRequestedAt: 0n, status: ACTIVE,
    });
    return '0xreserve';
  }

  async topUp(channelId: string, amount: bigint, metadata: string, sig: string, newMax: bigint, deadline: bigint, reserveSig: string): Promise<string> {
    const fate = this.topUpFate;
    if (fate === 'never-sent') return new Promise(() => {});
    if (fate === 'lands') await new Promise((resolve) => setTimeout(resolve, MINING_MS));
    const channel = this._active(channelId);
    if (newMax <= channel.deposit) throw new Error('execution reverted: TopUpAmountTooLow');
    let settled = channel.settled;
    if (amount > settled) {
      if (amount > channel.deposit) throw new Error('execution reverted: InvalidAmount');
      this._verifySpending(channel, channelId, amount, metadata, sig);
      settled = amount;
    }
    if (settled < (channel.deposit * THRESHOLD_BPS) / 10_000n) throw new Error('execution reverted: TopUpThresholdNotMet');
    const reserveSigner = verifyTypedData(DOMAIN, RESERVE_AUTH_TYPES, { channelId, maxAmount: newMax, deadline }, reserveSig);
    if (reserveSigner.toLowerCase() !== channel.buyer.toLowerCase()) throw new Error('execution reverted: InvalidSignature');
    this._lock(newMax - channel.deposit);
    channel.settled = settled;
    channel.deposit = newMax;
    channel.deadline = deadline;
    return fate === 'mined-unseen' ? new Promise(() => {}) : '0xtopup';
  }

  async close(channelId: string, finalAmount: bigint, metadata: string, sig: string): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, MINING_MS));
    const channel = this._active(channelId);
    if (finalAmount < channel.settled) throw new Error('execution reverted: FinalAmountBelowSettled');
    if (finalAmount > channel.deposit) throw new Error('execution reverted: InvalidAmount');
    if (finalAmount > channel.settled) this._verifySpending(channel, channelId, finalAmount, metadata, sig);
    channel.settled = finalAmount;
    channel.status = CLOSED;
    return '0xclose';
  }
}

function createIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  return { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
}

/** A paid model whose answers report no usage, so requests served after the restart add no spend. */
function createProvider(): Provider {
  return {
    name: 'openai',
    services: ['test-model'],
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 64,
    async handleRequest(request) {
      return {
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 } })),
      };
    },
    getCapacity: () => ({ current: 0, max: 64 }),
  };
}

/** Real turns of the event loop: hashing and frame handling are not all microtasks. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Advance fake time until `work` settles, so waits and retries inside it run. */
async function finish<T>(work: Promise<T>, maxMs = 180_000): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => { settled = true; });
  for (let waited = 0; !settled && waited < maxMs; waited += 100) {
    await drain();
    await vi.advanceTimersByTimeAsync(100);
  }
  if (!settled) throw new Error(`still running after ${maxMs} ms`);
  return tracked;
}

/** Let the frames in flight arrive and be answered. */
async function flush(): Promise<void> {
  for (let step = 0; step < 10; step += 1) {
    await drain();
    await vi.advanceTimersByTimeAsync(LATENCY_MS);
  }
}

/** Delivers a frame after the network's latency; frames sent in order arrive in order. */
function overTheNetwork(deliver: () => Promise<unknown>): void {
  setTimeout(() => { void deliver(); }, LATENCY_MS);
}

describe('a seller restarted around a top-up', () => {
  const sellerIdentity = createIdentity();
  const buyerIdentity = createIdentity();
  const sellerPeer = sellerIdentity.peerId;
  const buyerPeer = buyerIdentity.peerId;
  const peer = { peerId: sellerPeer };
  let dirs: string[];
  let chain: FakeChain;
  let buyerStore: ChannelStore;
  let buyer: BuyerPaymentManager;
  let negotiator: BuyerPaymentNegotiator;
  let requestHandler: BuyerRequestHandler;
  let seller: ReturnType<typeof startSeller>;
  let buyerConn: ReturnType<typeof connectBuyer>;
  let buyerChannels: ChannelsClient;
  /** Chain clients of killed seller processes. */
  let killed: Set<ChannelsClient>;
  let requests = 0;

  function dir(name: string): string {
    const path = mkdtempSync(join(tmpdir(), name));
    dirs.push(path);
    return path;
  }

  /** One seller process: its store, payment manager and request handler, on a new connection. */
  function startSeller(dataDir: string) {
    const store = new ChannelStore(dataDir);
    const payments = new SellerPaymentManager(sellerIdentity, {
      rpcUrl: 'http://127.0.0.1:1',
      channelsContractAddress: CHANNELS_ADDRESS,
      chainId: CHAIN_ID,
      dataDir,
      minBudgetPerRequest: MIN_BUDGET.toString(),
    }, store);
    const handler = new SellerRequestHandler({
      identity: sellerIdentity,
      providers: [createProvider()],
      sellerPaymentManager: payments,
      channelsClient: {} as never,
      sessionTracker: null,
      announcer: null,
      emit: () => false,
    } as never);
    const process = {
      dataDir, store, payments, alive: true,
      paymentMux: undefined as unknown as PaymentMux,
      proxy: undefined as unknown as ReturnType<SellerRequestHandler['handleConnection']>['mux'],
    };
    const conn = {
      send(frame: Uint8Array) {
        overTheNetwork(async () => {
          if (!process.alive) return;
          const { message } = decodeFrame(frame)!;
          if (PaymentMux.isPaymentMessage(message.type)) {
            await negotiator.getOrCreatePaymentMux(sellerPeer, buyerConn).handleFrame(message);
          } else {
            await buyerConn.proxy.handleFrame(message);
          }
        });
      },
      hasRemoteCapability: () => false,
      remoteAddress: '203.0.113.7',
    };
    process.paymentMux = new PaymentMux(conn as never);
    process.paymentMux.onSpendingAuth((payload) => {
      void payments.handleSpendingAuth(buyerPeer, payload, process.paymentMux);
    });
    process.paymentMux.onCloseChannelRequest((payload) => {
      void payments.handleCloseChannelRequest(buyerPeer, payload, process.paymentMux)
        .then((result) => { if (process.alive) process.paymentMux.sendCloseChannelResult(result); });
    });
    process.proxy = handler.handleConnection(conn as never, buyerPeer, process.paymentMux, undefined as never).mux;
    return process;
  }

  /** The buyer's end of a new connection to the seller process running now. */
  function connectBuyer() {
    const conn = {
      state: ConnectionState.Open,
      proxy: undefined as unknown as ProxyMux,
      send(frame: Uint8Array) {
        const target = seller;
        overTheNetwork(async () => {
          if (!target.alive) return;
          const { message } = decodeFrame(frame)!;
          await (PaymentMux.isPaymentMessage(message.type) ? target.paymentMux : target.proxy).handleFrame(message);
        });
      },
      on: () => undefined,
      off: () => undefined,
    };
    conn.proxy = new ProxyMux(conn as never);
    return conn;
  }

  /** SIGKILL: nothing the process held in memory survives, only its store; its chain calls never finish. Then start again. */
  async function restartSeller(): Promise<void> {
    seller.alive = false;
    killed.add(seller.payments.channelsClient);
    seller.store.close();
    negotiator.onPeerDisconnect(sellerPeer);
    chain.topUpFate = 'lands';
    seller = startSeller(seller.dataDir);
    buyerConn = connectBuyer();
    await finish(seller.payments.validateHydratedChannels());
    await finish(seller.payments.checkTimeouts());
  }

  async function openChannel(): Promise<string> {
    const channelId = await finish(buyer.authorizeSpending(sellerPeer, negotiator.getOrCreatePaymentMux(sellerPeer, buyerConn), MIN_BUDGET, OPENING_RESERVE));
    await flush();
    expect(buyer.isAuthorized(sellerPeer)).toBe(true);
    return channelId;
  }

  /** One request served and signed for, as under load: the seller records it, the buyer answers its NeedAuth. */
  async function serve(channelId: string, cost: bigint): Promise<void> {
    const requestId = `served-${requests += 1}`;
    seller.payments.recordSpend(channelId, cost);
    buyer.recordDeliveredResponse(sellerPeer, requestId, { costUsdc: cost });
    await finish(buyer.handleNeedAuth(sellerPeer, {
      channelId,
      requiredCumulativeAmount: seller.payments.getCumulativeSpend(channelId).toString(),
      currentAcceptedCumulative: seller.payments.getAcceptedCumulative(channelId).toString(),
      deposit: '0',
      requestId,
      lastRequestCost: cost.toString(),
      inputTokens: '0',
      outputTokens: '0',
    }, negotiator.getOrCreatePaymentMux(sellerPeer, buyerConn)));
    await flush();
  }

  /** Parallel client requests through the buyer's real request handling. Returns what each client got, without a client retry. */
  async function parallelResponses(count: number): Promise<SerializedHttpResponse[]> {
    const request = (requestId: string): SerializedHttpRequest => ({
      requestId, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'test-model', messages: [] })),
    });
    return finish(Promise.all(Array.from({ length: count }, () => requestHandler.sendRequest(peer, request(`after-restart-${requests += 1}`)))));
  }

  /** The status each client got. */
  async function parallelRequests(count: number): Promise<number[]> {
    return (await parallelResponses(count)).map((response) => response.statusCode);
  }

  /** What the client got: 'ok', or the status, whether it may retry, and why. */
  function describeAnswer(response: SerializedHttpResponse): string {
    if (response.statusCode === 200) return 'ok';
    const { error } = JSON.parse(new TextDecoder().decode(response.body)) as { error?: { type?: string; peer_message?: string } };
    return `${response.statusCode}${response.headers['retry-after'] ? ' retryable' : ''} ${error?.type}: ${error?.peer_message}`;
  }

  /** The channel's final settlement once the seller closes it. */
  async function closeAndReadSettled(channelId: string): Promise<bigint> {
    if (chain.read(channelId).status === ACTIVE) await finish(seller.payments.settleSession(buyerPeer));
    return chain.read(channelId).settled;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    dirs = [];
    chain = new FakeChain();
    const client = ChannelsClient.prototype;
    vi.spyOn(client, 'readAddress', 'get').mockImplementation(() => Promise.resolve(CHANNELS_ADDRESS));
    killed = new Set();
    /** A chain call from a live process; a killed one's never finishes. */
    function call<T>(from: ChannelsClient, run: () => Promise<T>): Promise<T> {
      return killed.has(from) ? new Promise(() => {}) : run();
    }
    const rpc = <T>(read: () => T): Promise<T> => new Promise((resolve, reject) => {
      setTimeout(() => { try { resolve(read()); } catch (err) { reject(err); } }, READ_MS);
    });
    vi.spyOn(client, 'getSession').mockImplementation(function (this: ChannelsClient, id: string) {
      return call(this, () => rpc(() => chain.session(id)));
    });
    vi.spyOn(client, 'getTopUpSettledThresholdBps').mockImplementation(function (this: ChannelsClient) {
      return call(this, () => rpc(() => THRESHOLD_BPS));
    });
    vi.spyOn(client, 'reserve').mockImplementation(function (this: ChannelsClient, signer, buyerAddr, salt, max, deadline, sig) {
      return call(this, () => chain.reserve(signer, buyerAddr, salt, max, deadline, sig));
    });
    vi.spyOn(client, 'topUp').mockImplementation(function (this: ChannelsClient, _signer, id, amount, metadata, sig, max, deadline, reserveSig) {
      return call(this, () => chain.topUp(id, amount, metadata, sig, max, deadline, reserveSig));
    });
    vi.spyOn(client, 'close').mockImplementation(function (this: ChannelsClient, _signer, id, amount, metadata, sig) {
      return call(this, () => chain.close(id, amount, metadata, sig));
    });

    const buyerDir = dir('restart-buyer-');
    buyerStore = new ChannelStore(buyerDir);
    buyer = new BuyerPaymentManager(buyerIdentity, {
      rpcUrl: 'http://127.0.0.1:1',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: CHANNELS_ADDRESS,
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 150_000n,
      maxReserveAmountUsdc: OPENING_RESERVE,
      dataDir: buyerDir,
    }, buyerStore);
    buyer.setSigner(buyerIdentity.wallet);
    const balance = async () => ({ available: chain.available(), reserved: chain.reserved(), lastActivityAt: 0n });
    vi.spyOn(buyer.depositsClient, 'getBuyerBalance').mockImplementation(balance);
    buyerChannels = new ChannelsClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: CHANNELS_ADDRESS, evmChainId: CHAIN_ID });
    const emitter: NegotiationEmitter = { emit: () => false } as never;
    negotiator = new BuyerPaymentNegotiator(buyerIdentity, buyer, buyer.depositsClient, buyerChannels, buyerStore, {}, emitter);
    requestHandler = new BuyerRequestHandler({}, {
      localPeerId: buyerPeer,
      negotiator,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: async () => buyerConn as never,
      getMux: () => buyerConn.proxy,
      getVerificationMux: () => ({}) as never,
      registerPaymentMux: () => undefined,
    });

    seller = startSeller(dir('restart-seller-'));
    buyerConn = connectBuyer();
  });

  afterEach(() => {
    seller.alive = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    seller.store.close();
    buyerStore.close();
    for (const path of dirs) rmSync(path, { recursive: true, force: true });
  });

  it('collects what the buyer signed when killed right after its first top-up is mined', async () => {
    const channelId = await openChannel();
    chain.topUpFate = 'mined-unseen';
    while (seller.payments.getCumulativeSpend(channelId) < 1_250_000n) await serve(channelId, 23_201n);

    const spent = seller.payments.getCumulativeSpend(channelId);
    const accepted = seller.payments.getAcceptedCumulative(channelId);
    const signed = buyer.getCumulativeAmount(sellerPeer);
    const { deposit } = chain.read(channelId);
    // The state the crash leaves: a landed top-up the store never recorded,
    // and an accepted amount too low for the next one to pass the threshold.
    expect(seller.store.getChannel(channelId)?.previousConsumption).toBe(OPENING_RESERVE.toString());
    expect(deposit).toBeGreaterThan(OPENING_RESERVE);
    expect(spent).toBeGreaterThan(deposit);
    expect(signed).toBeGreaterThan(deposit);
    expect(accepted * 10_000n).toBeLessThan(deposit * THRESHOLD_BPS);

    await restartSeller();
    const answers = (await parallelResponses(16)).map(describeAnswer);

    const goesOn = chain.read(channelId).status === ACTIVE && chain.channels.size === 1;
    expect(await closeAndReadSettled(channelId), 'settled below what the buyer signed').toBe(signed);
    expect(goesOn, 'closed or replaced the channel it had just extended').toBe(true);
    // One answer asks for an authorization up to the deposit; the buyer runs a close capped there to give it,
    // which the seller declines, so that one request can get a retryable 503.
    expect(answers.filter((answer) => answer !== 'ok' && answer !== RECOVERY_RETRY)).toEqual([]);
    expect(answers.filter((answer) => answer === 'ok').length).toBeGreaterThanOrEqual(15);
  }, TEST_TIMEOUT_MS);

  it('collects what the buyer signed when killed after verifying a top-up but before sending it', async () => {
    const channelId = await openChannel();
    chain.topUpFate = 'never-sent';
    while (seller.payments.getCumulativeSpend(channelId) < 499_000n) await serve(channelId, 23_201n);

    const signed = buyer.getCumulativeAmount(sellerPeer);
    const { deposit } = chain.read(channelId);
    expect(deposit).toBe(OPENING_RESERVE);
    expect(signed).toBeGreaterThan(deposit);
    // The stored auth passes the top-up threshold: the seller only needs the buyer to send again what it signed.
    expect(seller.payments.getAcceptedCumulative(channelId) * 10_000n).toBeGreaterThanOrEqual(deposit * THRESHOLD_BPS);

    await restartSeller();
    const statuses = await parallelRequests(16);

    const goesOn = chain.read(channelId).status === ACTIVE && chain.channels.size === 1;
    expect(await closeAndReadSettled(channelId), 'settled below what the buyer signed').toBe(signed);
    expect(goesOn, 'closed or replaced the channel it had just extended').toBe(true);
    expect(statuses).toEqual(Array.from({ length: 16 }, () => 200));
  }, TEST_TIMEOUT_MS);

  it('serves the request that finds the channel past its ceiling, without a client retry', async () => {
    const channelId = await openChannel();
    chain.topUpFate = 'never-sent';
    while (seller.payments.getCumulativeSpend(channelId) < 499_000n) await serve(channelId, 23_201n);
    const signed = buyer.getCumulativeAmount(sellerPeer);
    expect(seller.payments.getAcceptedCumulative(channelId) * 10_000n).toBeGreaterThanOrEqual(OPENING_RESERVE * THRESHOLD_BPS);

    await restartSeller();
    const statuses = await parallelRequests(1);

    const goesOn = chain.read(channelId).status === ACTIVE && chain.channels.size === 1;
    expect(await closeAndReadSettled(channelId), 'settled below what the buyer signed').toBe(signed);
    expect(goesOn, 'closed or replaced the channel it had just extended').toBe(true);
    expect(statuses).toEqual([200]);
  }, TEST_TIMEOUT_MS);

  it('is paid for work past the reserve when the buyer had only signed up to it', async () => {
    const channelId = await openChannel();
    chain.topUpFate = 'never-sent';
    for (let served = 0; served < 10; served += 1) await serve(channelId, 25_000n);
    expect(buyer.getCumulativeAmount(sellerPeer)).toBe(OPENING_RESERVE);
    // Served, and received, while the top-up was on its way; the seller died before the NeedAuth for it.
    seller.payments.recordSpend(channelId, 70_922n);
    buyer.recordDeliveredResponse(sellerPeer, 'past-the-reserve', { costUsdc: 70_922n });
    const spent = seller.payments.getCumulativeSpend(channelId);

    await restartSeller();
    const statuses = await parallelRequests(16);

    expect(await closeAndReadSettled(channelId), 'settled below what was served').toBe(spent);
    expect(statuses).toEqual(Array.from({ length: 16 }, () => 200));
  }, TEST_TIMEOUT_MS);

  it('is paid for work past the reserve even when an authorization was accepted since the restart', async () => {
    const channelId = await openChannel();
    chain.topUpFate = 'never-sent';
    for (let served = 0; served < 8; served += 1) await serve(channelId, 25_000n);
    // The seller dies with this request's spend recorded, before the buyer's authorization for it arrives.
    seller.payments.recordSpend(channelId, 25_000n);
    seller.alive = false;
    buyer.recordDeliveredResponse(sellerPeer, 'unheard', { costUsdc: 25_000n });
    await finish(buyer.handleNeedAuth(sellerPeer, {
      channelId, requiredCumulativeAmount: '225000', currentAcceptedCumulative: '200000', deposit: '0',
      requestId: 'unheard', lastRequestCost: '25000', inputTokens: '0', outputTokens: '0',
    }, negotiator.getOrCreatePaymentMux(sellerPeer, buyerConn)));
    await flush();

    await restartSeller();
    // A request catches the authorization up: the buyer has proven itself, and the top-up is still lost.
    expect(await parallelRequests(1)).toEqual([200]);
    expect(seller.payments.getAcceptedCumulative(channelId)).toBe(225_000n);
    seller.payments.recordSpend(channelId, 95_922n);
    buyer.recordDeliveredResponse(sellerPeer, 'past-the-reserve', { costUsdc: 95_922n });
    const spent = seller.payments.getCumulativeSpend(channelId);
    const statuses = await parallelRequests(16);

    expect(await closeAndReadSettled(channelId), 'settled below what was served').toBe(spent);
    expect(statuses).toEqual(Array.from({ length: 16 }, () => 200));
  }, TEST_TIMEOUT_MS);

  it('collects what the buyer signed from a single request, with nothing else to prompt it', async () => {
    const channelId = await openChannel();
    chain.topUpFate = 'mined-unseen';
    while (seller.payments.getCumulativeSpend(channelId) < 1_250_000n) await serve(channelId, 23_201n);
    const signed = buyer.getCumulativeAmount(sellerPeer);

    await restartSeller();
    await parallelRequests(1);
    await finish(new Promise((resolve) => setTimeout(resolve, 10_000)));

    expect(await closeAndReadSettled(channelId), 'settled below what the buyer signed').toBe(signed);
  }, TEST_TIMEOUT_MS);

  it('closes a full, fully paid channel without asking the buyer anything', async () => {
    const channelId = await openChannel();
    chain.funds = OPENING_RESERVE;
    for (let served = 0; served < 10; served += 1) await serve(channelId, 25_000n);
    expect(seller.payments.getAcceptedCumulative(channelId)).toBe(OPENING_RESERVE);
    chain.funds = 100_000_000n;

    await restartSeller();
    const started = Date.now();
    await parallelRequests(1);

    expect({ status: chain.read(channelId).status, settled: chain.read(channelId).settled, quickly: Date.now() - started < 10_000 })
      .toEqual({ status: CLOSED, settled: OPENING_RESERVE, quickly: true });
  }, TEST_TIMEOUT_MS);

  it('asks again for an authorization up to the deposit when the buyer could not act on the first ask', async () => {
    const channelId = await openChannel();
    chain.topUpFate = 'mined-unseen';
    while (seller.payments.getCumulativeSpend(channelId) < 1_250_000n) await serve(channelId, 23_201n);
    const signed = buyer.getCumulativeAmount(sellerPeer);

    await restartSeller();
    // The buyer's chain read fails while it handles the first ask, so it neither replays its top-up nor closes.
    vi.spyOn(buyerChannels, 'getSession').mockRejectedValueOnce(new Error('rpc timeout'));
    // A client keeps retrying a retryable answer.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if ((await parallelRequests(1))[0] === 200) break;
      await finish(new Promise((resolve) => setTimeout(resolve, 2_000)));
    }

    const goesOn = chain.read(channelId).status === ACTIVE && chain.channels.size === 1;
    expect(await closeAndReadSettled(channelId), 'settled below what the buyer signed').toBe(signed);
    expect(goesOn, 'closed or replaced the channel it had just extended').toBe(true);
  }, TEST_TIMEOUT_MS);

  it('still closes a full channel when the buyer has no top-up to send again', async () => {
    const channelId = await openChannel();
    chain.funds = OPENING_RESERVE;
    for (let served = 0; served < 10; served += 1) await serve(channelId, 25_000n);
    seller.payments.recordSpend(channelId, 70_922n);

    await restartSeller();
    // A client keeps retrying until the seller has given the buyer its chance.
    for (let attempt = 0; attempt < 30 && chain.read(channelId).status === ACTIVE; attempt += 1) {
      await parallelRequests(1);
      await finish(new Promise((resolve) => setTimeout(resolve, 2_000)));
    }

    expect(chain.read(channelId).status).toBe(CLOSED);
    expect(chain.read(channelId).settled).toBe(OPENING_RESERVE);
  }, TEST_TIMEOUT_MS);
});
