import type { ReferralView } from '../api-types.js';
import type { AntsContext } from './context.js';
import { silentReporter, type StepReporter } from './steps.js';

const REFERRAL_LINK_BASE = 'https://antseed.com/?ref=';

export async function referral(ctx: AntsContext): Promise<ReferralView> {
  const client = ctx.referrals();
  if (!client) return { available: false, referralUrl: null, claimable: '0', payable: '0', pendingAccruals: 0, referredCount: 0, rateBps: 200 };
  const fromBlock = ctx.chain.recognizedUsage?.deploymentBlock ?? 0;
  const [amount, payable, rateBps, referredCount, accruable] = await Promise.all([
    client.claimable(ctx.address),
    client.payableAmount(ctx.address),
    client.referralRateBps(),
    client.referredCount(ctx.address),
    client.accruableBuyers(ctx.address, fromBlock).catch(() => []),
  ]);
  return {
    available: true,
    referralUrl: `${REFERRAL_LINK_BASE}${encodeURIComponent(ctx.address)}`,
    claimable: amount.toString(),
    payable: payable.toString(),
    pendingAccruals: accruable.length,
    referredCount,
    rateBps,
  };
}

/**
 * Accrue every finalized epoch for the wallet's referred buyers, then claim.
 * Accrual is permissionless and idempotent, so running it here means the
 * referrer never depends on a separate weekly job.
 */
export async function claimReferralRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ hash: string | null; accrued: number }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  const signer = ctx.requireSigner();
  const fromBlock = ctx.chain.recognizedUsage?.deploymentBlock ?? 0;
  const accruable = await client.accruableBuyers(ctx.address, fromBlock);
  for (const [index, entry] of accruable.entries()) {
    await report(`Accruing referral rewards (${index + 1}/${accruable.length})`);
    const hash = await client.accrue(signer, entry.buyer, entry.throughEpoch);
    await report('Referral epoch accrued', hash);
  }
  const amount = await client.payableAmount(ctx.address);
  if (amount === 0n) {
    if (accruable.length === 0) throw new Error('No referral rewards can be paid from the emission buckets yet.');
    await report('No payable referral rewards after accrual');
    return { hash: null, accrued: accruable.length };
  }
  await report('Claiming referral rewards');
  const hash = await client.claim(signer);
  await report('Referral rewards claimed', hash);
  return { hash, accrued: accruable.length };
}
