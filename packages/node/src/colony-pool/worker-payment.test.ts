import { computeCostUsdc } from '@antseed/buyer-core/pricing';
import { encodeWorkerTail } from '@antseed/protocol/worker-attribution';
import { hexlify, keccak256, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { signTestWorkerPayment } from './apple-attestation-testing.js';
import {
  answerCostUsdc,
  attributedPayment,
  isChargeablePrice,
  MAX_TRACKED_CHANNELS,
  MAX_UNPAID_ANSWERS,
  INTERRUPTED_WINDOW_MS,
  MAX_INTERRUPTED_ANSWERS,
  usageCounts,
  WorkerPaymentLedger,
  type WorkerLedgerSnapshot,
  type WorkerLedgerStore,
  type WorkerPayment,
} from './worker-payment.js';

const buyer = Wallet.createRandom();
const worker = '0x1000000000000000000000000000000000000001';
const other = '0x2000000000000000000000000000000000000002';
const channel = `0x${'ab'.repeat(32)}`;
const domain = { chainId: 8453, channelsAddress: '0x3000000000000000000000000000000000000003' };

/** A SpendingAuth on `channel` attributing `amounts` to workers, signed by `signer` for `signedDomain`. */
async function payment(
  cumulativeAmount: bigint,
  amounts: Array<[string, bigint]>,
  signer: Wallet = buyer,
  signedDomain = domain,
): Promise<WorkerPayment> {
  // An eight-word ABI head, then the attribution tail.
  const metadata = hexlify(new Uint8Array([...new Uint8Array(256), ...Buffer.from(encodeWorkerTail(amounts.map(([w, a]) => ({ worker: w, cumulativeAmount: a }))).slice(2), 'hex')]));
  const signature = await signer.signTypedData(
    { name: 'AntseedChannels', version: '1', chainId: signedDomain.chainId, verifyingContract: signedDomain.channelsAddress },
    { SpendingAuth: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint256' }, { name: 'metadataHash', type: 'bytes32' }] },
    { channelId: channel, cumulativeAmount, metadataHash: keccak256(metadata) },
  );
  return { cumulativeAmount: cumulativeAmount.toString(), metadata, signature };
}

const check = { channel, buyer: buyer.address, worker, deposit: 1_000_000n, domain };

describe('worker payments', () => {
  it('reads what a buyer-signed SpendingAuth attributes to this worker', async () => {
    const paid = await payment(50_000n, [[worker, 30_000n], [other, 20_000n]]);
    expect(attributedPayment(paid, check)).toBe(30_000n);
    // Attributed only to others: nothing for this worker.
    expect(attributedPayment(await payment(20_000n, [[other, 20_000n]]), check)).toBe(0n);
  });

  it('refuses a payment the channel\'s buyer did not sign, one for another Channels contract, and one beyond the reserve', async () => {
    await expect(payment(50_000n, [[worker, 50_000n]], Wallet.createRandom()).then((p) => attributedPayment(p, check))).rejects.toThrow(/not signed by the channel's buyer/);
    const elsewhere = await payment(50_000n, [[worker, 50_000n]], buyer, { ...domain, channelsAddress: other });
    expect(() => attributedPayment(elsewhere, check)).toThrow(/not signed by the channel's buyer/);
    expect(() => attributedPayment(elsewhere, { ...check, domain: { ...domain, chainId: 1 } })).toThrow();
    const tooMuch = await payment(2_000_000n, [[worker, 2_000_000n]]);
    expect(() => attributedPayment(tooMuch, check)).toThrow(/exceeds the channel's reserve/);
  });

  it('refuses attribution the payment does not fund: on a zero authorization, one oversized entry, or entries that add up past it', async () => {
    const sign = (amount: bigint, cumulativeAmount: bigint, others: Array<{ worker: string; cumulativeAmount: bigint }> = []) =>
      signTestWorkerPayment({ signer: buyer, channel, worker, amount, domain, cumulativeAmount, others });
    const onZero = await sign(9_000n, 0n);
    const oversized = await sign(1_000_000n, 1n);
    const pastIt = await sign(30_000n, 50_000n, [{ worker: other, cumulativeAmount: 30_000n }]);
    expect(() => attributedPayment(onZero, check)).toThrow(/attributes more to workers than it authorizes/);
    expect(() => attributedPayment(oversized, check)).toThrow(/attributes more/);
    expect(() => attributedPayment(pastIt, check)).toThrow(/attributes more/);
    // Exactly what it authorizes is fine.
    expect(attributedPayment(await sign(30_000n, 50_000n, [{ worker: other, cumulativeAmount: 20_000n }]), check)).toBe(30_000n);
  });

  it('serves only pools whose prices charge something', () => {
    expect(isChargeablePrice({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 })).toBe(false);
    expect(isChargeablePrice({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0 })).toBe(false);
    expect(isChargeablePrice(undefined)).toBe(false);
    expect(isChargeablePrice({ inputUsdPerMillion: 0, outputUsdPerMillion: 0.6 })).toBe(true);
  });

  it('owes nothing for answers whose price rounds to zero, so an honest buyer is never locked out', () => {
    const ledger = new WorkerPaymentLedger();
    // Many such answers, and the buyer's payment never grows: none is owed.
    for (let i = 0; i < MAX_UNPAID_ANSWERS * 3; i++) {
      ledger.admit(channel, 0n);
      ledger.served(channel, 0n);
    }
    // A priced answer after them is owed as usual.
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    expect(() => ledger.admit(channel, 0n)).toThrow(/unpaid/);
  });

  it('prices an answer exactly as the buyer does', () => {
    const price = { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, cachedInputUsdPerMillion: 0.075 };
    const usage = usageCounts({ prompt_tokens: 1234, completion_tokens: 567, prompt_tokens_details: { cached_tokens: 200 } });
    expect(answerCostUsdc(usage, price)).toBe(computeCostUsdc(1034, 567, price, 200));
  });

  it('lets a buyer that never pays run only MAX_UNPAID_ANSWERS answers ahead on a channel', () => {
    const ledger = new WorkerPaymentLedger();
    for (let i = 0; i < MAX_UNPAID_ANSWERS; i++) {
      ledger.admit(channel, 0n);
      ledger.served(channel, 9_000n);
    }
    // Fresh bindings without a payment get no more work.
    expect(() => ledger.admit(channel, 0n)).toThrow(/has not arrived \(2 unpaid\)/);
    // Paying for the first answer frees one slot, not more.
    ledger.admit(channel, 9_000n);
    ledger.served(channel, 9_000n);
    expect(() => ledger.admit(channel, 9_000n)).toThrow(/unpaid/);
    // Paying for them all clears the account.
    ledger.admit(channel, 27_000n);
    // Other channels are accounted apart.
    ledger.admit(`0x${'cd'.repeat(32)}`, 0n);
  });

  it('counts requests still running, so concurrent requests cannot run past the limit', () => {
    const ledger = new WorkerPaymentLedger();
    ledger.admit(channel, 0n);
    ledger.admit(channel, 0n);
    expect(() => ledger.admit(channel, 0n)).toThrow(/unpaid/);
    // An answer that never reached the buyer is not owed.
    ledger.released(channel);
    ledger.admit(channel, 0n);
  });

  it('keeps the highest payment seen: an older, lower one replayed by the pool never undoes it', () => {
    const ledger = new WorkerPaymentLedger();
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 18_000n);
    ledger.served(channel, 9_000n);
    // A replayed payment of 0 still counts the 18,000 already signed: one answer is unpaid.
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    expect(() => ledger.admit(channel, 0n)).toThrow(/unpaid/);
  });

  it('resumes from its store, so a restart never lets an old payment pay for new answers', () => {
    let saved: WorkerLedgerSnapshot | null = null;
    const store: WorkerLedgerStore = { load: () => saved && structuredClone(saved), save: (snapshot) => { saved = structuredClone(snapshot); } };
    const ledger = new WorkerPaymentLedger(store);
    // Paid 900,000 for 100 answers of 9,000.
    for (let i = 0; i < 100; i++) {
      ledger.admit(channel, BigInt(i) * 9_000n, BigInt(i) * 9_000n);
      ledger.served(channel, 9_000n);
    }
    ledger.admit(channel, 900_000n, 900_000n);
    ledger.served(channel, 9_000n);
    const restarted = new WorkerPaymentLedger(store);
    // The same proof again: the answer just served is still owed, so one more and no further.
    restarted.admit(channel, 900_000n, 900_000n);
    restarted.served(channel, 9_000n);
    expect(() => restarted.admit(channel, 900_000n, 900_000n)).toThrow(/2 unpaid/);
  });

  it('counts what a forgotten channel\'s payment already attributes as paying for earlier answers', () => {
    const ledger = new WorkerPaymentLedger();
    // First seen with 900,000 attributed: none of it pays for new answers.
    ledger.admit(channel, 900_000n, 900_000n);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 900_000n, 900_000n);
    ledger.served(channel, 9_000n);
    expect(() => ledger.admit(channel, 900_000n, 900_000n)).toThrow(/unpaid/);
    // Paying for them both does.
    ledger.admit(channel, 918_000n, 918_000n);
  });

  it('owes again what a settlement left uncredited, until a later payment covers it', () => {
    const ledger = new WorkerPaymentLedger();
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 9_000n, 10_000n);
    // Not settled that far yet: nothing to judge.
    expect(ledger.reconcile(channel, 5_000n, 0n)).toBe(false);
    // Settled past it and credited in full: done with that payment.
    expect(ledger.reconcile(channel, 10_000n, 9_000n)).toBe(false);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 18_000n, 20_000n);
    ledger.served(channel, 9_000n);
    // Settled past it with an auth that credits this worker nothing more: those 9,000 are owed again.
    expect(ledger.reconcile(channel, 20_000n, 9_000n)).toBe(true);
    expect(() => ledger.admit(channel, 9_000n, 20_000n)).toThrow(/2 unpaid/);
    // The buyer is not refused: a payment that covers both answers is served.
    ledger.admit(channel, 27_000n, 40_000n);
  });

  it('keeps an older same-amount settlement from refusing a buyer whose newer auth attributes more', () => {
    const ledger = new WorkerPaymentLedger();
    ledger.admit(channel, 0n, 100_000n);
    ledger.served(channel, 10_000n);
    // The buyer re-signs the same cumulative amount, now attributing 10,000 to this worker.
    ledger.admit(channel, 10_000n, 100_000n);
    ledger.served(channel, 10_000n);
    // The pool had already snapshotted the older auth, and settles it: nothing credited.
    expect(ledger.reconcile(channel, 100_000n, 0n)).toBe(true);
    // Both answers are owed again, so no third runs on that payment...
    expect(() => ledger.admit(channel, 0n, 100_000n)).toThrow(/2 unpaid/);
    // ...but a newer payment, which a later settlement can still fund, pays for them.
    ledger.admit(channel, 20_000n, 120_000n);
    ledger.served(channel, 10_000n);
    // That settlement catches the worker up: nothing short, nothing owed again.
    expect(ledger.reconcile(channel, 120_000n, 20_000n)).toBe(false);
    ledger.admit(channel, 30_000n, 130_000n);
  });

  it('serves only a few cut-off answers per channel, and serves again once they age out', () => {
    let now = 1_000_000;
    const ledger = new WorkerPaymentLedger(undefined, () => now);
    for (let i = 0; i < MAX_INTERRUPTED_ANSWERS; i++) {
      ledger.admit(channel, 0n);
      ledger.interrupted(channel);
    }
    // Not owed, so they hold no unpaid answer, but no third is cut off on credit.
    expect(() => ledger.admit(channel, 0n)).toThrow(/cut off recently; retry in 1800s/);
    now += INTERRUPTED_WINDOW_MS - 1;
    expect(() => ledger.admit(channel, 0n)).toThrow(/retry in 1s/);
    now += 1;
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    // A paid answer still counts as unpaid until a payment covers it.
    ledger.admit(channel, 0n);
  });

  it('keeps cut-off answers across a restart', () => {
    let saved: WorkerLedgerSnapshot | null = null;
    const store: WorkerLedgerStore = { load: () => saved && structuredClone(saved), save: (snapshot) => { saved = structuredClone(snapshot); } };
    const now = () => 5_000_000;
    const ledger = new WorkerPaymentLedger(store, now);
    for (let i = 0; i < MAX_INTERRUPTED_ANSWERS; i++) {
      ledger.admit(channel, 0n);
      ledger.interrupted(channel);
    }
    expect(() => new WorkerPaymentLedger(store, now).admit(channel, 0n)).toThrow(/cut off recently/);
  });

  it('never queues an answer that costs nothing, even behind an unpaid one', () => {
    const ledger = new WorkerPaymentLedger();
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 0n);
    ledger.served(channel, 0n);
    // One answer unpaid, so one more may run.
    ledger.admit(channel, 0n);
  });

  it('forgets a closed channel, freeing its place for new ones', () => {
    const ledger = new WorkerPaymentLedger();
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    ledger.forget(channel);
    // Forgotten: nothing owed on it any more (a closed channel gets no more work anyway).
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 0n);
  });

  it('makes room past its channel limit by forgetting an idle channel, even one whose last answer is owed', () => {
    const ledger = new WorkerPaymentLedger();
    const channelAt = (i: number) => `0x${i.toString(16).padStart(64, '0')}`;
    // Each channel's last answer is paid by an auth this worker never sees: it stays owed.
    for (let i = 0; i < MAX_TRACKED_CHANNELS; i++) {
      ledger.admit(channelAt(i), 0n);
      ledger.served(channelAt(i), 9_000n);
    }
    // One more channel still gets served.
    ledger.admit(channelAt(MAX_TRACKED_CHANNELS), 0n);
    // The least recently used went: its owed answer is forgiven, as a fresh channel's would be.
    ledger.admit(channelAt(0), 0n);
    ledger.served(channelAt(0), 9_000n);
    ledger.admit(channelAt(0), 0n);
  });
});
