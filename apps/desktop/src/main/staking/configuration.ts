import { resolveChainConfig } from '@antseed/node';
import type { AntsChainConfig } from '@antseed/ants';
import { asRecord } from '../utils.js';

/** Resolve only the active VPR config; CLI environment overrides do not select this wallet's network. */
export function resolveStakingChain(config: Record<string, unknown>): AntsChainConfig {
  const overrides = asRecord(asRecord(config.payments).crypto);
  const resolved = resolveChainConfig(overrides);
  if (overrides.chainId && overrides.chainId !== resolved.chainId) {
    throw new Error(`Unsupported staking network: ${String(overrides.chainId)}`);
  }
  return { ...resolved, ...overrides } as AntsChainConfig;
}
