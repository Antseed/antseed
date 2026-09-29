import { Interface, isError, ZeroAddress } from 'ethers';
import type { LegacySellerPayout } from '../api-types.js';
import type { AntsContext } from './context.js';

const policyInterface = new Interface(['function canClaimSellerUnlocked(address seller) view returns (bool)']);

export async function legacySellerPayout(ctx: AntsContext, legacyAddress: string | null | undefined): Promise<LegacySellerPayout> {
  try {
    const legacy = ctx.legacyEmissionsAt(legacyAddress ?? null);
    if (!legacy) return { destination: 'unknown', recipient: null };
    const policy = await legacy.sellerUnlockPolicy();
    let unlocked = false;
    if (policy !== ZeroAddress) {
      try {
        const result = await ctx.provider().call({
          from: legacyAddress!, to: policy,
          data: policyInterface.encodeFunctionData('canClaimSellerUnlocked', [ctx.address]),
        });
        unlocked = policyInterface.decodeFunctionResult('canClaimSellerUnlocked', result)[0] === true;
      } catch (error) {
        if (!isError(error, 'CALL_EXCEPTION')) throw error;
      }
    }
    if (unlocked) return { destination: 'wallet', recipient: ctx.address };
    const pool = await legacy.sellerRewardsPool();
    return pool === ZeroAddress ? { destination: 'unknown', recipient: null } : { destination: 'locked', recipient: pool };
  } catch {
    return { destination: 'unknown', recipient: null };
  }
}
