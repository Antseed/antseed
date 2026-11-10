import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { ChannelStore, CHANNEL_STATUS } from '../src/payments/channel-store.js';
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

/**
 * What the buyer signs when the seller's NeedAuth for a request is judged
 * against the response the buyer received for it. Each case drives the payment
 * manager the way the request handler does: a paid request is sent, then it
 * either fails or its response is delivered and priced by the buyer.
 */
describe('BuyerPaymentManager: a NeedAuth cost is owed only for a response the buyer received', () => {
  let tempDir: string;
  let store: ChannelStore;
  let manager: BuyerPaymentManager;
  let sent: SpendingAuthPayload[];
  let mux: PaymentMux;
  let sellerPeerId: string;
  let channelId: string;
  let chain: { available: bigint; locked: bigint };
  let makeManager: () => BuyerPaymentManager;

  const peerId = (name: string): string => Buffer.from(name).toString('hex').padEnd(40, '0').slice(0, 40);

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-needauth-delivered-'));
    store = new ChannelStore(tempDir);
    const privateKey = randomBytes(32);
    const wallet = new Wallet('0x' + bytesToHex(privateKey));
    const identity: Identity = { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
    makeManager = () => new BuyerPaymentManager(identity, {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: '0x' + 'cc'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: 31337,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: WINDOW,
      maxReserveAmountUsdc: RESERVE,
      dataDir: tempDir,
    }, store);
    manager = makeManager();
    sent = [];
    mux = { sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload); } } as unknown as PaymentMux;
    chain = { available: DEPOSIT, locked: 0n };
    wireChain(manager);

    sellerPeerId = peerId('seller-under-test');
    channelId = await openChannel();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** The manager reads the buyer's deposit and the channel's locked amount from `chain`. */
  function wireChain(target: BuyerPaymentManager): void {
    vi.spyOn(target, 'getBalance').mockImplementation(async () => ({ available: chain.available, reserved: chain.locked }));
    target.setChannelDepositReader(async () => chain.locked);
  }

  async function openChannel(): Promise<string> {
    const id = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, RESERVE, PRICING);
    chain = { available: chain.available - RESERVE, locked: RESERVE };
    await manager.handleAuthAck(sellerPeerId, { channelId: id });
    sent.length = 0;
    return id;
  }

  const signed = (): bigint => manager.getCumulativeAmount(sellerPeerId);

  // ── What the request handler tells the payment manager ──────────────────
  /** The request handler sends a paid request. */
  const send = (_requestId: string, seller = sellerPeerId): void => manager.beginPaidRequest(seller);
  /** The request ended without a response: a timeout, an abort, a dropped connection. */
  const fail = (requestId: string, seller = sellerPeerId): void => manager.endPaidRequest(seller, requestId);
  /** The buyer received the response and priced it at `cost` itself, from the usage in the response. */
  const deliver = (requestId: string, cost: bigint, seller = sellerPeerId): void => {
    manager.recordDeliveredResponse(seller, requestId, { costUsdc: cost });
    manager.endPaidRequest(seller, requestId);
  };

  // ── What the seller sends ────────────────────────────────────────────────
  /** One NeedAuth; any reserve top-up the buyer signs in reply lands on-chain. */
  async function sellerSends(frame: Partial<NeedAuthPayload>): Promise<void> {
    const before = sent.length;
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: manager.getReserveCeiling(sellerPeerId).toString(),
      currentAcceptedCumulative: '0',
      deposit: chain.locked.toString(),
      ...frame,
    }, mux);
    for (const auth of sent.slice(before)) {
      if (auth.reserveMaxAmount === undefined) continue;
      const newMax = BigInt(auth.reserveMaxAmount);
      chain = { available: chain.available - (newMax - chain.locked), locked: newMax };
    }
  }
  /** The seller's post-response frame: `cost` for `requestId`, asking for `required` in total. */
  const claim = (requestId: string, cost: bigint, required: bigint): Partial<NeedAuthPayload> => ({
    requestId, lastRequestCost: cost.toString(), inputTokens: cost.toString(), outputTokens: '0',
    requiredCumulativeAmount: required.toString(),
  });
  /** The seller's catch-up prompt: no cost, just "sign up to `required`". */
  const prompt = (required: bigint): Partial<NeedAuthPayload> => ({ requiredCumulativeAmount: required.toString() });
  /** The buyer's own signing before a cooperative close, for the last response it received. */
  const signAtClose = (requestId: string, cost: bigint) => manager.signPerRequestAuth(sellerPeerId, {
    requestId, sellerClaimedCost: cost, reportedInputTokens: cost, reportedOutputTokens: 0n,
    inputBytes: new Uint8Array(0), outputBytes: new Uint8Array(0),
  });

  it('gap 1: a request that got no response is never verified, on this channel or a later one', async () => {
    send('timed-out');
    fail('timed-out');
    // The buyer cut it off after sending it: the seller may have served it, so
    // its claim is answered like a prompt, inside the window, with nothing verified.
    await sellerSends(claim('timed-out', 900_000n, 900_000n));
    expect(manager.getVerifiedCost(sellerPeerId), 'verified a cost for a request that got no response').toBe(0n);
    expect(signed()).toBe(WINDOW);

    // The channel ends and the buyer opens another with the same seller.
    manager.retireSession(sellerPeerId, CHANNEL_STATUS.SETTLED);
    channelId = await openChannel();
    await sellerSends(claim('timed-out', 400_000n, 400_000n));
    expect(signed(), 'signed on a later channel for a request that got no response').toBe(0n);
  });

  /** Holds the next reserve top-up at its balance read, so NeedAuths can arrive while it is pending. */
  function holdNextTopUp(): { asked: ReturnType<typeof vi.spyOn>; release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(manager.getBalance).mockImplementationOnce(async () => {
      await held;
      return { available: chain.available, reserved: chain.locked };
    });
    return { asked: vi.spyOn(manager, 'topUpReserve'), release };
  }

  it('gap 2: a cost partly signed at the reserve ceiling is not paid again at close after a prompt signed the rest', async () => {
    const topUp = holdNextTopUp();
    send('r1');
    deliver('r1', 700_000n);
    const first = sellerSends(claim('r1', 700_000n, 700_000n));
    await vi.waitFor(() => expect(topUp.asked).toHaveBeenCalledTimes(1));
    expect(signed()).toBe(700_000n);

    // r2 costs 500k: 300k fits under the ceiling while the top-up is pending.
    send('r2');
    deliver('r2', 500_000n);
    const second = sellerSends(claim('r2', 500_000n, 1_200_000n));
    await vi.waitFor(() => expect(topUp.asked).toHaveBeenCalledTimes(2));
    expect(signed()).toBe(RESERVE);
    topUp.release();
    await Promise.all([first, second]);
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(2n * RESERVE);

    // The top-up landed; the seller prompts for what it served, then the buyer closes.
    await sellerSends(prompt(1_200_000n));
    expect(signed()).toBe(1_200_000n);
    await signAtClose('r2', 500_000n);
    expect(signed(), 'the remainder of r2 was paid twice').toBe(1_200_000n);
  });

  it('gap 3: a cost counted while a top-up was pending is signed by the buyer at close, without a seller prompt', async () => {
    const topUp = holdNextTopUp();
    // r1 uses the whole reserve; the buyer signs it and starts a top-up.
    send('r1');
    deliver('r1', RESERVE);
    const first = sellerSends(claim('r1', RESERVE, RESERVE));
    await vi.waitFor(() => expect(topUp.asked).toHaveBeenCalledTimes(1));
    // r2's cost arrives before the top-up is signed: nothing more fits under the ceiling.
    send('r2');
    deliver('r2', 300_000n);
    const second = sellerSends(claim('r2', 300_000n, 1_300_000n));
    await vi.waitFor(() => expect(topUp.asked).toHaveBeenCalledTimes(2));
    expect(signed()).toBe(RESERVE);
    topUp.release();
    await Promise.all([first, second]);
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(2n * RESERVE);

    await signAtClose('r2', 300_000n);
    expect(signed(), 'the close would be refused as pending').toBe(1_300_000n);
    // r2 is in the usage the close signs, though its cost was counted before.
    const meta = (manager as unknown as { _metadata: Map<string, { cumulativeRequestCount: bigint; cumulativeInputTokens: bigint }> })._metadata.get(sellerPeerId)!;
    expect(meta.cumulativeRequestCount, 'r2 is missing from the signed usage').toBe(2n);
    expect(meta.cumulativeInputTokens).toBe(RESERVE + 300_000n);
  });

  it('gap 4: a long-running request stays chargeable however many other requests the buyer sends meanwhile', async () => {
    send('long-running');
    for (let i = 0; i < 3_000; i += 1) {
      const other = peerId(`other-seller-${i % 7}`);
      send(`other-${i}`, other);
      deliver(`other-${i}`, 1_000n, other);
    }
    deliver('long-running', 200_000n);
    await sellerSends(claim('long-running', 200_000n, 200_000n));
    expect(signed(), 'the honest seller was refused').toBe(200_000n);
  });

  it('gap 5: a claim above what the buyer priced the delivered response at counts only up to that price', async () => {
    send('served');
    deliver('served', 10_000n);
    // The token counts are the seller's own, so they always price to the claimed cost.
    await sellerSends(claim('served', 900_000n, 900_000n));
    // What the response shows, within the 1.4x cost tolerance, is verified ...
    expect(manager.getVerifiedCost(sellerPeerId), 'verified a cost the response does not show').toBe(14_000n);
    // ... and the rest is signed only as far as the overdraft window reaches.
    expect(signed()).toBe(14_000n + WINDOW);

    // Nothing more: the response is counted, and no NeedAuth reopens the window.
    await sellerSends(claim('served', 900_000n, 900_000n));
    await sellerSends(prompt(900_000n));
    expect(signed()).toBe(14_000n + WINDOW);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(14_000n);
    expect(manager.getReserveCeiling(sellerPeerId), 'a top-up was signed').toBe(RESERVE);
  });

  it('signs an honest claim for exactly what it asks', async () => {
    send('served');
    deliver('served', 10_000n);
    await sellerSends(claim('served', 10_000n, 10_000n));
    expect(signed()).toBe(10_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(10_000n);
  });

  it('a response a catch-up prompt already signed for is not paid again at close', async () => {
    send('r1');
    deliver('r1', 100_000n);
    // The seller's cost frame is lost; its prompt before the next request is signed inside the window.
    await sellerSends(prompt(100_000n));
    expect(signed()).toBe(100_000n);
    await signAtClose('r1', 100_000n);
    expect(signed(), 'r1 was paid twice').toBe(100_000n);
  });

  it('charges one delivered response once, and the same request again only if it is delivered again', async () => {
    send('r1');
    deliver('r1', 100_000n);
    await sellerSends(claim('r1', 100_000n, 100_000n));
    expect(signed()).toBe(100_000n);
    await sellerSends(claim('r1', 100_000n, 200_000n));
    expect(signed(), 'signed twice for one response').toBe(100_000n);

    // The buyer retries the request and the retry gets no response: nothing more is verified.
    send('r1');
    fail('r1');
    await sellerSends(claim('r1', 100_000n, 200_000n));
    expect(manager.getVerifiedCost(sellerPeerId), 'verified a retry that got no response').toBe(100_000n);
    expect(signed()).toBeLessThanOrEqual(100_000n + WINDOW);
  });

  it('refuses a claim that arrives before the response it is for, without waiting, and pays that response once at close', async () => {
    // The request path records a response before the seller's frame for it can be judged
    // (see the real-stack probe that delivers both in one chunk). A claim ahead of its
    // response is therefore not an honest seller's: it is refused at once.
    send('early');
    await sellerSends(claim('early', 50_000n, 50_000n));
    expect(signed()).toBe(0n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);

    // The response then arrives. The buyer's own signing before a close pays it, once.
    deliver('early', 50_000n);
    await signAtClose('early', 50_000n);
    expect(signed()).toBe(50_000n);
    await sellerSends(claim('early', 50_000n, 100_000n));
    expect(signed()).toBe(50_000n);

    // A claim for a request that then fails verifies nothing.
    send('aborted');
    await sellerSends(claim('aborted', 50_000n, 100_000n));
    fail('aborted');
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(50_000n);
  });
  // ── Further cases: what else must hold for the rule above ────────────────

  it('a response is chargeable only on the channel it arrived on', async () => {
    send('r1');
    deliver('r1', 100_000n);
    manager.retireSession(sellerPeerId, CHANNEL_STATUS.SETTLED);
    channelId = await openChannel();
    await sellerSends(claim('r1', 100_000n, 100_000n));
    expect(signed(), 'charged on a later channel for a response from an earlier one').toBe(0n);

    // The buyer's own signing on the new channel does not count it either.
    send('r2');
    deliver('r2', 50_000n);
    await signAtClose('r2', 50_000n);
    expect(signed(), 'the earlier channel\'s response was paid on this one').toBe(50_000n);
  });

  it('a seller cannot charge for a response another seller delivered under the same request ID', async () => {
    const other = peerId('other-seller');
    send('shared-id', other);
    deliver('shared-id', 100_000n, other);
    await sellerSends(claim('shared-id', 100_000n, 100_000n));
    expect(signed()).toBe(0n);
  });

  it('signs a claim below what the buyer priced, and nothing more for that response at close', async () => {
    send('r1');
    deliver('r1', 100_000n);
    await sellerSends(claim('r1', 60_000n, 60_000n));
    expect(signed()).toBe(60_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(60_000n);
    await signAtClose('r1', 100_000n);
    expect(signed(), 'paid more than the seller asked for').toBe(60_000n);
  });

  it('counts a claim in full up to the cost tolerance, and no further', async () => {
    send('at-limit');
    deliver('at-limit', 10_000n);
    await sellerSends(claim('at-limit', 14_000n, 14_000n));
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(14_000n);

    send('over-limit');
    deliver('over-limit', 10_000n);
    await sellerSends(claim('over-limit', 14_001n, 28_001n));
    expect(manager.getVerifiedCost(sellerPeerId), 'verified past the tolerance').toBe(28_000n);
    // Signed as asked: it is inside the overdraft window.
    expect(signed()).toBe(28_001n);
  });

  it('after a buyer restart, refuses a claim for a response from before it, and still signs the seller\'s prompt for it', async () => {
    send('before-restart');
    deliver('before-restart', 100_000n);

    manager = makeManager();
    wireChain(manager);
    await sellerSends(claim('before-restart', 100_000n, 100_000n));
    expect(signed(), 'a claim for a response the restarted buyer never saw').toBe(0n);
    await sellerSends(prompt(100_000n));
    expect(signed(), 'the honest seller was not paid after the restart').toBe(100_000n);
  });

  it('owes nothing for a response both sides price at zero, and a zero-cost frame does not use up a priced response', async () => {
    const zero = (requestId: string): Partial<NeedAuthPayload> => ({ ...claim(requestId, 0n, 0n), lastRequestCost: '0', inputTokens: '0' });
    send('free-answer');
    deliver('free-answer', 0n);
    await sellerSends(zero('free-answer'));
    await sellerSends(claim('free-answer', 100_000n, 100_000n));
    expect(manager.getVerifiedCost(sellerPeerId), 'verified a cost for a free answer').toBe(0n);
    expect(signed()).toBe(0n);

    // A zero-cost frame for a response the buyer priced above zero (an earlier
    // attempt's frame, after a retry kept the ID) leaves that response chargeable.
    send('priced');
    deliver('priced', 100_000n);
    await sellerSends(zero('priced'));
    await sellerSends(claim('priced', 100_000n, 100_000n));
    expect(signed()).toBe(100_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(100_000n);
  });

  it('a 402 retry that reopens the window takes the responses before it as paid, at close too', async () => {
    send('r1');
    deliver('r1', 10_000n);
    // An over-claim uses up the window: verified 14k, signed 14k + the window.
    await sellerSends(claim('r1', 900_000n, 900_000n));
    expect(signed()).toBe(14_000n + WINDOW);
    send('r2');
    deliver('r2', 50_000n);
    // r2's cost frame is lost. The next request gets a 402 for everything the seller served; the buyer reopens the window.
    await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux, 14_000n + WINDOW + 50_000n);
    const afterReopen = signed();
    expect(afterReopen).toBe(14_000n + WINDOW + 50_000n);

    await sellerSends(claim('r2', 50_000n, afterReopen + 50_000n));
    expect(signed(), 'r2 charged again after the 402 paid it').toBe(afterReopen);
    await signAtClose('r2', 50_000n);
    expect(signed(), 'r2 paid again at close after the 402 paid it').toBe(afterReopen);
  });

  it('signs at close for every response whose cost frame never arrived, once each', async () => {
    for (const [requestId, cost] of [['r1', 100_000n], ['r2', 200_000n], ['r3', 50_000n]] as const) {
      send(requestId);
      deliver(requestId, cost);
    }
    await signAtClose('r3', 50_000n);
    expect(signed()).toBe(350_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(350_000n);
    for (const requestId of ['r1', 'r2', 'r3']) await sellerSends(claim(requestId, 100_000n, 450_000n));
    expect(signed(), 'a response paid at close was charged again').toBe(350_000n);
    await signAtClose('r3', 50_000n);
    expect(signed(), 'close signed twice').toBe(350_000n);
  });

  it('keeps at most 512 uncounted responses per seller, dropping the oldest', async () => {
    for (let i = 0; i < 1_100; i += 1) {
      send(`r${i}`);
      deliver(`r${i}`, 1n);
    }
    await sellerSends(claim('r0', 1n, 1n));
    expect(signed(), 'the oldest response is still held').toBe(0n);
    await sellerSends(claim('r1099', 1n, 1n));
    expect(signed()).toBe(1n);
  });

  it('does not pay a counted response again at close however many requests other sellers are charged for meanwhile', async () => {
    send('r1');
    deliver('r1', 100_000n);
    await sellerSends(claim('r1', 100_000n, 100_000n));
    expect(signed()).toBe(100_000n);

    // Another seller's channel is busy until this seller's channel closes.
    const other = peerId('busy-other-seller');
    const otherChannel = await manager.authorizeSpending(other, mux, 10_000n, RESERVE, PRICING);
    await manager.handleAuthAck(other, { channelId: otherChannel });
    for (let i = 0; i < 600; i += 1) {
      send(`other-${i}`, other);
      deliver(`other-${i}`, 1n, other);
      await manager.handleNeedAuth(other, {
        channelId: otherChannel, requestId: `other-${i}`, lastRequestCost: '1', inputTokens: '1', outputTokens: '0',
        requiredCumulativeAmount: String(i + 1), currentAcceptedCumulative: '0', deposit: RESERVE.toString(),
      }, mux);
    }
    expect(manager.getCumulativeAmount(other)).toBe(600n);

    await signAtClose('r1', 100_000n);
    expect(signed(), 'r1 paid again at close').toBe(100_000n);
  });

  it('counts concurrent claims for two delivered responses once each', async () => {
    send('a');
    deliver('a', 40_000n);
    send('b');
    deliver('b', 60_000n);
    await Promise.all([
      sellerSends(claim('a', 40_000n, 40_000n)),
      sellerSends(claim('b', 60_000n, 100_000n)),
    ]);
    expect(signed()).toBe(100_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(100_000n);
  });
});
