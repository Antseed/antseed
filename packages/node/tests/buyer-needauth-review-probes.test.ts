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

/**
 * Review probes for the "NeedAuth cost is owed only for a delivered response"
 * change. Property tests drive the payment manager the way the request
 * handler, the negotiator and a seller do, over many random interleavings.
 * Cases the review reported as findings now assert the fixed behaviour;
 * "what stays" reports what the design leaves to the overdraft window.
 */

const WINDOW = 500_000n;
const DEPOSIT = 1_000_000_000n;
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };

/** mulberry32: a small seeded PRNG, so a failing sequence can be replayed by its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('review probes: buyer NeedAuth accounting', () => {
  let tempDir: string;
  let store: ChannelStore;
  let manager: BuyerPaymentManager;
  let sent: SpendingAuthPayload[];
  let mux: PaymentMux;
  let sellerPeerId: string;
  let channelId: string;
  let chain: { available: bigint; locked: bigint };
  let makeManager: () => BuyerPaymentManager;
  let reserve: bigint;

  const peerId = (name: string): string => Buffer.from(name).toString('hex').padEnd(40, '0').slice(0, 40);

  async function boot(reserveStep: bigint): Promise<void> {
    reserve = reserveStep;
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-needauth-probes-'));
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
      maxReserveAmountUsdc: reserveStep,
      dataDir: tempDir,
    }, store);
    manager = makeManager();
    sent = [];
    mux = { sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload); } } as unknown as PaymentMux;
    chain = { available: DEPOSIT, locked: 0n };
    wireChain(manager);
    sellerPeerId = peerId('seller-under-test');
    channelId = await openChannel();
  }

  function shutdown(): void {
    vi.restoreAllMocks();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  beforeEach(async () => { await boot(1_000_000n); });
  afterEach(() => { vi.useRealTimers(); shutdown(); });

  function wireChain(target: BuyerPaymentManager): void {
    vi.spyOn(target, 'getBalance').mockImplementation(async () => ({ available: chain.available, reserved: chain.locked }));
    target.setChannelDepositReader(async () => chain.locked);
  }

  async function openChannel(): Promise<string> {
    const id = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, reserve, PRICING);
    chain = { available: chain.available - reserve, locked: reserve };
    await manager.handleAuthAck(sellerPeerId, { channelId: id });
    sent.length = 0;
    return id;
  }

  const signed = (): bigint => manager.getCumulativeAmount(sellerPeerId);
  const verified = (): bigint => manager.getVerifiedCost(sellerPeerId);

  const send = (_requestId: string): void => manager.beginPaidRequest(sellerPeerId);
  const fail = (requestId: string): void => manager.endPaidRequest(sellerPeerId, requestId);
  const deliver = (requestId: string, cost: bigint): void => {
    manager.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc: cost });
    manager.endPaidRequest(sellerPeerId, requestId);
  };

  /** Any reserve top-up the buyer signed since `from` lands on-chain. */
  function landTopUps(from: number): void {
    for (const auth of sent.slice(from)) {
      if (auth.reserveMaxAmount === undefined) continue;
      const newMax = BigInt(auth.reserveMaxAmount);
      if (newMax > chain.locked) chain = { available: chain.available - (newMax - chain.locked), locked: newMax };
    }
  }

  async function sellerSends(frame: Partial<NeedAuthPayload>): Promise<void> {
    const before = sent.length;
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: manager.getReserveCeiling(sellerPeerId).toString(),
      currentAcceptedCumulative: '0',
      deposit: chain.locked.toString(),
      ...frame,
    }, mux);
    landTopUps(before);
  }
  const claim = (requestId: string, cost: bigint, required: bigint): Partial<NeedAuthPayload> => ({
    requestId, lastRequestCost: cost.toString(), inputTokens: cost.toString(), outputTokens: '0',
    requiredCumulativeAmount: required.toString(),
  });
  const prompt = (required: bigint): Partial<NeedAuthPayload> => ({ requiredCumulativeAmount: required.toString() });

  /** The negotiator's own signing for the last priced response: sendPostResponseAuthTo, which production runs from a close request (the seller may still decline the close). */
  async function buyerSigns(requestId: string, cost: bigint): Promise<void> {
    const before = sent.length;
    const { topUpNeeded } = await manager.signPerRequestAuth(sellerPeerId, {
      requestId, sellerClaimedCost: cost, reportedInputTokens: cost, reportedOutputTokens: 0n,
      inputBytes: new Uint8Array(0), outputBytes: new Uint8Array(0),
    });
    if (topUpNeeded) await manager.topUpReserve(sellerPeerId, mux);
    landTopUps(before);
  }

  /** The buyer's 402 retry. */
  async function buyerExtends(target: bigint, inFlight = 1): Promise<void> {
    const before = sent.length;
    await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux, target, undefined, inFlight);
    landTopUps(before);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Property: an honest seller, any interleaving
  // ───────────────────────────────────────────────────────────────────────

  interface HonestRun { spent: bigint; slack: bigint; stalls: number; failedRequests: number; closeStuck: boolean; log: string[] }

  /**
   * One random session with an honest seller (it bills exactly what the buyer
   * prices, asks for exactly its spend, and prompts/402s like
   * seller-request-handler.ts). Cost frames may be lost. The buyer's own
   * signing (signPerRequestAuth) runs in production only from a close request
   * (negotiator.sendPostResponseAuthTo); with `midSessionSigning` it also runs
   * at random points before a request, as a close the seller declines as busy
   * does. With `aborts`, some requests end on the buyer without a response
   * while the seller still serves and bills them.
   */
  async function honestSession(seed: number, options: { aborts: boolean; lossRate: number; steps: number; midSessionSigning?: boolean }): Promise<HonestRun> {
    const random = prng(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
    const log: string[] = [];
    let spent = 0n;
    let prompted = 0n;
    let stalls = 0;
    let failedRequests = 0;
    let counter = 0;
    // A 402 retry signs at least minBudgetPerRequest (10,000) past what is signed, even past the seller's target.
    let slack = 0n;
    let last: { id: string; cost: bigint } | null = null;
    const inFlight: Array<{ id: string; cost: bigint }> = [];
    const wire: Array<Partial<NeedAuthPayload>> = [];
    const flush = async (): Promise<void> => {
      for (const frame of wire.splice(0)) await sellerSends(frame);
    };

    const start = async (): Promise<void> => {
      const id = `r${counter += 1}`;
      // A close request the seller declined: the buyer has signed for its last response.
      if (last && options.midSessionSigning && random() < 0.4) {
        const { id: lastId, cost } = last;
        last = null;
        log.push(`close-sign ${lastId}`);
        await buyerSigns(lastId, cost);
      }
      // seller-request-handler: frames sent earlier have arrived by the time it prompts.
      for (let attempt = 0; ; attempt += 1) {
        if (spent <= signed()) break;
        await flush();
        if (spent > signed() && spent > prompted) {
          prompted = spent;
          log.push(`prompt ${spent}`);
          await sellerSends(prompt(spent));
        }
        if (spent <= signed()) break;
        // Parked 5 s, then a 402.
        stalls += 1;
        log.push(`402 spent=${spent} signed=${signed()}`);
        if (attempt >= 2) { failedRequests += 1; return; }
        slack += 10_000n;
        await buyerExtends(spent, inFlight.length + 1);
      }
      send(id);
      inFlight.push({ id, cost: BigInt(1_000 + Math.floor(random() * 200_000)) });
      log.push(`start ${id}`);
    };

    const finish = (aborted: boolean): void => {
      const index = Math.floor(random() * inFlight.length);
      const [request] = inFlight.splice(index, 1);
      if (!request) return;
      spent += request.cost;
      if (aborted) {
        fail(request.id);
        log.push(`abort ${request.id} cost=${request.cost}`);
      } else {
        deliver(request.id, request.cost);
        last = request;
        log.push(`deliver ${request.id} cost=${request.cost}`);
      }
      if (random() >= options.lossRate) wire.push(claim(request.id, request.cost, spent));
      else log.push(`lost claim ${request.id}`);
    };

    for (let step = 0; step < options.steps; step += 1) {
      const action = pick(['start', 'start', 'finish', 'finish', 'flush', options.aborts ? 'abort' : 'finish']);
      if (action === 'start' && inFlight.length < 4) await start();
      else if (action === 'finish' && inFlight.length > 0) finish(false);
      else if (action === 'abort' && inFlight.length > 0) finish(true);
      else if (action === 'flush') { log.push('flush'); await flush(); }
      expect(signed(), `seed ${seed}: signed past the seller's spend\n${log.join('\n')}`).toBeLessThanOrEqual(spent + slack);
    }
    while (inFlight.length > 0) finish(false);

    // Cooperative close: drain, the buyer signs for its last response, and the
    // seller answers pending_auth with a catch-up prompt while it is owed more.
    await flush();
    if (last) await buyerSigns((last as { id: string }).id, (last as { cost: bigint }).cost);
    let closeStuck = false;
    for (let attempt = 0; spent > signed(); attempt += 1) {
      if (attempt >= 3) { closeStuck = true; break; }
      log.push(`close: pending_auth spent=${spent} signed=${signed()}`);
      await sellerSends(prompt(spent));
    }
    expect(signed(), `seed ${seed}: signed past the seller's spend at close\n${log.join('\n')}`).toBeLessThanOrEqual(spent + slack);
    return { spent, slack, stalls, failedRequests, closeStuck, log };
  }

  it('honest seller, every response received: paid exactly its spend, never parked, close goes through (300 random sessions)', async () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      shutdown();
      await boot(1_000_000_000n);
      const run = await honestSession(seed, { aborts: false, lossRate: 0, steps: 60, midSessionSigning: seed % 2 === 0 });
      expect(signed(), `seed ${seed}: paid ${signed()} for ${run.spent}\n${run.log.join('\n')}`).toBe(run.spent);
      expect(run.stalls, `seed ${seed}: honest seller parked a request\n${run.log.join('\n')}`).toBe(0);
      expect(run.closeStuck).toBe(false);
    }
  }, 120_000);

  it('honest seller with lost cost frames: still paid exactly its spend at close (300 random sessions)', async () => {
    let stalls = 0;
    let sessionsWithStall = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      shutdown();
      await boot(1_000_000_000n);
      const run = await honestSession(1_000 + seed, { aborts: false, lossRate: 0.4, steps: 60, midSessionSigning: seed % 2 === 0 });
      // Each 402 retry may sign up to 10,000 (minBudgetPerRequest) past the seller's spend, as on main.
      expect(signed() >= run.spent, `seed ${seed}: underpaid ${signed()} for ${run.spent}\n${run.log.join('\n')}`).toBe(true);
      expect(signed() <= run.spent + run.slack, `seed ${seed}: overpaid ${signed()} for ${run.spent}\n${run.log.join('\n')}`).toBe(true);
      expect(run.closeStuck).toBe(false);
      stalls += run.stalls;
      if (run.stalls > 0) sessionsWithStall += 1;
    }
    // Reported, not asserted: a lost cost frame leaves its response uncounted until a close, so the window shrinks by its cost.
    console.log(`[probe] sessions with 40% lost cost frames: ${sessionsWithStall}/300 sessions parked at least one request (${stalls} parks)`);
  }, 120_000);

  it('honest seller with a small reserve and top-ups: paid exactly its spend (200 random sessions)', async () => {
    let stalls = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      shutdown();
      await boot(1_000_000n);
      const run = await honestSession(2_000 + seed, { aborts: false, lossRate: 0, steps: 60, midSessionSigning: seed % 2 === 0 });
      expect(signed() >= run.spent, `seed ${seed}: underpaid ${signed()} for ${run.spent}\n${run.log.join('\n')}`).toBe(true);
      expect(signed() <= run.spent + run.slack, `seed ${seed}: overpaid ${signed()} for ${run.spent}\n${run.log.join('\n')}`).toBe(true);
      expect(run.closeStuck, `seed ${seed}\n${run.log.join('\n')}`).toBe(false);
      stalls += run.stalls;
    }
    // Reported, not asserted: a top-up that has not landed can park a request on main too.
    console.log(`[probe] small-reserve sessions: ${stalls} parked requests over 200 sessions`);
  }, 120_000);

  it('what stays: requests cut off with nothing the buyer can price (no output limit, no bytes) are verified by nothing, so their cost uses the overdraft window', async () => {
    let stalls = 0;
    let failed = 0;
    let stuck = 0;
    let sessionsWithStall = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      shutdown();
      await boot(1_000_000_000n);
      const run = await honestSession(3_000 + seed, { aborts: true, lossRate: 0, steps: 60 });
      stalls += run.stalls;
      failed += run.failedRequests;
      if (run.stalls > 0) sessionsWithStall += 1;
      if (run.closeStuck) stuck += 1;
    }
    console.log(`[probe] sessions with aborted requests: ${sessionsWithStall}/200 sessions parked at least one request; ${stalls} parks (5 s + 402 each), ${failed} requests failed catch_up_incomplete, ${stuck} closes stuck on pending_auth`);
    expect(sessionsWithStall).toBeGreaterThan(0);
  }, 120_000);

  // ───────────────────────────────────────────────────────────────────────
  // Property: an adversarial seller
  // ───────────────────────────────────────────────────────────────────────

  it('adversarial seller: never signed past 1.4x what was delivered plus one window per (1 + restarts) (400 random sessions)', async () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      shutdown();
      // Every other session runs on a small reserve, so claims reach the ceiling and top-ups are signed.
      await boot(seed % 2 === 0 ? 1_000_000n : 1_000_000_000n);
      const random = prng(50_000 + seed);
      const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
      const log: string[] = [];
      const ids: string[] = ['never-sent'];
      const inFlight: string[] = [];
      const costs = new Map<string, bigint>();
      let deliveredTotal = 0n;
      /** Responses delivered, each counted at most once and rounded up by at most one base unit. */
      let deliveries = 0n;
      let windows = 1n;
      let counter = 0;
      let last: { id: string; cost: bigint } | null = null;
      const amount = (): bigint => BigInt(Math.floor(random() * 2_000_000));

      for (let step = 0; step < 80; step += 1) {
        const action = pick(['start', 'deliver', 'fail', 'claim', 'claim', 'prompt', 'zero', 'presign', 'extend', 'covered', 'restart', 'redeliver']);
        if (action === 'start' && inFlight.length < 3) {
          const id = `r${counter += 1}`;
          ids.push(id);
          inFlight.push(id);
          send(id);
          log.push(`start ${id}`);
        } else if (action === 'deliver' && inFlight.length > 0) {
          const id = inFlight.splice(Math.floor(random() * inFlight.length), 1)[0]!;
          const cost = BigInt(1_000 + Math.floor(random() * 100_000));
          costs.set(id, cost);
          deliveredTotal += cost;
          deliveries += 1n;
          deliver(id, cost);
          last = { id, cost };
          log.push(`deliver ${id} ${cost}`);
        } else if (action === 'redeliver' && costs.size > 0 && inFlight.length === 0) {
          // A retry that keeps its ID and is answered again: a second response to pay for.
          const id = pick([...costs.keys()]);
          const cost = costs.get(id)!;
          send(id);
          deliveredTotal += cost;
          deliveries += 1n;
          deliver(id, cost);
          last = { id, cost };
          log.push(`redeliver ${id} ${cost}`);
        } else if (action === 'fail' && inFlight.length > 0) {
          const id = inFlight.splice(Math.floor(random() * inFlight.length), 1)[0]!;
          fail(id);
          log.push(`fail ${id}`);
        } else if (action === 'claim') {
          // Never a request in flight: that one waits 5 s for the response path.
          const id = pick(ids.filter((candidate) => !inFlight.includes(candidate)));
          const cost = amount();
          const required = signed() + amount();
          log.push(`claim ${id} cost=${cost} required=${required}`);
          await sellerSends(claim(id, cost, required));
        } else if (action === 'prompt') {
          const required = signed() + amount();
          log.push(`prompt ${required}`);
          await sellerSends(prompt(required));
        } else if (action === 'zero') {
          const id = pick(ids.filter((candidate) => !inFlight.includes(candidate)));
          const required = random() < 0.5 ? signed() : signed() + amount();
          log.push(`zero-cost ${id} required=${required}`);
          await sellerSends({ ...claim(id, 0n, required), lastRequestCost: '0', inputTokens: '0' });
        } else if (action === 'presign' && last) {
          log.push(`close-sign ${last.id}`);
          await buyerSigns(last.id, last.cost);
          last = null;
        } else if (action === 'extend') {
          const target = signed() + amount();
          log.push(`402 extend target=${target}`);
          await buyerExtends(target);
        } else if (action === 'covered' && inFlight.length > 0) {
          const id = pick(inFlight);
          manager.markRequestCovered(sellerPeerId, id);
          log.push(`covered ${id}`);
        } else if (action === 'restart' && inFlight.length === 0) {
          manager = makeManager();
          wireChain(manager);
          last = null;
          windows += 1n;
          log.push('restart');
        }
        const bound = (deliveredTotal * 14n + 9n) / 10n + deliveries + windows * WINDOW;
        expect(signed(), `seed ${seed}: signed ${signed()} > bound ${bound} (delivered ${deliveredTotal}, windows ${windows})\n${log.join('\n')}`)
          .toBeLessThanOrEqual(bound);
        expect(signed(), `seed ${seed}: signed past verified + window\n${log.join('\n')}`).toBeLessThanOrEqual(verified() + WINDOW);
      }
    }
  }, 180_000);

  // ───────────────────────────────────────────────────────────────────────
  // Targeted cases
  // ───────────────────────────────────────────────────────────────────────

  it('402 reopen, then NeedAuth for the retried request, then close: each response paid once', async () => {
    send('r1');
    deliver('r1', 100_000n);
    // The seller only prompts: the window is used up without r1 being counted.
    await sellerSends(prompt(100_000n + WINDOW));
    expect(signed()).toBe(WINDOW);
    // Its 402 for the next request reopens the window; r1 is taken as paid.
    await buyerExtends(WINDOW + 50_000n);
    expect(signed()).toBe(WINDOW + 50_000n);
    send('r2');
    deliver('r2', 70_000n);
    await sellerSends(claim('r2', 70_000n, WINDOW + 120_000n));
    expect(signed()).toBe(WINDOW + 120_000n);
    await buyerSigns('r2', 70_000n);
    expect(signed(), 'close signed again').toBe(WINDOW + 120_000n);
    await sellerSends(claim('r1', 100_000n, WINDOW + 500_000n));
    expect(signed(), 'r1 charged after the reopen paid it').toBe(WINDOW + 120_000n);
  });

  it('countWithoutSigning, then a seller prompt, then close: the counted cost is signed once', async () => {
    // Use the whole window with an unverifiable prompt, so the next cost cannot be signed.
    await sellerSends(prompt(WINDOW));
    expect(signed()).toBe(WINDOW);
    send('r1');
    deliver('r1', 200_000n);
    await sellerSends(claim('r1', 200_000n, WINDOW + 200_000n));
    // verified 200k -> maxSignable 700k: the claim is signed.
    expect(signed()).toBe(WINDOW + 200_000n);
    await buyerSigns('r1', 200_000n);
    expect(signed()).toBe(WINDOW + 200_000n);
    await sellerSends(prompt(2_000_000n));
    // Owed = signed already; a prompt gets only what the window still allows (verified 200k + 500k).
    expect(signed()).toBe(200_000n + WINDOW);
  });

  it('the buyer\'s own signing does not pay, on a new channel, for a response delivered on the channel before it', async () => {
    send('r1');
    deliver('r1', 100_000n);
    // The seller is paid for r1 on the old channel through a prompt, then the channel ends.
    await sellerSends(prompt(100_000n));
    expect(signed()).toBe(100_000n);
    manager.retireSession(sellerPeerId, CHANNEL_STATUS.SETTLED, 100_000n);
    channelId = await openChannel();
    // The negotiator still holds r1 as its last response cost (retire paths that
    // skip _forgetSellerSession) and signs for it when it next asks the seller to close.
    await buyerSigns('r1', 100_000n);
    expect(signed(), 'paid on the new channel for a response from the old one').toBe(0n);
  });

  it('pays nothing for an error answer with a usage block, by NeedAuth or by the buyer\'s own signing', async () => {
    // estimateCostFromResponse skips recordDeliveredResponse for status >= 400
    // but still stores the priced body as the last response cost.
    send('errored');
    // The request handler ends an answered attempt with `answered`.
    manager.endPaidRequest(sellerPeerId, 'errored', true);
    await sellerSends(claim('errored', 80_000n, 80_000n));
    expect(signed(), 'the NeedAuth is refused').toBe(0n);
    await buyerSigns('errored', 80_000n);
    expect(signed(), 'the error answer was paid by the buyer\'s own signing').toBe(0n);
  });

  it('a zero-cost frame for an earlier attempt does not take the retry\'s delivered response with it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Attempt 1 answers 429: nothing delivered. The seller's post-response frame reports cost 0.
    send('r1');
    fail('r1');
    // The buyer retries the same request ID on the same seller (retry-after: 0) before that frame arrives.
    send('r1');
    const zero = sellerSends({ ...claim('r1', 0n, 0n), lastRequestCost: '0', inputTokens: '0' });
    await vi.advanceTimersByTimeAsync(50);
    deliver('r1', 100_000n);
    await zero;
    // The retry's own cost frame is counted, once.
    await sellerSends(claim('r1', 100_000n, 100_000n));
    expect(signed()).toBe(100_000n);
    expect(verified()).toBe(100_000n);
    await buyerSigns('r1', 100_000n);
    expect(signed(), 'paid again at close').toBe(100_000n);
  });

  it('cost frames naming a request in flight are refused at once and do not hold the seller lock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    send('long-stream');
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) pending.push(sellerSends(claim('long-stream', 1n, 1n)));
    // The buyer's own signing for this seller queues behind all of them, and no timer is involved.
    await Promise.all([...pending, manager.resendCurrentSpendingAuth(sellerPeerId, mux)]);
    expect(vi.getTimerCount()).toBe(0);
    expect(signed()).toBe(0n);
    expect(verified()).toBe(0n);
  });

  it('a cost above the window that the buyer never received a response for is signed only inside the window, however many 402s follow', async () => {
    // The buyer aborts a stream; the seller finishes it and bills 1.6 USDC (a large-context request).
    send('aborted');
    fail('aborted');
    const spent = 1_600_000n;
    await sellerSends(claim('aborted', spent, spent));
    // Answered as a prompt: signed inside the window, nothing counted as verified.
    expect(signed()).toBe(WINDOW);
    expect(verified()).toBe(0n);
    await sellerSends(prompt(spent));
    expect(signed()).toBe(WINDOW);
    // The seller parks 5 s and answers 402: with nothing received, the retry does not reopen the window.
    for (let round = 0; round < 3; round += 1) await buyerExtends(spent);
    expect(signed(), 'a 402 retry reopened the window with nothing received').toBe(WINDOW);
    expect(verified()).toBe(0n);
  });

  it('state stays bounded: no timers and no chargeable records after failed and timed-out requests', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const internals = manager as unknown as {
      _requestLedgers: Map<string, Map<string, { settled?: boolean; channelId: string }>>;
    };
    for (let i = 0; i < 50; i += 1) {
      send(`r${i}`);
      if (i % 3 === 0) await sellerSends(claim(`r${i}`, 10n, 10n));
      if (i % 2 === 0) fail(`r${i}`);
      else deliver(`r${i}`, 10n);
      await sellerSends(claim(`r${i}`, 10n, 10n));
    }
    expect(vi.getTimerCount()).toBe(0);
    manager.retireSession(sellerPeerId, CHANNEL_STATUS.SETTLED);
    // The seller's records stay after the channel, bounded, and none can be charged on a later one.
    channelId = await openChannel();
    const records = [...(internals._requestLedgers.get(sellerPeerId.toLowerCase())?.values() ?? [])];
    expect(internals._requestLedgers.size).toBeLessThanOrEqual(1);
    expect(records.length).toBeLessThanOrEqual(1_024);
    expect(records.filter((record) => !record.settled && record.channelId === channelId)).toEqual([]);
  });
});
