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
    // r2 counts at the buyer's own price for it: nothing else was received.
    expect(verified()).toBe(140_000n + 100_000n);
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
    expect(verified()).toBe(240_000n);
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

    // The seller's 402 asks for what it served. The catch-up counts the
    // received response whole, at the buyer's own price for it, and the buyer
    // signs the seller's target.
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
    // r1 counts at the buyer's own price for it.
    expect(signed()).toBe(WINDOW + 100_000n);
    expect(verified()).toBe(100_000n);

    // The later response's cost frame counts and is signed.
    await claim('later', 50_000n, WINDOW + 150_000n);
    expect(signed(), 'the response recorded during the catch-up was not paid').toBe(WINDOW + 150_000n);
    expect(verified()).toBe(150_000n);

    // Once: a repeated frame and the signing before a close pay it no more.
    await claim('later', 50_000n, WINDOW + 200_000n);
    expect(signed()).toBe(WINDOW + 150_000n);
    await signAtClose('later', 50_000n);
    expect(signed()).toBe(WINDOW + 150_000n);
    expect(verified()).toBe(150_000n);
  });

  it('keeps a response the catch-up target does not reach owed, and pays it in full on its own cost frame', async () => {
    const reserve = 5_000_000n;
    await openChannel(reserve);
    send('a');
    send('b');
    // a is delivered and priced; its cost frame never arrives. A seller prompt fills the window.
    deliver('a', 600_000n);
    await prompt(WINDOW);
    expect(signed()).toBe(WINDOW);
    expect(verified()).toBe(0n);

    // The seller's 402 asks for its spend when it answered: a only. b is
    // delivered and priced before the buyer handles it; b's cost frame is on its way.
    deliver('b', 2_000_000n);
    send('next');
    await catchUp(600_000n, 'next');
    manager.endPaidRequest(sellerPeerId, 'next', true);
    expect(signed()).toBe(600_000n);
    expect(verified()).toBe(600_000n);

    // b's cost frame counts at the seller's claim, within the buyer's price, and is signed in full.
    await claim('b', 2_000_000n, 2_600_000n);
    expect(signed(), 'the response past the catch-up target was not paid').toBe(2_600_000n);
    expect(verified()).toBe(2_600_000n);

    // Once: a repeated frame and the signing before a close pay nothing more.
    await claim('b', 2_000_000n, 2_650_000n);
    expect(signed()).toBe(2_600_000n);
    await signAtClose('b', 2_000_000n);
    await signAtClose('a', 600_000n);
    expect(signed()).toBe(2_600_000n);
    expect(verified()).toBe(2_600_000n);
  });

  it('counts received responses whole in ledger order, and later catch-ups sign one window past them at most', async () => {
    const reserve = 5_000_000n;
    await openChannel(reserve);
    send('a');
    send('b');
    // Both are delivered and priced; neither cost frame arrives. A seller prompt fills the window.
    deliver('a', 600_000n);
    deliver('b', 2_000_000n);
    await prompt(WINDOW);
    expect(signed()).toBe(WINDOW);

    // The seller prices both a little below the buyer. Its target is not
    // reached after a, so b counts too, each whole at the buyer's own price;
    // the buyer signs the seller's target.
    send('next');
    await catchUp(2_500_000n, 'next');
    manager.endPaidRequest(sellerPeerId, 'next', true);
    expect(verified()).toBe(2_600_000n);
    expect(signed()).toBe(2_500_000n);

    // Nothing more counts: catch-ups sign one window at most, and the signing before a close nothing.
    for (let round = 0; round < ROUNDS; round += 1) {
      const requestId = `answered-402-${round}`;
      send(requestId);
      await catchUp(signed() + WINDOW, requestId);
      manager.endPaidRequest(sellerPeerId, requestId, true);
      expect(signed(), `round ${round}: signed past verified cost plus one window`).toBeLessThanOrEqual(2_600_000n + WINDOW);
      expect(verified(), `round ${round}: verified past what a and b cost`).toBe(2_600_000n);
    }
    expect(signed()).toBe(2_600_000n + WINDOW);
    await signAtClose('a', 600_000n);
    await signAtClose('b', 2_000_000n);
    expect(signed()).toBe(2_600_000n + WINDOW);
    expect(verified()).toBe(2_600_000n);
  });

  it('counts every received response a catch-up for the seller\'s exact spend covers, and pays none again at close', async () => {
    const reserve = 5_000_000n;
    await openChannel(reserve);
    // The seller bills each response at exactly the buyer's price; every cost frame is lost.
    const responses: Array<[string, bigint]> = [['r1', 120_000n], ['r2', 250_000n], ['r3', 180_000n], ['r4', 300_000n]];
    for (const [id] of responses) send(id);
    for (const [id, cost] of responses) deliver(id, cost);
    const spend = responses.reduce((sum, [, cost]) => sum + cost, 0n);
    // The seller prompts for its spend; the window fills.
    await prompt(spend);
    expect(signed()).toBe(WINDOW);
    expect(verified()).toBe(0n);

    send('next');
    await catchUp(spend, 'next');
    manager.endPaidRequest(sellerPeerId, 'next', true);
    expect(verified()).toBe(spend);
    expect(signed()).toBe(spend);

    // Every response was counted: the signing before a close pays none of them again.
    for (const [id, cost] of responses) await signAtClose(id, cost);
    expect(signed()).toBe(spend);
    expect(verified()).toBe(spend);
  });

  it('counts a response larger than a catch-up asks for whole, and pays the rest of the spend on later catch-ups', async () => {
    const reserve = 5_000_000n;
    await openChannel(reserve);
    send('large');
    send('small');
    // Both are delivered and priced; neither cost frame arrives. A seller prompt fills the window.
    deliver('large', 2_000_000n);
    deliver('small', 600_000n);
    await prompt(2_600_000n);
    expect(signed()).toBe(WINDOW);
    expect(verified()).toBe(0n);

    // A 402 the seller sent before it served the rest asks for 600,000: the
    // first response counts whole, and the buyer signs the seller's target.
    send('next-1');
    await catchUp(600_000n, 'next-1');
    manager.endPaidRequest(sellerPeerId, 'next-1', true);
    expect(verified()).toBe(2_000_000n);
    expect(signed()).toBe(600_000n);

    // The window is open again: the next 402 signs up to it.
    send('next-2');
    await catchUp(2_600_000n, 'next-2');
    manager.endPaidRequest(sellerPeerId, 'next-2', true);
    expect(verified()).toBe(2_000_000n);
    expect(signed()).toBe(2_000_000n + WINDOW);

    // The one after counts the second response.
    send('next-3');
    await catchUp(2_600_000n, 'next-3');
    manager.endPaidRequest(sellerPeerId, 'next-3', true);
    expect(verified(), 'the second response was not paid').toBe(2_600_000n);
    expect(signed()).toBe(2_600_000n);

    // Nothing more counts: later catch-ups sign one window at most, and the signing before a close nothing.
    for (let round = 0; round < ROUNDS; round += 1) {
      const requestId = `answered-402-${round}`;
      send(requestId);
      await catchUp(signed() + WINDOW, requestId);
      manager.endPaidRequest(sellerPeerId, requestId, true);
      expect(signed(), `round ${round}: signed past verified cost plus one window`).toBeLessThanOrEqual(2_600_000n + WINDOW);
    }
    expect(signed()).toBe(2_600_000n + WINDOW);
    await signAtClose('large', 2_000_000n);
    await signAtClose('small', 600_000n);
    expect(signed()).toBe(2_600_000n + WINDOW);
    expect(verified()).toBe(2_600_000n);
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

  it('counts a response a catch-up reaches whole: its cost frames and the signing before a close pay nothing more for it', async () => {
    await openChannel(5_000_000n);
    send('large');
    send('small');
    // Both are delivered and priced; neither cost frame has arrived. A seller prompt fills the window.
    deliver('large', 2_000_000n);
    deliver('small', 600_000n);
    await prompt(WINDOW);

    // A 402 the seller sent before it served the rest asks for 600,000: it counts the first response whole.
    send('next');
    await catchUp(600_000n, 'next');
    manager.endPaidRequest(sellerPeerId, 'next', true);
    expect(verified()).toBe(2_000_000n);
    expect(signed()).toBe(600_000n);

    // The cost frames arrive, then the signing before a close: the second response is paid once, the first not again.
    await claim('small', 600_000n, 600_000n);
    await claim('large', 2_000_000n, 2_600_000n);
    await signAtClose('large', 2_000_000n);
    expect(signed(), 'signed past what the two responses cost').toBeLessThanOrEqual(2_600_000n);
    expect(signed()).toBe(2_600_000n);
    expect(verified()).toBe(2_600_000n);
  });

  it('counts only responses received before a catch-up: one received after it is paid once on its own cost frame', async () => {
    await openChannel(5_000_000n);
    send('r');
    send('q');
    deliver('r', 1_000_000n);
    await prompt(WINDOW);

    // The seller's 402 asks for r and q; only r was received, and it counts at the buyer's own price.
    send('next');
    await catchUp(1_400_000n, 'next');
    manager.endPaidRequest(sellerPeerId, 'next', true);
    expect(verified()).toBe(1_000_000n);
    expect(signed()).toBe(1_400_000n);

    // q arrives; its cost frame and the signing before a close pay it once.
    deliver('q', 400_000n);
    await claim('q', 400_000n, 1_400_000n);
    await signAtClose('q', 400_000n);
    expect(signed(), 'signed past what the two responses cost').toBeLessThanOrEqual(1_400_000n);
    expect(signed()).toBe(1_400_000n);
    expect(verified()).toBe(1_400_000n);
  });

  it('pays responses that catch-ups counted once, at the buyer\'s own price, when the signing before a close follows', async () => {
    await openChannel(5_000_000n);
    send('a');
    send('b');
    // Both are delivered and priced; neither cost frame arrives. A seller prompt fills the window.
    deliver('a', 600_000n);
    deliver('b', 2_000_000n);
    await prompt(WINDOW);

    // The seller prices both a little below the buyer and asks for 2,500,000 twice.
    send('n1');
    await catchUp(2_500_000n, 'n1');
    manager.endPaidRequest(sellerPeerId, 'n1', true);
    send('n2');
    await catchUp(2_500_000n, 'n2');
    manager.endPaidRequest(sellerPeerId, 'n2', true);
    expect(verified()).toBe(2_600_000n);
    expect(signed()).toBe(2_500_000n);

    await signAtClose('b', 2_000_000n);
    expect(signed(), 'signed past what the two responses cost').toBeLessThanOrEqual(2_600_000n);
    expect(signed()).toBe(2_600_000n);
    expect(verified()).toBe(2_600_000n);
  });

  it('pays an attempt the buyer cut off through its own cost frame, not through a catch-up', async () => {
    await openChannel(5_000_000n);
    // The caller cancelled the attempt: the buyer prices it at its prompt plus the output it allows.
    send('cut');
    manager.recordDeliveredResponse(sellerPeerId, 'cut', { costUsdc: 300_000n, cutOff: true });
    manager.endPaidRequest(sellerPeerId, 'cut');
    // A seller prompt fills the window.
    await prompt(WINDOW);
    expect(signed()).toBe(WINDOW);
    expect(verified()).toBe(0n);

    // The seller's 402 asks for the window plus the attempt: the catch-up does not count it.
    send('next');
    await catchUp(WINDOW + 300_000n, 'next');
    manager.endPaidRequest(sellerPeerId, 'next', true);
    expect(signed(), 'a catch-up counted the attempt that was cut off').toBe(WINDOW);
    expect(verified()).toBe(0n);

    // Its own cost frame counts it and is signed.
    await claim('cut', 300_000n, WINDOW + 300_000n);
    expect(signed()).toBe(WINDOW + 300_000n);
    expect(verified()).toBe(300_000n);
  });

  it('leaves a received response owed when a catch-up asks for no more than is signed, and pays it in full on its own cost frame', async () => {
    await openChannel(5_000_000n);
    // r is delivered and priced; its cost frame has not arrived. A seller prompt fills the window.
    send('r');
    deliver('r', 300_000n);
    await prompt(WINDOW);
    expect(signed()).toBe(WINDOW);
    expect(verified()).toBe(0n);

    // 402s asking for less than is signed, then for exactly that: nothing is signed or counted.
    for (const [round, target] of [[0, 400_000n], [1, WINDOW]] as const) {
      const requestId = `next-${round}`;
      send(requestId);
      await catchUp(target, requestId);
      manager.endPaidRequest(sellerPeerId, requestId, true);
      expect(signed(), `round ${round}: signed for a target already covered`).toBe(WINDOW);
      expect(verified(), `round ${round}: counted a response with nothing signed`).toBe(0n);
    }

    // r's cost frame counts in full and is signed.
    await claim('r', 300_000n, WINDOW + 300_000n);
    expect(signed(), 'the response was not paid on its cost frame').toBe(WINDOW + 300_000n);
    expect(verified()).toBe(300_000n);
  });

  it('counts only open responses in a catch-up, not one a cost frame counted already, and the signing before a close adds nothing for either', async () => {
    await openChannel(5_000_000n);
    // Three requests in flight: the seller's 402 is signed one window for each.
    for (const id of ['n1', 'n2', 'n3']) send(id);
    await catchUp(3n * WINDOW, 'n1', 3);
    for (const id of ['n1', 'n2', 'n3']) manager.endPaidRequest(sellerPeerId, id, true);
    expect(signed()).toBe(1_500_000n);
    expect(verified()).toBe(0n);

    // The first response's cost frame arrives while what is signed is past
    // verified cost plus one window: its cost counts, and nothing is signed.
    send('counted');
    deliver('counted', 400_000n);
    await claim('counted', 400_000n, 1_900_000n);
    expect(signed()).toBe(1_500_000n);
    expect(verified()).toBe(400_000n);

    // The second is delivered and priced; its cost frame does not arrive.
    send('open');
    deliver('open', 1_400_000n);

    // The seller's 402 asks for both: only the open one counts.
    send('next');
    await catchUp(1_800_000n, 'next');
    manager.endPaidRequest(sellerPeerId, 'next', true);
    expect(verified(), 'the catch-up counted a response twice').toBe(1_800_000n);
    expect(signed()).toBe(1_800_000n);

    // Both are counted: the signing before a close pays neither again.
    await signAtClose('open', 1_400_000n);
    await signAtClose('counted', 400_000n);
    expect(signed()).toBe(1_800_000n);
    expect(verified()).toBe(1_800_000n);
  });
});
