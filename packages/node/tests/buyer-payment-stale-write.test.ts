import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hexlify, randomBytes, Wallet, type TypedDataDomain, type TypedDataField } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../src/payments/buyer-payment-negotiator.js';
import { ChannelStore, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';
import type { ChannelsClient, ChannelInfo } from '../src/payments/evm/channels-client.js';
import type { DepositsClient } from '../src/payments/evm/deposits-client.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { PeerInfo } from '../src/types/peer.js';
import { toPeerId } from '../src/types/peer.js';
import type { SerializedHttpResponse, SerializedHttpRequest } from '../src/types/http.js';
import * as codec from '../src/p2p/payment-codec.js';
import { MessageType } from '../src/types/protocol.js';
import { computeOneOffChannelPlan, type NeedAuthPayload, type PaymentRequiredPayload, type SpendingAuthPayload } from '@antseed/protocol/messages';

const enc = new TextEncoder();
const SELLER = toPeerId('b'.repeat(40));
const RESERVE = 10_000_000n;
const PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
/** A 1500-unit response: 100 output tokens at $15/M. */
const PROBE = {
  inputBytes: new Uint8Array(0),
  outputBytes: new Uint8Array(0),
  reportedOutputTokens: 100n,
  sellerClaimedCost: 1_500n,
  requestId: 'probe',
};
const OLD_SPENT = 50_000n;
const PLENTY = { available: 10n ** 12n, reserved: 0n };
/** Two 1024x1024 images at $0.004: an 8000-unit request. */
const IMAGE_BILLING = {
  context: {
    sellerPeerId: SELLER,
    provider: 'openai',
    service: 'gpt-image-2',
    serviceApiProtocol: 'openai-images',
    attributes: { model: 'gpt-image-2', size: '1024x1024' },
  },
  requestFacts: { kind: 'image', image: {} },
  tokenPricing: PRICING,
  unitModel: {
    version: 1,
    components: [{ unit: 'output_images', priceUsd: 0.004, match: { size: '1024x1024' } }],
  },
} as never;

interface Gate {
  arrived: Promise<void>;
  arrive(): void;
  opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let arrive!: () => void;
  let open!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { arrived, arrive, opened, open };
}

/** A wallet whose next signature waits until the test opens its gate. */
class HeldSigner extends Wallet {
  private _held: Gate | null = null;

  holdNextSignature(): Gate {
    this._held = gate();
    return this._held;
  }

  override async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const held = this._held;
    this._held = null;
    if (held) {
      held.arrive();
      await held.opened;
    }
    return super.signTypedData(domain, types, value);
  }
}

function recordingMux(): PaymentMux & { sent: SpendingAuthPayload[] } {
  const mux = {
    sent: [] as SpendingAuthPayload[],
    sendSpendingAuth(payload: SpendingAuthPayload) { mux.sent.push(payload); },
  };
  return mux as unknown as PaymentMux & { sent: SpendingAuthPayload[] };
}

function chainInfo(status: number, deposit: bigint, settled = 0n): ChannelInfo {
  return {
    buyer: '0x' + '11'.repeat(20),
    seller: '0x' + '22'.repeat(20),
    deposit,
    settled,
    metadataHash: '0x' + '00'.repeat(32),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    settledAt: 0n,
    closeRequestedAt: 0n,
    status,
  } as ChannelInfo;
}

const MISSING_ON_CHAIN = {
  ...chainInfo(0, 0n),
  buyer: '0x' + '00'.repeat(20),
  seller: '0x' + '00'.repeat(20),
} as ChannelInfo;

function make402(body: Record<string, unknown>): SerializedHttpResponse {
  return {
    requestId: 'req-402',
    statusCode: 402,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify({ error: 'payment_required', suggestedAmount: '1000000', ...body })),
  };
}

const REQUEST: SerializedHttpRequest = {
  requestId: 'req-402',
  method: 'POST',
  path: '/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  body: enc.encode(JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })),
};

