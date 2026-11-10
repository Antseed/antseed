import { computeCostUsdc } from '@antseed/buyer-core/pricing';
import { encodeWorkerTail } from '@antseed/protocol/worker-attribution';
import { hexlify, keccak256, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  answerCostUsdc,
  attributedPayment,
  MAX_UNPAID_ANSWERS,
  usageCounts,
  WorkerPaymentLedger,
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
});
