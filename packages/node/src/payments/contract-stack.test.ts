import { describe, expect, it } from 'vitest';
import type { ChainConfig } from './chain-config.js';
import {
  ContractStackMismatchError,
  legacyEpochs,
  newEpochs,
  resolveContractStack,
  resolveLegacyContractAddresses,
} from './contract-stack.js';

const legacyEmissions = '0x0000000000000000000000000000000000000011';
const legacyStaking = '0x0000000000000000000000000000000000000012';
const usageAccounting = '0x0000000000000000000000000000000000000021';
const sellerRegistry = '0x0000000000000000000000000000000000000022';

function config(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId: 'base-mainnet', evmChainId: 8453, rpcUrl: 'http://rpc',
    registryContractAddress: '0x0000000000000000000000000000000000000001',
    depositsContractAddress: '0x0000000000000000000000000000000000000002',
    channelsContractAddress: '0x0000000000000000000000000000000000000003',
    usdcContractAddress: '0x0000000000000000000000000000000000000004',
    emissionsContractAddress: legacyEmissions,
    stakingContractAddress: legacyStaking,
    ...overrides,
  };
}

describe('resolveContractStack', () => {
  it('resolves legacy mode', async () => {
    const result = await resolveContractStack(config(), {
      registryClient: { emissions: async () => legacyEmissions, staking: async () => legacyStaking },
      legacyEmissionsClient: { getEpochInfo: async () => ({ epoch: 7 }) },
    });
    expect(result.mode).toBe('legacy');
    expect(result.currentEpoch).toBe(7);
  });

  it('resolves recognized usage and honors overrides', async () => {
    const result = await resolveContractStack(config({ usageAccountingAddress: usageAccounting, sellerRegistryAddress: sellerRegistry }), {
      registryClient: { emissions: async () => usageAccounting, staking: async () => sellerRegistry },
      usageAccountingClient: { currentEpoch: async () => 12, firstRewardedEpoch: async () => 9 },
    });
    expect(result).toMatchObject({ mode: 'recognized-usage', currentEpoch: 12, firstRewardedEpoch: 9 });
    expect(result.addresses.usageAccountingAddress).toBe(usageAccounting);
    expect(result.addresses.legacyEmissionsContractAddress).toBe(legacyEmissions);
    expect(result.addresses.legacyStakingContractAddress).toBe(legacyStaking);
  });

  it('resolves legacy mode while recognized contracts are deployed but inactive', async () => {
    const result = await resolveContractStack(config({ usageAccountingAddress: usageAccounting, sellerRegistryAddress: sellerRegistry }), {
      registryClient: { emissions: async () => legacyEmissions, staking: async () => legacyStaking },
      legacyEmissionsClient: { getEpochInfo: async () => ({ epoch: 7 }) },
    });
    expect(result.mode).toBe('legacy');
    expect(result.currentEpoch).toBe(7);
  });

  it('keeps V1 separate from V2 before the deployment ledger is regenerated', () => {
    const oldest = '0x0000000000000000000000000000000000000031';
    expect(resolveLegacyContractAddresses(config({ usageAccountingAddress: usageAccounting, sellerRegistryAddress: sellerRegistry, legacyEmissionsContractAddress: oldest })))
      .toEqual({ legacyEmissionsContractAddress: legacyEmissions, legacyStakingContractAddress: legacyStaking, legacyEmissionsV1ContractAddress: oldest });
  });

  it('preserves explicit legacy addresses after the active ledger is regenerated', async () => {
    const active = config({
      emissionsContractAddress: usageAccounting, stakingContractAddress: sellerRegistry,
      usageAccountingAddress: usageAccounting, sellerRegistryAddress: sellerRegistry,
      legacyEmissionsContractAddress: legacyEmissions, legacyStakingContractAddress: legacyStaking,
      legacyEmissionsV1ContractAddress: '0x0000000000000000000000000000000000000031',
    });
    const result = await resolveContractStack(active, {
      registryClient: { emissions: async () => usageAccounting, staking: async () => sellerRegistry },
      usageAccountingClient: { currentEpoch: async () => 12, firstRewardedEpoch: async () => 9 },
    });
    expect(result.addresses.legacyEmissionsContractAddress).toBe(legacyEmissions);
    expect(result.addresses.legacyStakingContractAddress).toBe(legacyStaking);
    expect(result.addresses.legacyEmissionsV1ContractAddress).toBe(active.legacyEmissionsV1ContractAddress);
  });

  it.each([
    ['mismatch', usageAccounting, legacyStaking],
    ['zero emissions', '0x0000000000000000000000000000000000000000', legacyStaking],
    ['mixed stack', usageAccounting, legacyStaking],
  ])('rejects %s', async (_name, emissions, staking) => {
    await expect(resolveContractStack(config({ usageAccountingAddress: usageAccounting, sellerRegistryAddress: sellerRegistry }), {
      registryClient: { emissions: async () => emissions, staking: async () => staking },
    })).rejects.toBeInstanceOf(ContractStackMismatchError);
  });

  it('wraps RPC errors', async () => {
    await expect(resolveContractStack(config(), {
      registryClient: { emissions: async () => { throw new Error('offline'); }, staking: async () => legacyStaking },
    })).rejects.toThrow('offline');
  });

  it('rejects missing registry configuration', async () => {
    await expect(resolveContractStack(config({ registryContractAddress: undefined }))).rejects.toBeInstanceOf(ContractStackMismatchError);
  });
});

describe('epoch ranges', () => {
  it('splits legacy and new epochs at cutover', () => {
    expect(legacyEpochs(8, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(newEpochs(8, 5)).toEqual([5, 6, 7]);
  });
});
