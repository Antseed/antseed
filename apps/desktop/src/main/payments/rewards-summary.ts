import type { AntsChainConfig } from '@antseed/ants/service';
import { REWARDS_ERROR_FRESH_MS, REWARDS_FRESH_MS, cachedRead, readKeys } from './read-cache.js';
import { friendlyNetworkError } from '../utils.js';

export type DesktopRewardsSummary = {
  available: boolean;
  pendingAnts: string;
  currentEpoch: number | null;
  transfersEnabled: boolean;
  error: string | null;
};

export const EMPTY_REWARDS_SUMMARY: DesktopRewardsSummary = {
  available: false,
  pendingAnts: '0',
  currentEpoch: null,
  transfersEnabled: false,
  error: null,
};

/**
 * The rewards summary the IPC handler returns, cached per wallet and chain:
 * the home view asks every 3s until the buyer daemon answers, and rewards
 * only change per epoch or after a claim, which invalidates this. A failed
 * read is cached briefly as a summary carrying the user-facing error.
 */
export function cachedBuyerRewardsSummary(
  chain: AntsChainConfig,
  buyerAddress: string,
  read: (chain: AntsChainConfig, buyerAddress: string) => Promise<DesktopRewardsSummary>,
): Promise<DesktopRewardsSummary> {
  return cachedRead(
    readKeys.rewards(buyerAddress, chain.chainId),
    (cached) => (cached?.error ? REWARDS_ERROR_FRESH_MS : REWARDS_FRESH_MS),
    () => read(chain, buyerAddress).catch((err: unknown): DesktopRewardsSummary => (
      { ...EMPTY_REWARDS_SUMMARY, error: friendlyNetworkError(err) }
    )),
  );
}
