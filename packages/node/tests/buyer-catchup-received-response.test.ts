import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import type { NeedAuthPayload, SpendingAuthPayload } from '@antseed/protocol/messages';

/** maxPerRequestUsdc: the most the buyer signs beyond cost it has verified ($0.50). */
const WINDOW = 500_000n;
/** maxReserveAmountUsdc: one reserve step ($1.00). */
const RESERVE = 1_000_000n;
/** The buyer's whole deposit ($10.00). */
const DEPOSIT = 10_000_000n;
/** $1 per million tokens: N input tokens price to exactly N base units. */
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
/** The seller's per-request budget in its 402. */
const MIN_BUDGET = 10_000n;
/** How many catch-ups each case answers. */
const ROUNDS = 10;

/**
 * What the buyer signs when a seller's 402 asks it to catch up on a channel
 * whose overdraft window is used up. Each case drives the payment manager the
 * way the request handler does: a paid request is sent, the seller answers it
 * with a 402 carrying the cumulative amount it wants, and the buyer's retry
 * signs toward it (extendCurrentSpendingAuth).
 */
describe('BuyerPaymentManager: a catch-up reopens the overdraft window only for responses the buyer received', () => {
  let tempDir: string;
  let store: ChannelStore;
  let identity: Identity;
  let manager: BuyerPaymentManager;
  let sent: SpendingAuthPayload[];
  let mux: PaymentMux;
  let sellerPeerId: string;
  let channelId: string;
  let chain: { available: bigint; locked: bigint };

  const peerId = (name: string): string => Buffer.from(name).toString('hex').padEnd(40, '0').slice(0, 40);

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-catchup-received-'));
    store = new ChannelStore(tempDir);
    const privateKey = randomBytes(32);
    const wallet = new Wallet('0x' + bytesToHex(privateKey));
    identity = { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
    sent = [];
    mux = { sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload); } } as unknown as PaymentMux;
    sellerPeerId = peerId('seller-under-test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A buyer with a channel to the seller, its reserve `reserve` and its deposits read from `chain`. */
  async function openChannel(reserve = RESERVE): Promise<void> {
    manager = new BuyerPaymentManager(identity, {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: '0x' + 'cc'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: 31337,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: WINDOW,
      maxReserveAmountUsdc: reserve,
      dataDir: tempDir,
    }, store);
    chain = { available: DEPOSIT, locked: 0n };
    vi.spyOn(manager, 'getBalance').mockImplementation(async () => ({ available: chain.available, reserved: chain.locked }));
    manager.setChannelDepositReader(async () => chain.locked);
    channelId = await manager.authorizeSpending(sellerPeerId, mux, MIN_BUDGET, reserve, PRICING);
    chain = { available: chain.available - reserve, locked: reserve };
    await manager.handleAuthAck(sellerPeerId, { channelId });
    sent.length = 0;
  }

  const signed = (): bigint => manager.getCumulativeAmount(sellerPeerId);
  const verified = (): bigint => manager.getVerifiedCost(sellerPeerId);

  /** Any reserve top-up the buyer signed since `before` lands on-chain. */
  function landTopUps(before: number): void {
    for (const auth of sent.slice(before)) {
      if (auth.reserveMaxAmount === undefined) continue;
      const newMax = BigInt(auth.reserveMaxAmount);
      if (newMax <= chain.locked) continue;
      chain = { available: chain.available - (newMax - chain.locked), locked: newMax };
    }
  }

  // ── What the request handler tells the payment manager ──────────────────
  /** The request handler sends a paid request. */
  const send = (_requestId: string): void => manager.beginPaidRequest(sellerPeerId);
  /** The buyer received the response and priced it at `cost` itself, from the usage in the response. */
  const deliver = (requestId: string, cost: bigint): void => {
    manager.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc: cost });
    manager.endPaidRequest(sellerPeerId, requestId);
  };

  // ── What the seller sends ────────────────────────────────────────────────
  /** The seller's 402 for the request in flight, asking for `target` in total; the buyer's retry signs toward it. */
  async function catchUp(target: bigint, requestId?: string, inFlightRequests?: number): Promise<void> {
    const before = sent.length;
    await manager.extendCurrentSpendingAuth(sellerPeerId, MIN_BUDGET, mux, target, requestId, inFlightRequests);
    landTopUps(before);
  }
  /** A seller prompt with no response cost, asking for `required` in total. */
  async function prompt(required: bigint): Promise<void> {
    const before = sent.length;
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: required.toString(),
      currentAcceptedCumulative: signed().toString(),
      deposit: chain.locked.toString(),
    }, mux);
    landTopUps(before);
  }
  /** One NeedAuth: `cost` for `requestId`, asking for `required` in total. */
  async function claim(requestId: string, cost: bigint, required: bigint): Promise<void> {
    const before = sent.length;
    const frame: NeedAuthPayload = {
      channelId,
      requestId,
      lastRequestCost: cost.toString(),
      inputTokens: cost.toString(),
      outputTokens: '0',
      requiredCumulativeAmount: required.toString(),
      currentAcceptedCumulative: '0',
      deposit: chain.locked.toString(),
    };
    await manager.handleNeedAuth(sellerPeerId, frame, mux);
    landTopUps(before);
  }
  /** The buyer's own signing before a cooperative close, for the last response it received. */
  const signAtClose = (requestId: string, cost: bigint) => manager.signPerRequestAuth(sellerPeerId, {
    requestId, sellerClaimedCost: cost, reportedInputTokens: cost, reportedOutputTokens: 0n,
    inputBytes: new Uint8Array(0), outputBytes: new Uint8Array(0),
  });

  it('signs one overdraft window for catch-ups on requests that returned nothing, however many follow', async () => {
    await openChannel();
    for (let round = 0; round < ROUNDS; round += 1) {
      const requestId = `answered-402-${round}`;
      send(requestId);
      // The seller asks for more than is signed every time.
      await catchUp(signed() + WINDOW, requestId);
      // Its answer was the 402 itself, or the attempt was cut off with nothing to price.
      if (round % 2 === 0) manager.endPaidRequest(sellerPeerId, requestId, true);
      else manager.endPaidRequest(sellerPeerId, requestId);
      expect(signed(), `round ${round}: signed past one window with nothing received`).toBeLessThanOrEqual(WINDOW);
      expect(verified(), `round ${round}: verified a cost with nothing received`).toBe(0n);
    }
    expect(signed()).toBe(WINDOW);
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(RESERVE);
  });

  it('stops at verified cost plus one window while catch-ups reach the reserve ceiling and top it up', async () => {
    const reserve = 200_000n;
    await openChannel(reserve);
    const topUps = vi.spyOn(manager, 'topUpReserve');
    // One response delivered and paid for, so the window starts above zero.
    send('paid');
    deliver('paid', 100_000n);
    await claim('paid', 100_000n, 100_000n);
    expect(signed()).toBe(100_000n);
    expect(verified()).toBe(100_000n);

    for (let round = 0; round < ROUNDS; round += 1) {
      const requestId = `answered-402-${round}`;
      send(requestId);
      await catchUp(signed() + WINDOW, requestId);
      manager.endPaidRequest(sellerPeerId, requestId, true);
      expect(signed(), `round ${round}: signed past verified cost plus one window`).toBeLessThanOrEqual(100_000n + WINDOW);
      expect(verified(), `round ${round}: verified a cost with nothing received`).toBe(100_000n);
    }
    expect(topUps, 'the catch-ups never reached the reserve ceiling').toHaveBeenCalled();
    expect(manager.getReserveCeiling(sellerPeerId)).toBeGreaterThanOrEqual(100_000n + WINDOW);
    expect(signed()).toBe(100_000n + WINDOW);
  });

  /**
   * The seller's claim for r1 is above the buyer's price for it, so the rest is
   * signed in the window and uses it up. r2 is delivered and priced, but its
   * cost frame never arrives: the next 402 asks for everything served.
   */
  async function catchUpForUnpricedFrame(): Promise<void> {
    send('r1');
    deliver('r1', 100_000n);
    await claim('r1', 900_000n, 900_000n);
    // r1 counts at its price within the 1.4x tolerance; the rest fills the window.
    expect(verified()).toBe(140_000n);
    expect(signed()).toBe(140_000n + WINDOW);

    send('r2');
    deliver('r2', 100_000n);
    send('r3');
    await catchUp(140_000n + WINDOW + 100_000n, 'r3');
  }

  it('signs a catch-up for responses it received in full, counting them at its own prices', async () => {
    await openChannel();
    await catchUpForUnpricedFrame();
    expect(signed(), 'the honest catch-up was not signed in full').toBe(140_000n + WINDOW + 100_000n);
    // r2 counts at the buyer's own price for it, within the tolerance: nothing else was received.
    expect(verified()).toBe(140_000n + 140_000n);
  });

  it('counts each received response once: a later catch-up with nothing new signs nothing past the window', async () => {
    await openChannel();
    await catchUpForUnpricedFrame();
    manager.endPaidRequest(sellerPeerId, 'r3', true);
    const window = verified() + WINDOW;

    for (let round = 0; round < ROUNDS; round += 1) {
      const requestId = `answered-402-${round}`;
      send(requestId);
      await catchUp(signed() + WINDOW, requestId);
      manager.endPaidRequest(sellerPeerId, requestId, true);
      expect(signed(), `round ${round}: a received response reopened the window twice`).toBeLessThanOrEqual(window);
    }
    expect(signed()).toBe(window);
    expect(verified()).toBe(280_000n);
    // r2 was paid by the catch-up: the buyer's signing before a close does not pay it again.
    await signAtClose('r2', 100_000n);
    expect(signed()).toBe(window);
  });

  it('signs a catch-up for a received response priced above one window in a single step', async () => {
    const reserve = 5_000_000n;
    await openChannel(reserve);
    // One response delivered and priced at more than one window; its cost frame never arrives.
    send('large');
    deliver('large', 1_200_000n);
    // A seller prompt fills the window.
    await prompt(WINDOW);
    expect(signed()).toBe(WINDOW);
    expect(verified()).toBe(0n);

    // The seller's 402 asks for what it served. It counts no more than the
    // seller asks for, and no more than the buyer's own price within the tolerance.
    send('next');
    await catchUp(1_200_000n, 'next');
    manager.endPaidRequest(sellerPeerId, 'next', true);
    expect(signed(), 'the catch-up for the received response was not signed in full').toBe(1_200_000n);
    expect(verified()).toBe(1_200_000n);

    for (let round = 0; round < ROUNDS; round += 1) {
      const requestId = `answered-402-${round}`;
      send(requestId);
      await catchUp(signed() + WINDOW, requestId);
      manager.endPaidRequest(sellerPeerId, requestId, true);
      expect(signed(), `round ${round}: signed past verified cost plus one window`).toBeLessThanOrEqual(1_200_000n + WINDOW);
    }
    expect(signed()).toBe(1_200_000n + WINDOW);
    expect(verified()).toBe(1_200_000n);
    // The catch-up paid the response: the buyer's signing before a close does not pay it again.
    await signAtClose('large', 1_200_000n);
    expect(signed()).toBe(1_200_000n + WINDOW);
  });

  it('keeps a response recorded while a catch-up is being signed owed, and pays it once', async () => {
    const reserve = 5_000_000n;
    await openChannel(reserve);
    send('r1');
    deliver('r1', 100_000n);
    await prompt(WINDOW);
    expect(signed()).toBe(WINDOW);

    // The catch-up's signature waits while the response to another request arrives.
    const wallet = identity.wallet as Wallet;
    const signTypedData = wallet.signTypedData.bind(wallet);
    let arrive!: () => void;
    let open!: () => void;
    const arrived = new Promise<void>((resolve) => { arrive = resolve; });
    const opened = new Promise<void>((resolve) => { open = resolve; });
    vi.spyOn(wallet, 'signTypedData').mockImplementationOnce(async (...args) => {
      arrive();
      await opened;
      return signTypedData(...args);
    });

    send('r2');
    send('later');
    const catchingUp = catchUp(WINDOW + 100_000n, 'r2');
    await arrived;
    deliver('later', 50_000n);
    open();
    await catchingUp;
    manager.endPaidRequest(sellerPeerId, 'r2', true);
    // r1 counts at its price within the 1.4x tolerance.
    expect(signed()).toBe(WINDOW + 100_000n);
    expect(verified()).toBe(140_000n);

    // The later response's cost frame counts and is signed.
    await claim('later', 50_000n, WINDOW + 150_000n);
    expect(signed(), 'the response recorded during the catch-up was not paid').toBe(WINDOW + 150_000n);
    expect(verified()).toBe(190_000n);

    // Once: a repeated frame and the signing before a close pay it no more.
    await claim('later', 50_000n, WINDOW + 200_000n);
    expect(signed()).toBe(WINDOW + 150_000n);
    await signAtClose('later', 50_000n);
    expect(signed()).toBe(WINDOW + 150_000n);
    expect(verified()).toBe(190_000n);
  });

  it('allows one window per request in flight for catch-ups with nothing received, however many follow', async () => {
    const reserve = 5_000_000n;
    await openChannel(reserve);
    const inFlight = 3;
    const bound = 3n * WINDOW < reserve ? 3n * WINDOW : reserve;
    for (let i = 0; i < inFlight; i += 1) send(`in-flight-${i}`);

    for (let round = 0; round < ROUNDS; round += 1) {
      await catchUp(signed() + WINDOW, `in-flight-${round % inFlight}`, inFlight);
      expect(signed(), `round ${round}: signed past one window per request in flight`).toBeLessThanOrEqual(bound);
      expect(verified(), `round ${round}: verified a cost with nothing received`).toBe(0n);
    }
    expect(signed()).toBe(bound);
  });
});
