import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../src/payments/buyer-payment-negotiator.js';
import { ChannelStore, CHANNEL_KIND, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';
import type { ChannelInfo, ChannelsClient } from '../src/payments/evm/channels-client.js';
import type { DepositsClient } from '../src/payments/evm/deposits-client.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { Identity } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import * as codec from '../src/p2p/payment-codec.js';
import { MessageType, type NeedAuthPayload } from '../src/types/protocol.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import { toPeerId, type PeerId } from '../src/types/peer.js';

const SELLER_ADDRESS = '0x' + '44'.repeat(20);
const ZERO_ADDRESS = '0x' + '00'.repeat(20);
const nowSecs = (): number => Math.floor(Date.now() / 1000);
const channelId = (n: number): string => '0x' + n.toString(16).padStart(2, '0').repeat(32);
const sellerPeer = (n: number): PeerId => toPeerId(n.toString(16).padStart(2, '0').repeat(20));
const encoder = new TextEncoder();

function identity(): Identity {
  const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));
  return { wallet, peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey: Buffer.from(wallet.privateKey.slice(2), 'hex') };
}

function paymentConfig(dataDir: string): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    chainId: 31337,
    channelsContractAddress: '0x' + 'cc'.repeat(20),
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 100_000n,
    maxReserveAmountUsdc: 1_000_000n,
    dataDir,
  };
}

function onChain(buyer: string, status: number, settled = 0n): ChannelInfo {
  return {
    buyer,
    seller: SELLER_ADDRESS,
    deposit: 1_000_000n,
    settled,
    metadataHash: '0x' + '00'.repeat(32),
    deadline: 0n,
    settledAt: 0n,
    closeRequestedAt: 0n,
    status,
  };
}

const MISSING: ChannelInfo = { ...onChain(ZERO_ADDRESS, 0), seller: ZERO_ADDRESS, deposit: 0n };

function paymentRequired402(body: Record<string, unknown> = {}): SerializedHttpResponse {
  return { requestId: 'req-1', statusCode: 402, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)) };
}

function chatRequest(): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })),
  };
}

const BUDGET = { minBudgetPerRequest: '10000', suggestedAmount: '1000000' };

function needAuth(channel: string, requiredCumulativeAmount: string, lastRequestCost: string): NeedAuthPayload {
  return { channelId: channel, requiredCumulativeAmount, currentAcceptedCumulative: '0', deposit: '1000000', lastRequestCost, inputTokens: '1000', outputTokens: '1000' };
}

function externalSpendingAuthHeader(channel: string): string {
  return Buffer.from(JSON.stringify({
    channelId: channel,
    cumulativeAmount: '300000',
    metadataHash: '0x' + '00'.repeat(32),
    metadata: '',
    spendingAuthSig: '0x' + '02'.repeat(65),
  })).toString('base64');
}