const PEER = {
  peerId: SELLER,
  lastSeen: Date.now(),
  providers: ['openai'],
  defaultInputUsdPerMillion: 3,
  defaultOutputUsdPerMillion: 15,
} as PeerInfo;

interface Race {
  oldChannelId: string;
  newChannelId: string;
  outcome: string;
  sentAfterRetire: SpendingAuthPayload[];
}

describe('a payment write that awaited while the seller channel moved on', () => {
  let tempDir: string;
  let identity: Identity;
  let signer: HeldSigner;
  let store: ChannelStore;
  let manager: BuyerPaymentManager;
  let mux: ReturnType<typeof recordingMux>;
  let reserve: bigint;

  function setup(overrides: Partial<BuyerPaymentConfig> = {}): void {
    reserve = overrides.maxReserveAmountUsdc ?? RESERVE;
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: '0x' + 'cc'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: 31337,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n,
      maxReserveAmountUsdc: RESERVE,
      dataDir: tempDir,
      ...overrides,
    }, store);
    manager.setSigner(signer);
    vi.spyOn(manager, 'getBalance').mockResolvedValue(PLENTY);
    mux = recordingMux();
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-stale-write-'));
    const wallet = Wallet.createRandom();
    identity = {
      peerId: toPeerId(wallet.address.slice(2).toLowerCase()),
      privateKey: new Uint8Array(32),
      wallet,
    } as unknown as Identity;
    signer = new HeldSigner(Wallet.createRandom().privateKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function openChannel(paymentMux: PaymentMux = mux): Promise<string> {
    const channelId = await manager.authorizeSpending(SELLER, paymentMux, 10_000n, PRICING);
    await manager.handleAuthAck(SELLER, { version: 1, channelId } as never);
    return channelId;
  }

  function needAuth(channelId: string, cost: bigint, extra: Partial<NeedAuthPayload> = {}): NeedAuthPayload {
    return {
      channelId,
      requiredCumulativeAmount: (manager.getCumulativeAmount(SELLER) + cost).toString(),
      currentAcceptedCumulative: '0',
      deposit: reserve.toString(),
      lastRequestCost: cost.toString(),
      ...extra,
    } as NeedAuthPayload;
  }

  async function spend(channelId: string, cost: bigint, paymentMux: PaymentMux = mux): Promise<void> {
    await manager.handleNeedAuth(SELLER, needAuth(channelId, cost), paymentMux);
  }

  /** The seller's channel with OLD_SPENT signed on it. */
  async function oldChannel(paymentMux: PaymentMux = mux): Promise<string> {
    const channelId = await openChannel(paymentMux);
    await spend(channelId, OLD_SPENT, paymentMux);
    return channelId;
  }

  function settle(write: Promise<unknown>): Promise<string> {
    return write.then(
      () => 'completed',
      (err: unknown) => String((err as { code?: unknown } | null)?.code ?? 'failed'),
    );
  }

  /**
   * While `write` waits at `held`, retire the seller's channel through the
   * existing retire path and open a new one, then let the write finish.
   */
  async function replaceWhileHeld(
    held: { arrived: Promise<void>; release(): void },
    write: Promise<unknown>,
    oldChannelId: string,
    paymentMux: PaymentMux = mux,
  ): Promise<Race> {
    await held.arrived;
    manager.retireSession(SELLER, CHANNEL_STATUS.SETTLED, OLD_SPENT);
    const sentBefore = mux.sent.length;
    const newChannelId = await openChannel(paymentMux);
    held.release();
    const outcome = await settle(write);
    return { oldChannelId, newChannelId, outcome, sentAfterRetire: mux.sent.slice(sentBefore) };
  }

  function heldSignature(): { arrived: Promise<void>; release(): void } {
    const held = signer.holdNextSignature();
    return { arrived: held.arrived, release: held.open };
  }

  /** Retire the seller's channel and adopt a new one, all in one synchronous step. */
  function replaceNow(): string {
    const old = manager.getActiveSession(SELLER)!;
    manager.retireSession(SELLER, CHANNEL_STATUS.SETTLED, OLD_SPENT);
    const now = Date.now();
    const replacement: StoredChannel = {
      ...old,
      sessionId: hexlify(randomBytes(32)),
      authMax: '0',
      tokensDelivered: '0',
      previousConsumption: '0',
      requestCount: 0,
      status: CHANNEL_STATUS.ACTIVE,
      settledAt: null,
      settledAmount: null,
      latestSpendingAuthSig: null,
      latestMetadata: null,
      reserveSalt: hexlify(randomBytes(32)),
      initialReserveAmount: reserve.toString(),
      reserveMaxAmount: reserve.toString(),
      reserveAuthPending: false,
      confirmedReserveAmount: reserve.toString(),
      createdAt: old.createdAt + 1,
      updatedAt: now,
    };
    store.upsertChannel(replacement);
    manager.adoptPersistedAuthorization(replacement);
    return replacement.sessionId;
  }

  /** What the new channel looks like after the race, ending with its next per-request signature. */
  async function newChannelAfter(race: Race): Promise<Record<string, unknown>> {
    const reserveCeiling = manager.getReserveCeiling(SELLER);
    const pendingReserve = manager.hasPendingReserveAuth(SELLER);
    const oldChannelStatus = store.getChannel(race.oldChannelId)?.status;
    const sentToOldChannel = race.sentAfterRetire.filter((p) => p.channelId === race.oldChannelId).length;
    let nextSignature: string;
    try {
      const { payload } = await manager.signPerRequestAuth(SELLER, PROBE);
      const on = payload.channelId === race.newChannelId ? 'new' : payload.channelId === race.oldChannelId ? 'old' : 'other';
      nextSignature = `${on} channel at ${payload.cumulativeAmount}`;
    } catch (err) {
      nextSignature = `none (${String((err as { code?: unknown }).code ?? err)})`;
    }
    return { nextSignature, reserveCeiling, pendingReserve, oldChannelStatus, sentToOldChannel };
  }

  function untouched(): Record<string, unknown> {
    return {
      nextSignature: 'new channel at 1500',
      reserveCeiling: reserve,
      pendingReserve: false,
      oldChannelStatus: CHANNEL_STATUS.SETTLED,
      sentToOldChannel: 0,
    };
  }

  describe('in BuyerPaymentManager', () => {
    beforeEach(() => setup());

    it('per-request SpendingAuth (signPerRequestAuth) held at the signer', async () => {
      const oldChannelId = await oldChannel();
      const held = heldSignature();
      const write = manager.signPerRequestAuth(SELLER, { ...PROBE, requestId: 'old-response' });

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('buyer-session-state');
    });

    it('NeedAuth (handleNeedAuth) held at the signer', async () => {
      const oldChannelId = await oldChannel();
      const held = heldSignature();
      const write = manager.handleNeedAuth(SELLER, needAuth(oldChannelId, 10_000n), mux);

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('completed');
    });

    it('catch-up SpendingAuth (extendCurrentSpendingAuth) held at the signer', async () => {
      const oldChannelId = await oldChannel();
      const held = heldSignature();
      const write = manager.extendCurrentSpendingAuth(SELLER, 10_000n, mux, OLD_SPENT + 10_000n, 'req-402');

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('buyer-session-state');
    });

    it('resent SpendingAuth (resendCurrentSpendingAuth) held at the signer', async () => {
      const oldChannelId = await oldChannel();
      const held = heldSignature();
      const write = manager.resendCurrentSpendingAuth(SELLER, mux);

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('buyer-session-state');
    });

    it('reserve top-up (topUpReserve) held at the signer', async () => {
      const oldChannelId = await oldChannel();
      const held = heldSignature();
      const write = manager.topUpReserve(SELLER, mux);

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('completed');
    });

    it('reserve top-up (topUpReserve) held at the deposit balance read', async () => {
      const oldChannelId = await oldChannel();
      const balance = gate();
      vi.spyOn(manager, 'getBalance').mockImplementationOnce(async () => {
        balance.arrive();
        await balance.opened;
        return PLENTY;
      });
      const write = manager.topUpReserve(SELLER, mux);

      const race = await replaceWhileHeld({ arrived: balance.arrived, release: balance.open }, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('completed');
    });

    it('reserve replay (resendReserveAuth) held at the signer', async () => {
      const oldChannelId = await oldChannel();
      const held = heldSignature();
      const write = manager.resendReserveAuth(SELLER, mux);

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('buyer-session-state');
    });

    it('pending reserve replay (resendPendingReserveAuth) held at the signer', async () => {
      const oldChannelId = await oldChannel();
      await manager.topUpReserve(SELLER, mux);
      const later = Date.now() + 2 * 3_600_000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      const held = heldSignature();
      const write = manager.resendPendingReserveAuth(SELLER, mux);

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('failed');
    });

    it('close authorization (buildCloseChannelRequest) held at the signer', async () => {
      const oldChannelId = await oldChannel();
      const held = heldSignature();
      const write = manager.buildCloseChannelRequest(SELLER);

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('buyer-session-state');
    });

    it('close authorization capped at the deposit, held at the signer', async () => {
      const oldChannelId = await oldChannel();
      const held = heldSignature();
      const write = manager.buildCloseChannelRequest(SELLER, { maxCumulative: OLD_SPENT - 1n });

      const race = await replaceWhileHeld(held, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('buyer-session-state');
    });

    it('per-request SpendingAuth whose channel is replaced while it is being persisted', async () => {
      const oldChannelId = await oldChannel();
      const commit = store.commitAuthorization.bind(store);
      let newChannelId = '';
      vi.spyOn(store, 'commitAuthorization').mockImplementation((channel, totals) => {
        commit(channel, totals);
        if (!newChannelId && channel.sessionId === oldChannelId) newChannelId = replaceNow();
      });

      const outcome = await settle(manager.signPerRequestAuth(SELLER, { ...PROBE, requestId: 'old-response' }));
      vi.mocked(store.commitAuthorization).mockRestore();

      expect(await newChannelAfter({ oldChannelId, newChannelId, outcome, sentAfterRetire: [] })).toEqual(untouched());
      expect(outcome).toBe('buyer-session-state');
    });

    it('one-off video NeedAuth held at the signer while its channel is retired', async () => {
      const video = {
        context: { sellerPeerId: SELLER, service: 'video-model', provider: 'venice', serviceApiProtocol: 'venice-video', unitLimits: { video_generations: 1 } },
        requestFacts: { kind: 'video', video: { protocol: 'venice-video', action: 'create' } },
        unitModel: { version: 1, components: [{ unit: 'video_generations', priceUsd: 4.2 }] },
        estimatedCostUsdc: 4_200_000n,
      } as never;
      manager.trackRequestBilling('video-request', video);
      const channelId = await manager.openOneOffChannel(SELLER, 'video-request', computeOneOffChannelPlan(4_200_000n, 1_000_000n, 6_500n), mux);
      await manager.handleAuthAck(SELLER, { version: 1, channelId } as never);
      manager.trackVideoJob(SELLER, 'venice-video', 'job-1', video, 'video-request');
      manager.trackVideoRetrieve(SELLER, 'venice-video', 'job-1', 'retrieve-request');
      manager.recordVideoDelivered(SELLER, 'venice-video', 'job-1', 'retrieve-request');
      const spent: string[] = [];
      manager.setSpendListener((event) => { spent.push(event.amountUsdc); });
      const held = signer.holdNextSignature();
      const write = manager.handleNeedAuth(SELLER, {
        channelId,
        requestId: 'retrieve-request',
        requiredCumulativeAmount: '4200000',
        currentAcceptedCumulative: '650000',
        deposit: '4200000',
        lastRequestCost: '4200000',
        inputTokens: '0',
        outputTokens: '0',
        billingUsage: { version: 1, units: { video_generations: '1' } },
      } as NeedAuthPayload, mux);

      await held.arrived;
      manager.retireOneOffChannel(channelId);
      const sentBefore = mux.sent.length;
      held.open();
      await write;

      expect({
        status: store.getChannel(channelId)?.status,
        sentAfterRetire: mux.sent.slice(sentBefore).length,
        spent,
      }).toEqual({ status: CHANNEL_STATUS.SETTLED, sentAfterRetire: 0, spent: [] });
    });
  });

  describe('in BuyerPaymentManager, a NeedAuth waiting for the delivered usage', () => {
    beforeEach(() => setup({ maxReserveAmountUsdc: 200_000n }));

    it('does not top up the new channel', async () => {
      const oldChannelId = await openChannel();
      await spend(oldChannelId, 100_000n);
      await spend(oldChannelId, 100_000n);
      manager.trackRequestBilling('req-image', IMAGE_BILLING);
      const write = manager.handleNeedAuth(SELLER, imageNeedAuth(oldChannelId, 300_000n), mux);

      const race = await replaceWhileHeld({
        arrived: Promise.resolve(),
        release: deliverImages,
      }, write, oldChannelId);

      expect(await newChannelAfter(race)).toEqual(untouched());
      expect(race.outcome).toBe('completed');
    });
  });

  /** The image request's NeedAuth: it waits for the buyer to see the images delivered. */
  function imageNeedAuth(channelId: string, requiredCumulativeAmount: bigint): NeedAuthPayload {
    return needAuth(channelId, 8_000n, {
      requestId: 'req-image',
      requiredCumulativeAmount: requiredCumulativeAmount.toString(),
      inputTokens: '0',
      freshInputTokens: '0',
      cachedInputTokens: '0',
      outputTokens: '0',
      billingUsage: { version: 1, units: { output_images: '2' } },
    } as Partial<NeedAuthPayload>);
  }

  function deliverImages(): void {
    manager.recordObservedUnitUsage('req-image', { units: { output_images: 2 } });
  }

  describe('in BuyerPaymentManager, a NeedAuth that a later one signed past', () => {
    beforeEach(() => setup());

    function signedOn(channelId: string, sentBefore: number): Record<string, unknown> {
      return {
        committed: store.getChannel(channelId)?.authMax,
        inMemory: manager.getCumulativeAmount(SELLER),
        sent: mux.sent.slice(sentBefore).map((payload) => payload.cumulativeAmount),
      };
    }

    it('held at the usage wait, leaves the higher cumulative committed and in memory', async () => {
      const channelId = await openChannel();
      const sentBefore = mux.sent.length;
      manager.trackRequestBilling('req-image', IMAGE_BILLING);
      const earlier = manager.handleNeedAuth(SELLER, imageNeedAuth(channelId, 8_000n), mux);
      await manager.handleNeedAuth(SELLER, needAuth(channelId, 28_000n), mux);
      deliverImages();
      await earlier;

      expect(signedOn(channelId, sentBefore)).toEqual({ committed: '28000', inMemory: 28_000n, sent: ['28000'] });
    });

    it('held at the signer, leaves the higher cumulative committed and in memory', async () => {
      const channelId = await openChannel();
      const sentBefore = mux.sent.length;
      const held = signer.holdNextSignature();
      const earlier = manager.handleNeedAuth(SELLER, needAuth(channelId, 8_000n), mux);
      await held.arrived;
      await manager.handleNeedAuth(SELLER, needAuth(channelId, 28_000n), mux);
      held.open();
      await earlier;

      expect(signedOn(channelId, sentBefore)).toEqual({ committed: '28000', inMemory: 28_000n, sent: ['28000'] });
    });

    it('held at the usage wait, signs and reports only what the later one left', async () => {
      const channelId = await openChannel();
      const sentBefore = mux.sent.length;
      const reported: bigint[] = [];
      manager.setSpendListener((event) => { reported.push(BigInt(event.amountUsdc)); });
      manager.trackRequestBilling('req-image', IMAGE_BILLING);
      const earlier = manager.handleNeedAuth(SELLER, imageNeedAuth(channelId, 28_000n), mux);
      await manager.handleNeedAuth(SELLER, needAuth(channelId, 20_000n), mux);
      deliverImages();
      await earlier;

      expect({
        ...signedOn(channelId, sentBefore),
        reported: reported.reduce((sum, amount) => sum + amount, 0n),
      }).toEqual({ committed: '28000', inMemory: 28_000n, sent: ['20000', '28000'], reported: 28_000n });
    });
  });

  describe('in BuyerPaymentNegotiator', () => {
    let conn: PeerConnection;
    let pmux: PaymentMux;
    let channels: { getSession: ReturnType<typeof vi.fn> };
    let deposits: { getBuyerBalance: ReturnType<typeof vi.fn> };
    let negotiator: BuyerPaymentNegotiator;
    let onChain: Map<string, ChannelInfo>;

    function setupNegotiator(overrides: Partial<BuyerPaymentConfig> = {}): void {
      setup(overrides);
      onChain = new Map();
      channels = { getSession: vi.fn(async (channelId: string) => onChain.get(channelId) ?? MISSING_ON_CHAIN) };
      deposits = { getBuyerBalance: vi.fn().mockResolvedValue({ available: 0n, reserved: 1n, lastActivityAt: 0n }) };
      conn = { send: vi.fn() } as unknown as PeerConnection;
      negotiator = new BuyerPaymentNegotiator(
        identity,
        manager,
        deposits as unknown as DepositsClient,
        channels as unknown as ChannelsClient,
        store,
        {},
        { emit: vi.fn() },
      );
      pmux = negotiator.getOrCreatePaymentMux(SELLER, conn);
    }

    /** Run `replaceNow` right after the next call to `method` returns, before its caller resumes. */
    function replaceAfterNext(method: 'reconcileReserveAmount' | 'resendPendingReserveAuth' | 'extendCurrentSpendingAuth' | 'signPerRequestAuth'): { newChannelId: () => string } {
      const original = (manager[method] as (...args: unknown[]) => Promise<unknown>).bind(manager);
      let newChannelId = '';
      vi.spyOn(manager, method).mockImplementationOnce((async (...args: unknown[]) => {
        const result = await original(...args);
        newChannelId = replaceNow();
        return result;
      }) as never);
      return { newChannelId: () => newChannelId };
    }

    async function race(oldChannelId: string, write: Promise<unknown>, replacement: { newChannelId: () => string }): Promise<Race> {
      const outcome = await settle(write);
      return { oldChannelId, newChannelId: replacement.newChannelId(), outcome, sentAfterRetire: [] };
    }

    it('402 catch-up held at the on-chain read of the channel', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      onChain.set(oldChannelId, chainInfo(1, 7_000_000n));
      const read = gate();
      channels.getSession.mockImplementationOnce(async (channelId: string) => {
        read.arrive();
        await read.opened;
        return onChain.get(channelId);
      });
      const write = negotiator.handle402(make402({ minBudgetPerRequest: '10000', requiredCumulativeAmount: '60000' }), PEER, conn, REQUEST);

      const result = await replaceWhileHeld({ arrived: read.arrived, release: read.open }, write, oldChannelId, pmux);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('buyer-session-state');
    });

    it('402 catch-up after reconciling the reserve with the chain', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      onChain.set(oldChannelId, chainInfo(1, RESERVE));
      const replacement = replaceAfterNext('reconcileReserveAmount');
      const write = negotiator.handle402(make402({ minBudgetPerRequest: '10000', requiredCumulativeAmount: '60000' }), PEER, conn, REQUEST);

      const result = await race(oldChannelId, write, replacement);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('buyer-session-state');
    });

    it('402 catch-up after replaying the pending reserve', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      await manager.topUpReserve(SELLER, pmux);
      onChain.set(oldChannelId, chainInfo(1, RESERVE));
      const replacement = replaceAfterNext('resendPendingReserveAuth');
      const write = negotiator.handle402(make402({ minBudgetPerRequest: '10000', requiredCumulativeAmount: '60000' }), PEER, conn, REQUEST);

      const result = await race(oldChannelId, write, replacement);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('buyer-session-state');
    });

    it('402 catch-up after the catch-up SpendingAuth', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      onChain.set(oldChannelId, chainInfo(1, RESERVE));
      const replacement = replaceAfterNext('extendCurrentSpendingAuth');
      const write = negotiator.handle402(make402({ minBudgetPerRequest: '10000', requiredCumulativeAmount: '60000' }), PEER, conn, REQUEST);

      const result = await race(oldChannelId, write, replacement);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('buyer-session-state');
    });

    /** Replace the seller's channel, then handle a 402 the seller sent about the old one. */
    async function staleFor402(requirements: Partial<PaymentRequiredPayload>, via: 'body' | 'PaymentRequired'): Promise<Race> {
      const oldChannelId = await oldChannel(pmux);
      const newChannelId = replaceNow();
      onChain.set(newChannelId, chainInfo(1, RESERVE));
      const aboutOld = { minBudgetPerRequest: '10000', suggestedAmount: '1000000', ...requirements, channelId: oldChannelId };
      if (via === 'PaymentRequired') {
        await pmux.handleFrame({
          type: MessageType.PaymentRequired,
          messageId: 3,
          payload: codec.encodePaymentRequired({ ...aboutOld, requestId: REQUEST.requestId }),
        });
      }
      const result = await negotiator.handle402(make402(via === 'body' ? aboutOld : {}), PEER, conn, REQUEST);
      return { oldChannelId, newChannelId, outcome: result.action, sentAfterRetire: [] };
    }

    it.each([
      { about: 'says the old channel is exhausted', via: 'body', requirements: { requiredCumulativeAmount: '60000', reserveMaxAmount: OLD_SPENT.toString(), code: 'channel_exhausted' } },
      { about: 'asks the old channel to catch up', via: 'body', requirements: { requiredCumulativeAmount: '60000' } },
      { about: 'asks the old channel to catch up', via: 'PaymentRequired', requirements: { requiredCumulativeAmount: '60000' } },
    ] as const)('402 that $about, in its $via, handled after the new channel is committed', async ({ via, requirements }) => {
      setupNegotiator();

      const result = await staleFor402(requirements, via);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('retry');
    });

    it('402 held at the on-chain check of stored sessions', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      const read = gate();
      channels.getSession
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockImplementationOnce(async () => {
          read.arrive();
          await read.opened;
          return chainInfo(2, RESERVE, OLD_SPENT);
        });
      const write = negotiator.handle402(make402({ minBudgetPerRequest: '10000', requiredCumulativeAmount: '60000' }), PEER, conn, REQUEST);

      const result = await replaceWhileHeld({ arrived: read.arrived, release: read.open }, write, oldChannelId, pmux);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('completed');
    });

    it('402 held at the reserved-balance check before ghosting a stale session', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      channels.getSession.mockRejectedValue(new Error('rpc down'));
      const balance = gate();
      deposits.getBuyerBalance
        .mockImplementationOnce(async () => {
          balance.arrive();
          await balance.opened;
          return { available: 0n, reserved: 0n, lastActivityAt: 0n };
        })
        .mockResolvedValue({ available: 0n, reserved: 0n, lastActivityAt: 0n });
      const write = negotiator.handle402(make402({ minBudgetPerRequest: '10000', requiredCumulativeAmount: '60000' }), PEER, conn, REQUEST);

      const result = await replaceWhileHeld({ arrived: balance.arrived, release: balance.open }, write, oldChannelId, pmux);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('completed');
    });

    it('channel close held while draining a NeedAuth', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      const closeRequests = vi.spyOn(pmux, 'sendCloseChannelRequest');
      const held = heldSignature();
      void pmux.handleFrame({
        type: 0x58,
        messageId: 1,
        payload: enc.encode(JSON.stringify(needAuth(oldChannelId, 10_000n))),
      });
      const write = negotiator.requestChannelClose(SELLER, conn, { timeoutMs: 100 });

      const result = await replaceWhileHeld(held, write, oldChannelId, pmux);

      expect({
        ...await newChannelAfter(result),
        closeRequestedFor: closeRequests.mock.calls.map(([payload]) => payload.channelId === oldChannelId ? 'old' : 'new'),
      }).toEqual({ ...untouched(), closeRequestedFor: [] });
      expect(result.outcome).toBe('failed');
    });

    it('channel close answered closed after the channel was replaced', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      const closeRequests = vi.spyOn(pmux, 'sendCloseChannelRequest');
      const write = negotiator.requestChannelClose(SELLER, conn, { timeoutMs: 5_000 });
      const sent = gate();
      void vi.waitFor(() => expect(closeRequests).toHaveBeenCalled()).then(sent.arrive);

      const result = await replaceWhileHeld({
        arrived: sent.arrived,
        release: () => void pmux.handleFrame({
          type: 0x5A,
          messageId: 2,
          payload: enc.encode(JSON.stringify({ channelId: oldChannelId, status: 'closed', finalAmount: OLD_SPENT.toString(), txHash: '0x' + '12'.repeat(32) })),
        }),
      }, write, oldChannelId, pmux);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('completed');
    });

    it('channel close answered no_channel after the channel was replaced', async () => {
      setupNegotiator();
      const oldChannelId = await oldChannel(pmux);
      const closeRequests = vi.spyOn(pmux, 'sendCloseChannelRequest');
      const write = negotiator.requestChannelClose(SELLER, conn, { timeoutMs: 5_000 });
      const sent = gate();
      void vi.waitFor(() => expect(closeRequests).toHaveBeenCalled()).then(sent.arrive);

      const result = await replaceWhileHeld({
        arrived: sent.arrived,
        release: () => void pmux.handleFrame({
          type: 0x5A,
          messageId: 2,
          payload: enc.encode(JSON.stringify({ channelId: oldChannelId, status: 'rejected', code: 'no_channel', reason: 'unknown channel' })),
        }),
      }, write, oldChannelId, pmux);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('completed');
    });

    it('per-request reserve top-up after the per-request SpendingAuth', async () => {
      setupNegotiator({ maxReserveAmountUsdc: 200_000n });
      const oldChannelId = await openChannel(pmux);
      await spend(oldChannelId, 100_000n, pmux);
      await spend(oldChannelId, 50_000n, pmux);
      onChain.set(oldChannelId, chainInfo(1, 200_000n));
      const locked = await negotiator.handle402(make402({ minBudgetPerRequest: '10000', requiredCumulativeAmount: '150000' }), PEER, conn, REQUEST);
      expect(locked.action).toBe('retry');
      negotiator.estimateCostFromResponse(PEER, {
        requestId: 'req-2',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 100 } })),
      });
      const replacement = replaceAfterNext('signPerRequestAuth');
      const write = negotiator.sendPostResponseAuthTo(SELLER, conn);

      const result = await race(oldChannelId, write, replacement);

      expect(await newChannelAfter(result)).toEqual(untouched());
      expect(result.outcome).toBe('completed');
    });
  });
});
