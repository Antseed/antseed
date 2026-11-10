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

const WINDOW = 500_000n;
const RESERVE = 1_000_000_000n;
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };

/**
 * Second-round review probes: what a seller can do to the buyer's memory of
 * the responses it has already paid, and what that memory costs.
 */
describe('review probes: the buyer\'s record of what it has paid', () => {
  let tempDir: string;
  let store: ChannelStore;
  let manager: BuyerPaymentManager;
  let sent: SpendingAuthPayload[];
  let mux: PaymentMux;
  let sellerPeerId: string;
  let channelId: string;

  const peerId = (name: string): string => Buffer.from(name).toString('hex').padEnd(40, '0').slice(0, 40);

  async function openChannel(seller = sellerPeerId): Promise<string> {
    const id = await manager.authorizeSpending(seller, mux, 10_000n, RESERVE, PRICING);
    await manager.handleAuthAck(seller, { channelId: id });
    sent.length = 0;
    return id;
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-needauth-ledger-'));
    store = new ChannelStore(tempDir);
    const privateKey = randomBytes(32);
    const wallet = new Wallet('0x' + bytesToHex(privateKey));
    const identity: Identity = { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
    manager = new BuyerPaymentManager(identity, {
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
    sent = [];
    mux = { sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload); } } as unknown as PaymentMux;
    vi.spyOn(manager, 'getBalance').mockImplementation(async () => ({ available: RESERVE, reserved: RESERVE }));
    manager.setChannelDepositReader(async () => RESERVE);
    sellerPeerId = peerId('seller-under-test');
    channelId = await openChannel();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const signed = (): bigint => manager.getCumulativeAmount(sellerPeerId);
  const verified = (): bigint => manager.getVerifiedCost(sellerPeerId);
  const send = (_requestId: string): void => manager.beginPaidRequest(sellerPeerId);
  const deliver = (requestId: string, cost: bigint): void => {
    manager.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc: cost });
    manager.endPaidRequest(sellerPeerId, requestId, true);
  };
  const sellerSends = (frame: Partial<NeedAuthPayload>): Promise<void> => manager.handleNeedAuth(sellerPeerId, {
    channelId, requiredCumulativeAmount: '0', currentAcceptedCumulative: '0', deposit: RESERVE.toString(), ...frame,
  }, mux);
  const claim = (requestId: string, cost: bigint, required: bigint): Partial<NeedAuthPayload> => ({
    requestId, lastRequestCost: cost.toString(), inputTokens: cost.toString(), outputTokens: '0',
    requiredCumulativeAmount: required.toString(),
  });
  /** The seller's frame for a request it says cost nothing. */
  const zeroCost = (requestId: string, required: bigint): Partial<NeedAuthPayload> => ({
    requestId, lastRequestCost: '0', inputTokens: '0', outputTokens: '0', requiredCumulativeAmount: required.toString(),
  });
  /** The buyer's own signing for its last response, before a cooperative close. */
  const signAtClose = (requestId: string, cost: bigint) => manager.signPerRequestAuth(sellerPeerId, {
    requestId, sellerClaimedCost: cost, reportedInputTokens: cost, reportedOutputTokens: 0n,
    inputBytes: new Uint8Array(0), outputBytes: new Uint8Array(0),
  });

  it('frames naming requests the buyer never sent cannot make it forget a response it paid: the close does not pay it again', async () => {
    send('last-response');
    deliver('last-response', 100_000n);
    await sellerSends(claim('last-response', 100_000n, 100_000n));
    expect(signed()).toBe(100_000n);

    // Zero-cost frames for made-up requests. The first batch asks for nothing
    // (free to send); the second asks for one base unit more each.
    for (let i = 0; i < 2_200; i += 1) await sellerSends(zeroCost(`made-up-${i}`, signed()));
    for (let i = 0; i < 600; i += 1) await sellerSends(zeroCost(`made-up-signed-${i}`, signed() + 1n));
    const beforeClose = signed();
    expect(beforeClose).toBeLessThanOrEqual(100_000n + 600n);

    // The buyer asks for a cooperative close: it signs for its last response itself.
    await signAtClose('last-response', 100_000n);
    expect(signed(), 'the last response was paid a second time at close').toBe(beforeClose);
    expect(verified(), 'the last response was verified a second time').toBe(100_000n);
  });

  it('error answers after the last response cannot make the buyer forget it paid that response', async () => {
    send('last-response');
    deliver('last-response', 100_000n);
    await sellerSends(claim('last-response', 100_000n, 100_000n));
    // The seller answers every later request with an error: nothing delivered, nothing owed.
    for (let i = 0; i < 2_200; i += 1) {
      send(`errored-${i}`);
      manager.endPaidRequest(sellerPeerId, `errored-${i}`, true);
    }
    // Other sellers' traffic meanwhile.
    const other = peerId('other-seller');
    const otherChannel = await openChannel(other);
    for (let i = 0; i < 600; i += 1) {
      manager.beginPaidRequest(other);
      manager.recordDeliveredResponse(other, `other-${i}`, { costUsdc: 1n });
      manager.endPaidRequest(other, `other-${i}`, true);
      await manager.handleNeedAuth(other, {
        channelId: otherChannel, requestId: `other-${i}`, lastRequestCost: '1', inputTokens: '1', outputTokens: '0',
        requiredCumulativeAmount: String(i + 1), currentAcceptedCumulative: '0', deposit: RESERVE.toString(),
      }, mux);
    }
    await signAtClose('last-response', 100_000n);
    expect(signed(), 'the last response was paid a second time at close').toBe(100_000n);
  });

  it('a later attempt of a paid request that the buyer cuts off does not make the close pay its response again', async () => {
    for (const [requestId, cutOff] of [['partial', { costUsdc: 300_000n, cutOff: true }], ['nothing-arrived', null]] as const) {
      const before = signed();
      send(requestId);
      deliver(requestId, 100_000n);
      await sellerSends(claim(requestId, 100_000n, before + 100_000n));
      expect(signed()).toBe(before + 100_000n);
      // The same request ID goes out again and the buyer cuts the attempt off.
      send(requestId);
      if (cutOff) manager.recordDeliveredResponse(sellerPeerId, requestId, cutOff);
      manager.endPaidRequest(sellerPeerId, requestId);
      await signAtClose(requestId, 100_000n);
      expect(signed(), `${requestId}: the response was paid a second time at close`).toBe(before + 100_000n);
    }
  });

  it('requests the seller lets time out cannot make the buyer forget a response it paid: the close does not pay it again', async () => {
    for (const paidBy of ['its NeedAuth', 'an earlier close'] as const) {
      const requestId = `paid-by-${paidBy}`;
      const before = signed();
      send(requestId);
      deliver(requestId, 100_000n);
      if (paidBy === 'its NeedAuth') await sellerSends(claim(requestId, 100_000n, before + 100_000n));
      else await signAtClose(requestId, 100_000n);
      expect(signed()).toBe(before + 100_000n);
      // More attempts end with nothing delivered than the buyer keeps records of.
      for (let i = 0; i < 600; i += 1) {
        send(`${requestId}-timed-out-${i}`);
        manager.endPaidRequest(sellerPeerId, `${requestId}-timed-out-${i}`);
      }
      await signAtClose(requestId, 100_000n);
      expect(signed(), `paid by ${paidBy}: the response was paid a second time at close`).toBe(before + 100_000n);
    }
  });

  it('the buyer\'s signing before a close attributes each response it pays to its own service and usage', async () => {
    const usage = (inputTokens: bigint) => ({ inputTokens, cachedInputTokens: 0n, outputTokens: 0n });
    send('chat');
    manager.recordDeliveredResponse(sellerPeerId, 'chat', { costUsdc: 100_000n, service: 'svc-a', usage: usage(100_000n) });
    manager.endPaidRequest(sellerPeerId, 'chat', true);
    send('last');
    manager.recordDeliveredResponse(sellerPeerId, 'last', { costUsdc: 50_000n, service: 'svc-b', usage: usage(50_000n) });
    manager.endPaidRequest(sellerPeerId, 'last', true);
    // Neither charge arrived. The close names only the last response.
    await manager.signPerRequestAuth(sellerPeerId, {
      requestId: 'last', service: 'svc-b', sellerClaimedCost: 50_000n, reportedInputTokens: 50_000n, reportedOutputTokens: 0n,
      inputBytes: new Uint8Array(0), outputBytes: new Uint8Array(0),
    });
    expect(signed()).toBe(150_000n);
    type Totals = { cumulativeAmount: bigint; cumulativeInputTokens: bigint; cumulativeRequestCount: bigint };
    type Meta = Omit<Totals, 'cumulativeAmount'> & { services?: Totals[] };
    const meta = (manager as unknown as { _metadata: Map<string, Meta> })._metadata.get(sellerPeerId)!;
    expect(meta.cumulativeRequestCount).toBe(2n);
    expect(meta.cumulativeInputTokens).toBe(150_000n);
    expect(meta.services?.map((s) => [s.cumulativeAmount, s.cumulativeInputTokens, s.cumulativeRequestCount]).sort((a, b) => Number(a[0] - b[0])))
      .toEqual([[50_000n, 50_000n, 1n], [100_000n, 100_000n, 1n]]);
  });

  it('a response that arrives while no channel is live is not paid on a later channel', async () => {
    manager.retireSession(sellerPeerId, CHANNEL_STATUS.SETTLED);
    send('between-channels');
    deliver('between-channels', 100_000n);
    channelId = await openChannel();
    await sellerSends(claim('between-channels', 100_000n, 100_000n));
    expect(signed()).toBe(0n);
    await signAtClose('between-channels', 100_000n);
    expect(signed(), 'paid on a channel that was not live when the response arrived').toBe(0n);
  });

  it('adversarial seller, every kind of attempt and frame: never signed past 1.4x what the buyer recorded plus one window per (1 + buyer 402 retries) (300 random sessions)', async () => {
    /** mulberry32, so a failing sequence can be replayed by its seed. */
    const prng = (seed: number): (() => number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    for (let seed = 1; seed <= 300; seed += 1) {
      manager.retireSession(sellerPeerId, CHANNEL_STATUS.SETTLED);
      channelId = await openChannel();
      const random = prng(90_000 + seed);
      const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
      const log: string[] = [];
      const inFlight: string[] = [];
      /** Requests that ended, with what the buyer recorded for them (its price, a cut-off's cap, or nothing). */
      const ended = new Map<string, bigint>();
      /** Everything the buyer recorded on this channel: prices of responses it received and caps of attempts it cut off. */
      let recorded = 0n;
      let records = 0;
      let windows = 1n;
      let counter = 0;
      let madeUp = 0;
      const amount = (): bigint => BigInt(Math.floor(random() * 2_000_000));
      const endOne = (): string | undefined => inFlight.splice(Math.floor(random() * inFlight.length), 1)[0];
      const record = (id: string, cost: bigint): void => { ended.set(id, cost); recorded += cost; records += 1; };

      for (let step = 0; step < 100; step += 1) {
        const action = pick([
          'start', 'start', 'deliver', 'deliver', 'cut-off-priced', 'cut-off-unpriced', 'error', 'redeliver', 'retry-cut-off',
          'claim', 'claim', 'claim-made-up', 'zero', 'zero-made-up', 'prompt', 'close-sign', 'extend', 'covered',
        ]);
        const id = `r${seed}-${counter}`;
        if (action === 'start' && inFlight.length < 3) {
          counter += 1;
          inFlight.push(id);
          send(id);
          log.push(`start ${id}`);
        } else if (action === 'deliver' && inFlight.length > 0) {
          const done = endOne()!;
          const cost = BigInt(Math.floor(random() * 100_000));
          deliver(done, cost);
          record(done, cost);
          log.push(`deliver ${done} ${cost}`);
        } else if (action === 'cut-off-priced' && inFlight.length > 0) {
          const done = endOne()!;
          const cap = BigInt(Math.floor(random() * 200_000));
          manager.recordDeliveredResponse(sellerPeerId, done, { costUsdc: cap, cutOff: true });
          manager.endPaidRequest(sellerPeerId, done);
          record(done, cap);
          log.push(`cut off ${done} cap=${cap}`);
        } else if (action === 'cut-off-unpriced' && inFlight.length > 0) {
          const done = endOne()!;
          manager.endPaidRequest(sellerPeerId, done);
          ended.set(done, ended.get(done) ?? 0n);
          log.push(`cut off ${done}, nothing priceable`);
        } else if (action === 'error' && inFlight.length > 0) {
          const done = endOne()!;
          manager.endPaidRequest(sellerPeerId, done, true);
          ended.set(done, ended.get(done) ?? 0n);
          log.push(`error answer ${done}`);
        } else if (action === 'redeliver' && ended.size > 0 && inFlight.length === 0) {
          const again = pick([...ended.keys()]);
          const cost = BigInt(Math.floor(random() * 100_000));
          send(again);
          deliver(again, cost);
          record(again, cost);
          log.push(`redeliver ${again} ${cost}`);
        } else if (action === 'retry-cut-off' && ended.size > 0 && inFlight.length === 0) {
          // A request that already ended goes out again, and the buyer cuts this attempt off.
          const again = pick([...ended.keys()]);
          send(again);
          if (random() < 0.5) {
            const cap = BigInt(Math.floor(random() * 200_000));
            manager.recordDeliveredResponse(sellerPeerId, again, { costUsdc: cap, cutOff: true });
            recorded += cap;
            records += 1;
          }
          manager.endPaidRequest(sellerPeerId, again);
          log.push(`retry of ${again} cut off`);
        } else if ((action === 'claim' || action === 'zero') && ended.size > 0) {
          const named = pick([...ended.keys()]);
          const required = random() < 0.3 ? signed() : signed() + amount();
          const frame = action === 'claim' ? claim(named, amount(), required) : zeroCost(named, required);
          log.push(`${action} ${named} cost=${frame.lastRequestCost} required=${required}`);
          await sellerSends(frame);
        } else if (action === 'claim-made-up' || action === 'zero-made-up') {
          madeUp += 1;
          const required = random() < 0.5 ? signed() : signed() + 1n;
          log.push(`${action} required=${required}`);
          await sellerSends(action === 'claim-made-up' ? claim(`made-up-${madeUp}`, amount(), signed() + amount()) : zeroCost(`made-up-${madeUp}`, required));
        } else if (action === 'prompt') {
          const required = signed() + amount();
          log.push(`prompt ${required}`);
          await sellerSends({ requiredCumulativeAmount: required.toString() });
        } else if (action === 'close-sign' && ended.size > 0) {
          // The buyer's own signing, for any request that ended: its own price where it received a response.
          const named = pick([...ended.keys()]);
          log.push(`close-sign ${named}`);
          await signAtClose(named, ended.get(named)!);
        } else if (action === 'extend') {
          windows += 1n;
          const target = signed() + amount();
          log.push(`402 extend target=${target}`);
          await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux, target);
        } else if (action === 'covered' && inFlight.length > 0) {
          const named = pick(inFlight);
          manager.markRequestCovered(sellerPeerId, named);
          log.push(`covered ${named}`);
        }
        const verifiable = (recorded * 14n + 9n) / 10n + BigInt(records);
        expect(verified(), `seed ${seed}: verified ${verified()} past what the buyer recorded (${recorded}) and ${windows - 1n} reopened windows\n${log.join('\n')}`)
          .toBeLessThanOrEqual(verifiable + (windows - 1n) * WINDOW);
        expect(signed(), `seed ${seed}: signed past verified + window\n${log.join('\n')}`).toBeLessThanOrEqual(verified() + WINDOW);
      }
    }
  }, 180_000);

  it('reports: a seller prompt signed before the buyer has recorded the response it is for, then a close', async () => {
    // The seller's catch-up prompt for r1 (its cost frame was lost) is handled
    // before the buyer's response path has recorded r1.
    send('r1');
    await sellerSends({ requiredCumulativeAmount: '100000' });
    expect(signed()).toBe(100_000n);
    deliver('r1', 100_000n);
    await signAtClose('r1', 100_000n);
    console.log(`[probe] prompt before the response was recorded, then close: signed=${signed()} for 100000 served`);
    expect(signed()).toBeLessThanOrEqual(verified() + WINDOW);
  });

  it('reports: a seller that answers nothing and lets every request time out is paid each request\'s limit', async () => {
    // The buyer cannot tell a seller that stalls from one that is slow: each
    // attempt it cut off counts up to its prompt plus the output it allows.
    const cap = 100_000n;
    for (let i = 0; i < 20; i += 1) {
      send(`timed-out-${i}`);
      manager.recordDeliveredResponse(sellerPeerId, `timed-out-${i}`, { costUsdc: cap, cutOff: true });
      manager.endPaidRequest(sellerPeerId, `timed-out-${i}`);
      await sellerSends(claim(`timed-out-${i}`, cap * 2n, signed() + cap * 2n));
    }
    console.log(`[probe] 20 requests that timed out with nothing received, limit ${cap} each: signed=${signed()} verified=${verified()}`);
    expect(verified()).toBe(20n * (cap * 14n / 10n));
    expect(signed()).toBeLessThanOrEqual(verified() + WINDOW);
  });

  it('reports: state kept for sellers whose channels ended', async () => {
    const internals = manager as unknown as Record<string, Map<string, unknown> | Set<string> | undefined>;
    for (let s = 0; s < 40; s += 1) {
      const seller = peerId(`seller-${s}`);
      const channel = await openChannel(seller);
      for (let i = 0; i < 30; i += 1) {
        manager.beginPaidRequest(seller);
        manager.recordDeliveredResponse(seller, `r${i}`, { costUsdc: 10n });
        manager.endPaidRequest(seller, `r${i}`, true);
        await manager.handleNeedAuth(seller, {
          channelId: channel, requestId: `r${i}`, lastRequestCost: '10', inputTokens: '10', outputTokens: '0',
          requiredCumulativeAmount: String((i + 1) * 10), currentAcceptedCumulative: '0', deposit: RESERVE.toString(),
        }, mux);
      }
      manager.retireSession(seller, CHANNEL_STATUS.SETTLED);
    }
    const sizes = Object.entries(internals)
      .filter(([name, value]) => name.startsWith('_') && (value instanceof Map || value instanceof Set))
      .map(([name, value]) => {
        let entries = 0;
        for (const inner of (value as Map<string, unknown>).values()) {
          entries += inner instanceof Map || inner instanceof Set ? inner.size : 1;
        }
        return [name, (value as Map<string, unknown>).size, entries] as const;
      })
      .filter(([, size]) => size > 2);
    console.log(`[probe] state left after 40 sellers x 30 paid requests, all channels retired: ${JSON.stringify(sizes)}`);
  });

  it('when a channel ends, keeps nothing received on it, and pays it on no later channel', async () => {
    const ledgers = (manager as unknown as { _requestLedgers: Map<string, Map<string, unknown>> })._requestLedgers;
    for (let i = 0; i < 30; i += 1) {
      send(`r${i}`);
      deliver(`r${i}`, 10n);
      await sellerSends(claim(`r${i}`, 10n, BigInt((i + 1) * 10)));
    }
    send('errored');
    manager.endPaidRequest(sellerPeerId, 'errored', true);
    send('timed-out');
    manager.endPaidRequest(sellerPeerId, 'timed-out');
    manager.retireSession(sellerPeerId, CHANNEL_STATUS.SETTLED);
    expect(ledgers.has(sellerPeerId)).toBe(false);
    // The negotiator may still name that response when it next asks the seller to close.
    channelId = await openChannel();
    await signAtClose('r29', 10n);
    await sellerSends(claim('r29', 10n, 10n));
    expect(signed()).toBe(0n);

    // A seller that only ever answered with errors leaves nothing behind.
    const other = peerId('other-seller');
    await openChannel(other);
    manager.beginPaidRequest(other);
    manager.endPaidRequest(other, 'errored', true);
    manager.retireSession(other, CHANNEL_STATUS.SETTLED);
    expect(ledgers.has(other)).toBe(false);
  });

  it('a zero-cost frame for an error answer does not hold the seller lock while the retry is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Attempt 1 is answered with an error; the buyer retries the same request ID on the same seller.
      send('retried');
      manager.endPaidRequest(sellerPeerId, 'retried', true);
      send('retried');
      // The seller's post-response frame for the error answer (cost 0) arrives while the retry is in flight.
      const zero = sellerSends(zeroCost('retried', 0n));
      // Another request to the seller is delivered and billed meanwhile.
      send('parallel');
      deliver('parallel', 100_000n);
      const parallel = sellerSends(claim('parallel', 100_000n, 100_000n));
      await vi.advanceTimersByTimeAsync(100);
      expect(signed(), 'the parallel request\'s cost frame waited behind the zero-cost frame').toBe(100_000n);
      await Promise.all([zero, parallel]);
      // The retry's own response is chargeable, once.
      deliver('retried', 50_000n);
      await sellerSends(claim('retried', 50_000n, 150_000n));
      expect(signed()).toBe(150_000n);
      expect(verified()).toBe(150_000n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports: a 402 retry that reopens the window takes a response that arrived during it as paid', async () => {
    // The window is used up by work the buyer has no response for (a request that timed out, billed by the seller).
    send('timed-out');
    manager.endPaidRequest(sellerPeerId, 'timed-out');
    await sellerSends(claim('timed-out', 550_000n, 550_000n));
    expect(signed()).toBe(WINDOW);
    // The seller answers request B with a 402 for its spend so far (550,000). Request A, sent earlier,
    // is delivered while the buyer handles that 402, so the 402's target does not include it.
    send('a');
    deliver('a', 100_000n);
    await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux, 550_000n);
    expect(signed()).toBe(550_000n);
    await sellerSends(claim('a', 100_000n, 650_000n));
    console.log(`[probe] response delivered during a reopening 402 retry: after its cost frame signed=${signed()} of 650000, verified=${verified()}`);
    // The seller's catch-up prompt for the next request gets it paid, inside the window.
    await sellerSends({ requiredCumulativeAmount: '650000' });
    expect(signed()).toBe(650_000n);
  });

  it('the buyer\'s signing before a close does not sign a 402 retry\'s minimum advance on top of what the seller served', async () => {
    send('r1');
    deliver('r1', 100_000n);
    await sellerSends(claim('r1', 100_000n, 100_000n));
    // The seller answers 402 asking for what it served (100,000). The retry signs its minimum advance, 10,000 past that.
    await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux, 100_000n, 'r2', 1);
    expect(signed()).toBe(110_000n);

    // Two responses the advance already covers, so their cost frames ask for nothing new. A close the seller
    // refuses follows each: the buyer's own signing counts the response against the advance, not on top of it.
    send('r2');
    deliver('r2', 3_000n);
    await sellerSends(claim('r2', 3_000n, 103_000n));
    await signAtClose('r2', 3_000n);
    send('r3');
    deliver('r3', 5_000n);
    await sellerSends(claim('r3', 5_000n, 108_000n));
    await signAtClose('r3', 5_000n);
    expect(signed(), 'signed the advance and the responses it covered').toBe(110_000n);

    // A response past the advance: its cost frame signs up to what the seller served, and the close adds nothing.
    send('r4');
    deliver('r4', 50_000n);
    await sellerSends(claim('r4', 50_000n, 158_000n));
    expect(signed()).toBe(158_000n);
    await signAtClose('r4', 50_000n);
    expect(signed(), 'signed the advance on top of what the seller served').toBe(158_000n);
    expect(verified()).toBe(158_000n);
  });
});
