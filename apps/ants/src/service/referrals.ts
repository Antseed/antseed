import type { ReferralView } from '../api-types.js';
import type { AntsContext } from './context.js';
import { silentReporter, type StepReporter } from './steps.js';

const REFERRAL_LINK_BASE = 'https://antseed.com/?ref=';

export async function referral(ctx: AntsContext): Promise<ReferralView> {
  const client = ctx.referrals();
  if (!client) return { available: false, referralUrl: null, payable: '0', claimableEpochs: [], referredCount: 0 };
  const [referredCount, pending] = await Promise.all([
    client.referredCount(ctx.address),
    client.pendingRewards(ctx.address),
  ]);
  return {
    available: true,
    referralUrl: `${REFERRAL_LINK_BASE}${encodeURIComponent(ctx.address)}`,
    payable: pending.reduce((sum, entry) => sum + entry.amount, 0n).toString(),
    claimableEpochs: pending.map((entry) => entry.epoch),
    referredCount,
  };
}

/** Claim every epoch with a payable referral reward for the dashboard wallet. */
export async function claimReferralRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ hash: string; epochs: number[] }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  const pending = await client.pendingRewards(ctx.address);
  if (pending.length === 0) throw new Error('No referral rewards are payable yet.');
  const epochs = pending.map((entry) => entry.epoch);
  await report(`Claiming referral rewards for ${epochs.length} ${epochs.length === 1 ? 'epoch' : 'epochs'}`);
  const hash = await client.claimEpochs(ctx.requireSigner(), ctx.address, epochs);
  await report('Referral rewards claimed', hash);
  return { hash, epochs };
}