describe('buyer channel reconcile against the chain', () => {
  const SELLER = sellerPeer(1);
  const CURRENT = channelId(1);
  const pricedSeller = { peerId: SELLER, defaultInputUsdPerMillion: 3, defaultOutputUsdPerMillion: 15 };

  let dir: string;
  let store: ChannelStore;
  let buyer: Identity;
  let chain: Map<string, ChannelInfo | Error>;
  let getSession: Mock<[id: string], Promise<ChannelInfo>>;
  let reachable: boolean;
  let onChainReadFailure: ReturnType<typeof vi.fn>;
  let sellerConn: PeerConnection & { send: Mock };
  let bpm: BuyerPaymentManager;
  let negotiator: BuyerPaymentNegotiator;

  function row(sessionId: string, peerId: string, overrides: Partial<StoredChannel> = {}): StoredChannel {
    const now = Date.now();
    return {
      sessionId,
      peerId,
      role: CHANNEL_ROLE.BUYER,
      channelKind: CHANNEL_KIND.PAID,
      sellerEvmAddr: SELLER_ADDRESS,
      buyerEvmAddr: buyer.wallet.address,
      nonce: 0,
      authMax: '300000',
      deadline: nowSecs() + 3600,
      previousSessionId: '',
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 3,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: null,
      latestSpendingAuthSig: null,
      latestMetadata: null,
      reserveSalt: '0x' + '01'.repeat(32),
      initialReserveAmount: '1000000',
      reserveMaxAmount: '1000000',
      latestReserveAuthSig: '0x' + '02'.repeat(65),
      latestReserveDeadline: nowSecs() + 3600,
      reserveAuthPending: false,
      confirmedReserveAmount: '1000000',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function neverConfirmed(deadline: number): Partial<StoredChannel> {
    return { deadline, latestReserveDeadline: deadline, reserveAuthPending: true, confirmedReserveAmount: '0' };
  }

  /** Builds the buyer as a fresh process would, over whatever the store holds now. */
  function startBuyer({ channelsClient = true, deposits = false } = {}): void {
    bpm = new BuyerPaymentManager(buyer, paymentConfig(dir), store);
    negotiator = new BuyerPaymentNegotiator(
      buyer,
      bpm,
      deposits ? { getBuyerBalance: async () => ({ available: 10_000_000n, reserved: 0n }) } as unknown as DepositsClient : null,
      channelsClient ? { getSession } as unknown as ChannelsClient : null,
      store,
      { isChainReachable: () => reachable, onChainReadFailure },
      { emit: () => true },
    );
  }

  /** Makes the buyer's next signature wait until `release()`; `signing` resolves once it is waiting. */
  function holdSignatures(): { signing: Promise<void>; release: () => void } {
    const sign = buyer.wallet.signTypedData.bind(buyer.wallet);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const signing = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(buyer.wallet, 'signTypedData').mockImplementation(async (...args) => {
      reached();
      await released;
      return sign(...args);
    });
    return { signing, release };
  }

  /** A payment frame from the seller, through the buyer's mux. */
  function fromSeller(type: MessageType, payload: Uint8Array): Promise<boolean> {
    return negotiator.getOrCreatePaymentMux(SELLER, sellerConn).handleFrame({ type, messageId: 1, payload });
  }

  function sentToSeller(type: MessageType): Uint8Array[] {
    return sellerConn.send.mock.calls
      .map(([frame]) => decodeFrame(frame as Uint8Array)!.message)
      .filter((message) => message.type === type)
      .map((message) => message.payload);
  }

  const spendingAuthsSent = () => sentToSeller(MessageType.SpendingAuth).map((payload) => codec.decodeSpendingAuth(payload));

  /** Lock the seller's current channel the way a 402 recovery does, so per-request auth runs. */
  async function lockSeller(): Promise<void> {
    const recovery = negotiator.handle402(paymentRequired402(BUDGET), pricedSeller, sellerConn, chatRequest());
    await vi.waitFor(() => expect(spendingAuthsSent()).toHaveLength(1));
    await fromSeller(MessageType.AuthAck, codec.encodeAuthAck({ channelId: CURRENT }));
    await expect(recovery).resolves.toEqual({ action: 'retry' });
  }

  function respond(): void {
    negotiator.estimateCostFromResponse(pricedSeller, {
      requestId: 'req-1',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 1000 } })),
    });
  }

  const status = (sessionId: string) => store.getChannel(sessionId)?.status;
  const readIds = (): string[] => getSession.mock.calls.map((call) => call[0] as string);
  const conn = (): PeerConnection & { send: Mock } => ({ send: vi.fn() }) as unknown as PeerConnection & { send: Mock };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antseed-buyer-reconcile-'));
    store = new ChannelStore(dir);
    buyer = identity();
    chain = new Map();
    reachable = true;
    onChainReadFailure = vi.fn();
    sellerConn = conn();
    getSession = vi.fn(async (id: string) => {
      const state = chain.get(id) ?? new Error(`no chain state for ${id}`);
      if (state instanceof Error) throw state;
      return state;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retires every seller\'s settled and withdrawn channels and records what the seller was paid', async () => {
    store.upsertChannel(row(channelId(1), sellerPeer(1)));
    store.upsertChannel(row(channelId(2), sellerPeer(2)));
    chain.set(channelId(1), onChain(buyer.wallet.address, 2, 250_000n));
    chain.set(channelId(2), onChain(buyer.wallet.address, 3, 120_000n));
    startBuyer();

    await negotiator.reconcileChannelsWithChain();

    expect(store.getChannel(channelId(1))).toMatchObject({ status: CHANNEL_STATUS.SETTLED, settledAmount: '250000' });
    expect(store.getChannel(channelId(2))).toMatchObject({ status: CHANNEL_STATUS.TIMEOUT, settledAmount: '120000' });
    expect(store.getActiveChannelsByBuyer(CHANNEL_ROLE.BUYER, buyer.wallet.address)).toEqual([]);
  });

  it('keeps open, unknown and unreadable channels and stops reading at the first failed read', async () => {
    const base = Date.now() - 10_000;
    store.upsertChannel(row(channelId(1), sellerPeer(1), { createdAt: base }));
    store.upsertChannel(row(channelId(2), sellerPeer(2), { createdAt: base + 1 }));
    store.upsertChannel(row(channelId(3), sellerPeer(3), { createdAt: base + 2 }));
    store.upsertChannel(row(channelId(4), sellerPeer(4), { createdAt: base + 3 }));
    chain.set(channelId(1), onChain(buyer.wallet.address, 1));
    chain.set(channelId(2), onChain(buyer.wallet.address, 7));
    chain.set(channelId(3), new Error('rpc unreachable'));
    chain.set(channelId(4), onChain(buyer.wallet.address, 2, 300_000n));
    startBuyer();

    const result = await negotiator.reconcileChannelsWithChain();

    expect([1, 2, 3, 4].map((n) => status(channelId(n)))).toEqual(Array(4).fill(CHANNEL_STATUS.ACTIVE));
    expect(readIds()).toEqual([channelId(1), channelId(2), channelId(3)]);
    expect(onChainReadFailure).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ retired: [], unchecked: 2, readError: 'rpc unreachable' });
  });

  it('reads every active channel in one pass, so a closed channel behind many open ones is retired', async () => {
    const base = Date.now() - 100_000;
    const ids = Array.from({ length: 70 }, (_, i) => i + 1);
    for (const n of ids) {
      store.upsertChannel(row(channelId(n), sellerPeer(n), { createdAt: base + n }));
      chain.set(channelId(n), n === 70 ? onChain(buyer.wallet.address, 2, 300_000n) : onChain(buyer.wallet.address, 1));
    }
    startBuyer();

    const result = await negotiator.reconcileChannelsWithChain();

    expect(readIds()).toEqual(ids.map(channelId));
    expect(result).toEqual({ retired: [{ channelId: channelId(70), peerId: sellerPeer(70), status: CHANNEL_STATUS.SETTLED }], unchecked: 0 });
  });

  it('keeps a closed channel the chain says belongs to another buyer', async () => {
    store.upsertChannel(row(channelId(1), sellerPeer(1)));
    chain.set(channelId(1), onChain('0x' + '33'.repeat(20), 2, 300_000n));
    startBuyer();

    const result = await negotiator.reconcileChannelsWithChain();

    expect(status(channelId(1))).toBe(CHANNEL_STATUS.ACTIVE);
    expect(result.unchecked).toBe(1);
  });

  it('retires a never-opened reserve only once every ReserveAuth it signed is an hour past its deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const deadline = nowSecs() + 60;
    store.upsertChannel(row(channelId(1), sellerPeer(1), neverConfirmed(deadline)));
    store.upsertChannel(row(channelId(2), sellerPeer(2), { ...neverConfirmed(deadline - 3600), latestReserveDeadline: deadline }));
    store.upsertChannel(row(channelId(3), sellerPeer(3), { deadline: deadline - 3600, latestReserveDeadline: deadline - 3600 }));
    for (const n of [1, 2, 3]) chain.set(channelId(n), MISSING);
    startBuyer();

    await negotiator.reconcileChannelsWithChain();
    expect([1, 2, 3].map((n) => status(channelId(n)))).toEqual(Array(3).fill(CHANNEL_STATUS.ACTIVE));

    vi.setSystemTime((deadline + 60 * 60) * 1000);
    await negotiator.reconcileChannelsWithChain();
    expect(status(channelId(1))).toBe(CHANNEL_STATUS.ACTIVE);

    vi.setSystemTime((deadline + 60 * 60 + 1) * 1000);
    await negotiator.reconcileChannelsWithChain();
    expect(status(channelId(1))).toBe(CHANNEL_STATUS.GHOST);
    expect(status(channelId(2))).toBe(CHANNEL_STATUS.GHOST);
    expect(status(channelId(3))).toBe(CHANNEL_STATUS.ACTIVE);
  });

  it('keeps a connected seller\'s never-opened channel until the seller disconnects', async () => {
    store.upsertChannel(row(channelId(1), sellerPeer(1), neverConfirmed(nowSecs() - 2 * 3600)));
    chain.set(channelId(1), MISSING);
    startBuyer();
    negotiator.getOrCreatePaymentMux(sellerPeer(1), conn());

    await negotiator.reconcileChannelsWithChain();
    expect(status(channelId(1))).toBe(CHANNEL_STATUS.ACTIVE);

    negotiator.onPeerDisconnect(sellerPeer(1));
    await negotiator.reconcileChannelsWithChain();
    expect(status(channelId(1))).toBe(CHANNEL_STATUS.GHOST);
  });

  it('retires the settled channel of a connected, idle seller and ends its session', async () => {
    store.upsertChannel(row(channelId(1), sellerPeer(1)));
    chain.set(channelId(1), onChain(buyer.wallet.address, 2, 300_000n));
    startBuyer();
    negotiator.getOrCreatePaymentMux(sellerPeer(1), conn());

    await negotiator.reconcileChannelsWithChain();

    expect(status(channelId(1))).toBe(CHANNEL_STATUS.SETTLED);
    expect(bpm.getActiveSession(sellerPeer(1))).toBeNull();
  });

  it('forgets a retired seller\'s lock and unsigned response, so nothing more is signed for that seller', async () => {
    store.upsertChannel(row(CURRENT, SELLER));
    chain.set(CURRENT, onChain(buyer.wallet.address, 1));
    startBuyer();
    await lockSeller();
    respond();
    chain.set(CURRENT, onChain(buyer.wallet.address, 2, 300_000n));
    const sent = spendingAuthsSent().length;

    await negotiator.reconcileChannelsWithChain();

    expect(status(CURRENT)).toBe(CHANNEL_STATUS.SETTLED);
    await expect(negotiator.sendPostResponseAuthTo(SELLER, sellerConn)).resolves.toBeUndefined();
    expect(spendingAuthsSent()).toHaveLength(sent);
  });

  it('keeps the channel of a seller with a close request in flight, then retires it once the request ends', async () => {
    store.upsertChannel(row(channelId(1), sellerPeer(1)));
    chain.set(channelId(1), onChain(buyer.wallet.address, 2, 300_000n));
    startBuyer();
    const closing = negotiator.requestChannelClose(sellerPeer(1), sellerConn, { includeAuth: false, timeoutMs: 60_000 });
    await vi.waitFor(() => expect(sellerConn.send).toHaveBeenCalled());

    await negotiator.reconcileChannelsWithChain();
    expect(status(channelId(1))).toBe(CHANNEL_STATUS.ACTIVE);

    negotiator.onPeerDisconnect(sellerPeer(1));
    await expect(closing).rejects.toThrow(/disconnected/);
    await negotiator.reconcileChannelsWithChain();
    expect(status(channelId(1))).toBe(CHANNEL_STATUS.SETTLED);
  });

  /** Each entry starts payment work on the seller's current channel and returns once it is mid-await, with a way to let it finish. */
  const paymentWorkInFlight: Array<{ work: string; seed?: Partial<StoredChannel>; start: () => Promise<() => Promise<unknown>> }> = [
    {
      work: 'a 402 waits for the seller\'s PaymentRequired',
      start: async () => {
        const answer = negotiator.handle402(paymentRequired402(), pricedSeller, sellerConn, chatRequest());
        return async () => {
          await fromSeller(MessageType.PaymentRequired, codec.encodePaymentRequired({ ...BUDGET, requestId: 'req-1' }));
          await answer;
        };
      },
    },
    {
      work: 'a 402 recovery re-signs the current SpendingAuth',
      start: async () => {
        const held = holdSignatures();
        const answer = negotiator.handle402(paymentRequired402(BUDGET), pricedSeller, sellerConn, chatRequest());
        await held.signing;
        return async () => {
          held.release();
          await vi.waitFor(() => expect(spendingAuthsSent()).toHaveLength(1));
          await fromSeller(MessageType.AuthAck, codec.encodeAuthAck({ channelId: CURRENT }));
          await answer;
        };
      },
    },
    {
      work: 'a NeedAuth is being signed',
      start: async () => {
        const held = holdSignatures();
        const handled = fromSeller(MessageType.NeedAuth, codec.encodeNeedAuth(needAuth(CURRENT, '350000', '50000')));
        await held.signing;
        return async () => {
          held.release();
          await handled;
        };
      },
    },
    {
      work: 'the SpendingAuth after a response is being signed',
      start: async () => {
        await lockSeller();
        respond();
        const held = holdSignatures();
        const sending = negotiator.sendPostResponseAuth(pricedSeller, sellerConn);
        await held.signing;
        return async () => {
          held.release();
          await sending;
        };
      },
    },
    {
      work: 'the SpendingAuth before the next request is being signed',
      start: async () => {
        await lockSeller();
        await negotiator.preparePreRequestAuth(pricedSeller, sellerConn);
        respond();
        const held = holdSignatures();
        const sending = negotiator.preparePreRequestAuth(pricedSeller, sellerConn);
        await held.signing;
        return async () => {
          held.release();
          await sending;
        };
      },
    },
    {
      work: 'a close request signs its SpendingAuth',
      start: async () => {
        const held = holdSignatures();
        const closing = negotiator.requestChannelClose(SELLER, sellerConn, { timeoutMs: 60_000 });
        await held.signing;
        return async () => {
          held.release();
          await vi.waitFor(() => expect(sentToSeller(MessageType.CloseChannelRequest)).toHaveLength(1));
          negotiator.onPeerDisconnect(SELLER);
          await expect(closing).rejects.toThrow(/disconnected/);
        };
      },
    },
    {
      work: 'a pending top-up is recovered before a request',
      seed: { reserveAuthPending: true, reserveMaxAmount: '2000000', confirmedReserveAmount: '1000000' },
      start: async () => {
        const held = holdSignatures();
        const recovering = negotiator.recoverPendingReserveBeforeRequest(pricedSeller, sellerConn);
        await held.signing;
        return async () => {
          held.release();
          await recovering;
        };
      },
    },
    {
      work: 'an external SpendingAuth waits for the seller\'s AuthAck',
      seed: { reserveAuthPending: true, confirmedReserveAmount: '0' },
      start: async () => {
        const applying = negotiator.applyExternalSpendingAuth(pricedSeller, sellerConn, externalSpendingAuthHeader(CURRENT));
        await vi.waitFor(() => expect(spendingAuthsSent()).toHaveLength(1));
        return async () => {
          await fromSeller(MessageType.AuthAck, codec.encodeAuthAck({ channelId: CURRENT }));
          await applying;
        };
      },
    },
  ];

  it.each(paymentWorkInFlight)('keeps the current channel while $work, and retires it once that is done', async ({ seed, start }) => {
    store.upsertChannel(row(CURRENT, SELLER, seed));
    chain.set(CURRENT, onChain(buyer.wallet.address, 1));
    startBuyer();
    const finish = await start();
    chain.set(CURRENT, onChain(buyer.wallet.address, 2, 300_000n));

    await negotiator.reconcileChannelsWithChain();
    expect(status(CURRENT)).toBe(CHANNEL_STATUS.ACTIVE);

    await finish();
    await negotiator.reconcileChannelsWithChain();
    expect(status(CURRENT)).toBe(CHANNEL_STATUS.SETTLED);
  });

  it('signs a fresh channel from zero after a NeedAuth on the retired channel ran across a pass', async () => {
    store.upsertChannel(row(CURRENT, SELLER));
    chain.set(CURRENT, onChain(buyer.wallet.address, 1));
    startBuyer({ deposits: true });
    const held = holdSignatures();
    const handled = fromSeller(MessageType.NeedAuth, codec.encodeNeedAuth(needAuth(CURRENT, '350000', '50000')));
    await held.signing;
    chain.set(CURRENT, onChain(buyer.wallet.address, 2, 350_000n));
    await negotiator.reconcileChannelsWithChain();
    held.release();
    await handled;
    expect(spendingAuthsSent().at(-1)).toMatchObject({ channelId: CURRENT, cumulativeAmount: '350000' });

    await negotiator.reconcileChannelsWithChain();
    expect(store.getChannel(CURRENT)).toMatchObject({ status: CHANNEL_STATUS.SETTLED, settledAmount: '350000' });

    const negotiating = negotiator.handle402(paymentRequired402(BUDGET), pricedSeller, sellerConn, chatRequest());
    await vi.waitFor(() => expect(bpm.getActiveSession(SELLER)).not.toBeNull());
    const fresh = bpm.getActiveSession(SELLER)!.sessionId;
    expect(fresh).not.toBe(CURRENT);
    await fromSeller(MessageType.AuthAck, codec.encodeAuthAck({ channelId: fresh }));
    await expect(negotiating).resolves.toEqual({ action: 'retry' });

    await fromSeller(MessageType.NeedAuth, codec.encodeNeedAuth(needAuth(fresh, '18000', '18000')));
    expect(spendingAuthsSent().at(-1)).toMatchObject({ channelId: fresh, cumulativeAmount: '18000' });
  });

  it('never moves a seller onto another active channel', async () => {
    const older = channelId(1);
    const newer = channelId(2);
    store.upsertChannel(row(older, sellerPeer(1), { createdAt: Date.now() - 60_000 }));
    store.upsertChannel(row(newer, sellerPeer(1)));
    chain.set(older, onChain(buyer.wallet.address, 1));
    chain.set(newer, onChain(buyer.wallet.address, 2, 300_000n));
    startBuyer();

    await negotiator.reconcileChannelsWithChain();
    expect([status(older), status(newer)]).toEqual([CHANNEL_STATUS.ACTIVE, CHANNEL_STATUS.ACTIVE]);
    expect(bpm.getActiveSession(sellerPeer(1))?.sessionId).toBe(newer);

    chain.set(older, onChain(buyer.wallet.address, 2, 100_000n));
    await negotiator.reconcileChannelsWithChain();
    expect([status(older), status(newer)]).toEqual([CHANNEL_STATUS.SETTLED, CHANNEL_STATUS.SETTLED]);
    expect(bpm.getActiveSession(sellerPeer(1))).toBeNull();
  });

  it('leaves a retired seller\'s payment state as a restarted buyer would have it', async () => {
    const peer = sellerPeer(1);
    store.upsertChannel(row(channelId(1), peer));
    chain.set(channelId(1), onChain(buyer.wallet.address, 2, 300_000n));
    startBuyer();
    const paymentState = (manager: BuyerPaymentManager) => ({
      cumulative: manager.getCumulativeAmount(peer),
      reserveCeiling: manager.getReserveCeiling(peer),
      pendingReserve: manager.hasPendingReserveAuth(peer),
      canReplayReserve: manager.canReplayReserveAuth(peer),
      lockConfirmed: manager.isLockConfirmed(peer),
    });
    expect(paymentState(bpm)).toMatchObject({ cumulative: 300_000n, canReplayReserve: true, lockConfirmed: true });

    await negotiator.reconcileChannelsWithChain();

    expect(paymentState(bpm)).toEqual(paymentState(new BuyerPaymentManager(buyer, paymentConfig(dir), store)));
  });

  it('retires a video channel the seller closed and forgets it', async () => {
    const peer = sellerPeer(1);
    store.upsertChannel(row(channelId(1), peer, {
      channelKind: CHANNEL_KIND.ONE_OFF,
      oneOffRequestId: 'video-1',
      authMax: '0',
      reserveMaxAmount: '4200000',
      confirmedReserveAmount: '4200000',
    }));
    chain.set(channelId(1), onChain(buyer.wallet.address, 2, 0n));
    startBuyer();
    expect(bpm.getOneOffChannelForRequest(peer, 'video-1')).toBe(channelId(1));

    await negotiator.reconcileChannelsWithChain();

    expect(status(channelId(1))).toBe(CHANNEL_STATUS.SETTLED);
    expect(bpm.getOneOffChannelForRequest(peer, 'video-1')).toBeNull();
  });

  it('shares one pass between concurrent calls', async () => {
    store.upsertChannel(row(channelId(1), sellerPeer(1)));
    store.upsertChannel(row(channelId(2), sellerPeer(2)));
    chain.set(channelId(1), onChain(buyer.wallet.address, 2, 300_000n));
    chain.set(channelId(2), onChain(buyer.wallet.address, 1));
    startBuyer();

    const [first, second] = await Promise.all([negotiator.reconcileChannelsWithChain(), negotiator.reconcileChannelsWithChain()]);

    expect(readIds().sort()).toEqual([channelId(1), channelId(2)].sort());
    expect(second).toEqual(first);
  });

  it('reads nothing and counts every channel unchecked while the chain cannot be read', async () => {
    store.upsertChannel(row(channelId(1), sellerPeer(1)));
    store.upsertChannel(row(channelId(2), sellerPeer(2), { channelKind: CHANNEL_KIND.ONE_OFF, oneOffRequestId: 'video-1' }));
    chain.set(channelId(1), onChain(buyer.wallet.address, 2, 300_000n));
    chain.set(channelId(2), onChain(buyer.wallet.address, 2, 300_000n));

    reachable = false;
    startBuyer();
    expect(await negotiator.reconcileChannelsWithChain()).toEqual({ retired: [], unchecked: 2 });

    reachable = true;
    startBuyer({ channelsClient: false });
    expect(await negotiator.reconcileChannelsWithChain()).toEqual({ retired: [], unchecked: 2 });

    expect(getSession).not.toHaveBeenCalled();
    expect(onChainReadFailure).not.toHaveBeenCalled();
    expect([status(channelId(1)), status(channelId(2))]).toEqual([CHANNEL_STATUS.ACTIVE, CHANNEL_STATUS.ACTIVE]);
  });

  it('leaves another buyer\'s channels alone', async () => {
    store.upsertChannel(row(channelId(1), sellerPeer(1), { buyerEvmAddr: identity().wallet.address }));
    chain.set(channelId(1), onChain(buyer.wallet.address, 2, 300_000n));
    startBuyer();

    await negotiator.reconcileChannelsWithChain();

    expect(getSession).not.toHaveBeenCalled();
    expect(status(channelId(1))).toBe(CHANNEL_STATUS.ACTIVE);
  });
});
