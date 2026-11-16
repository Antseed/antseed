/**
 * Seller model-verification results per pool. The verification points policy scales every
 * settlement's seller and buyer points by one multiplier from the seller agent's live SAME
 * and DIFF verdicts, and pool rewards follow those points, so a pool's APR moves with them.
 *
 * Verdict counts come from one cached Antscan read for every provider; the policy's two
 * rates are read on-chain at most once an hour, inside a multicall the pools view already runs.
 */

import { Interface } from 'ethers';
import { getChainConfig, verificationPointsMultiplierBps, type VerificationPointsRates } from '@antseed/node';
import type { AntsContext } from './context.js';
import type { PoolVerification, PoolView } from '../api-types.js';
import type { IndexedVerifications } from './indexer.js';

export const VERIFICATION_POLICY_IFACE = new Interface([
  'function bonusBps() view returns (uint256)',
  'function penaltyBps() view returns (uint256)',
]);

/** How long the policy rates stay cached; they change only by an owner transaction. */
export const RATES_TTL_MS = 60 * 60_000;

export type VerificationRates = VerificationPointsRates;

/** The policy multiplier in bps, exactly as `AntseedVerificationPointsPolicy.points` computes it. */
export function pointsMultiplierBps(sameCount: number, diffCount: number, rates: VerificationRates): number {
  return verificationPointsMultiplierBps(sameCount, diffCount, rates);
}

/**
 * The verification points policy for this chain: the configured address, else the built-in one
 * when this config uses the built-in usage accounting the policy is bound to (hosts that list
 * contract fields one by one may not pass the policy through yet).
 */
export function verificationPolicyAddress(ctx: AntsContext): string | null {
  if (ctx.chain.verificationPointsPolicyAddress) return ctx.chain.verificationPointsPolicyAddress;
  const builtIn = getChainConfig(ctx.chain.chainId);
  const accounting = ctx.chain.usageAccountingAddress?.toLowerCase();
  return builtIn.chainId === ctx.chain.chainId && builtIn.evmChainId === ctx.chain.evmChainId
    && !!accounting && accounting === builtIn.usageAccountingAddress?.toLowerCase()
    ? builtIn.verificationPointsPolicyAddress ?? null : null;
}

const rateCache = new WeakMap<AntsContext, { address: string; at: number; rates: VerificationRates | null }>();

/** The last policy rates read for this chain; null when never read, unreadable, or no policy is configured. */
export function verificationRates(ctx: AntsContext): VerificationRates | null {
  const address = verificationPolicyAddress(ctx)?.toLowerCase();
  const entry = rateCache.get(ctx);
  return address && entry?.address === address ? entry.rates : null;
}

/**
 * Claim the hourly `bonusBps()` / `penaltyBps()` read. Returns null while the cached rates are
 * fresh (or another view already claimed the read), otherwise a callback taking the two batched
 * results (null = failed). The claim keeps earlier rates visible until the read lands, and the
 * cache lives outside the context memos so refreshes after a transaction do not re-read.
 */
export function claimVerificationRatesRead(ctx: AntsContext, now = Date.now()): ((bonus: unknown[] | null, penalty: unknown[] | null) => void) | null {
  const address = verificationPolicyAddress(ctx)?.toLowerCase();
  if (!address) return null;
  const entry = rateCache.get(ctx);
  if (entry && entry.address === address && now - entry.at < RATES_TTL_MS) return null;
  const claim = { address, at: now, rates: entry?.address === address ? entry.rates : null };
  rateCache.set(ctx, claim);
  return (bonus, penalty) => {
    const b = bonus?.[0], p = penalty?.[0];
    if (rateCache.get(ctx) !== claim) return;
    claim.rates = typeof b === 'bigint' && typeof p === 'bigint' ? { bonusBps: b, penaltyBps: p } : claim.rates;
  };
}

/** Antscan's page for one service of one agent. */
export function verificationServiceUrl(baseUrl: string, agentId: number, serviceHash: string): string {
  return `${baseUrl.replace(/\/$/, '')}/verification-service/${agentId}~${serviceHash.toLowerCase()}`;
}

/** The pool's verification line, or undefined when the seller has no SAME or DIFF verdict. */
export function poolVerification(
  agentId: number,
  verifications: IndexedVerifications,
  rates: VerificationRates | null,
): PoolVerification | undefined {
  const provider = verifications.providers.get(agentId);
  if (!provider || (provider.sameCount === 0 && provider.diffCount === 0)) return undefined;
  const link = (service: { service: string; serviceHash: string }) => ({
    service: service.service,
    url: verificationServiceUrl(verifications.baseUrl, agentId, service.serviceHash),
  });
  return {
    sameCount: provider.sameCount,
    diffCount: provider.diffCount,
    pointsMultiplierBps: rates ? pointsMultiplierBps(provider.sameCount, provider.diffCount, rates) : null,
    sameServices: provider.services.filter(service => service.verdict === 'SAME').map(link),
    diffServices: provider.services.filter(service => service.verdict === 'DIFF').map(link),
  };
}

/** Set `verification` on each view; a missing or failed Antscan read leaves the views untouched. */
export function attachVerification(views: PoolView[], verifications: IndexedVerifications | null, rates: VerificationRates | null): void {
  if (!verifications) return;
  for (const view of views) {
    const verification = poolVerification(view.agentId, verifications, rates);
    if (verification) view.verification = verification;
    else delete view.verification;
  }
}

/** Every provider's verdicts from the indexer, or null when it has none or the read fails. */
export async function loadVerifications(ctx: AntsContext): Promise<IndexedVerifications | null> {
  const indexer = ctx.indexer();
  if (!indexer?.verifications) return null;
  try { return await indexer.verifications(); } catch { return null; }
}
