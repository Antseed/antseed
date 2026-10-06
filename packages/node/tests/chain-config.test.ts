import { describe, expect, it } from 'vitest';
import { getChainConfig, resolveChainConfig } from '../src/payments/chain-config.js';
import { DEPLOYED_CONTRACT_ADDRESSES } from '../src/payments/generated-contract-addresses.js';

describe('recognized-usage deployment configuration', () => {
  it('exposes the generated inventory separately from active endpoints', () => {
    const config = getChainConfig('base-mainnet');
    const generated = DEPLOYED_CONTRACT_ADDRESSES['base-mainnet'];
    expect(config.recognizedUsage).toEqual(generated.recognizedUsage);
    expect(config.recognizedUsage?.contracts.emissionsGate).toBeDefined();
    expect(config.registryContractAddress).toBe(generated.registryContractAddress);
    expect(config.emissionsContractAddress).toBe(generated.emissionsContractAddress);
    expect(config.stakingContractAddress).toBe(generated.stakingContractAddress);
    expect(config.recognizedUsage?.status).toBe('active');
    expect(config.emissionsContractAddress).toBe(config.recognizedUsage?.contracts.usageAccounting);
    expect(config.stakingContractAddress).toBe(config.recognizedUsage?.contracts.sellerRegistry);
    expect(config.legacyEmissionsContractAddress).toBe('0xF13bE52c4A3afC6AE29536f073588d01A0564088');
    expect(config.legacyStakingContractAddress).toBe('0x3652E6B22919bd322A25723B94BB207602E5c8e6');
    expect(config.legacyEmissionsV1ContractAddress).toBe('0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5');
  });

  it('preserves inventory when overriding an RPC endpoint', () => {
    const config = resolveChainConfig({ chainId: 'base-mainnet', rpcUrl: 'http://localhost:8545' });
    expect(config.recognizedUsage).toEqual(getChainConfig('base-mainnet').recognizedUsage);
    expect(config.rpcUrl).toBe('http://localhost:8545');
    expect(config.fallbackRpcUrls).toEqual([]);
  });

  it('does not expose mainnet deployment metadata for local chains', () => {
    expect(getChainConfig('base-local').recognizedUsage).toBeUndefined();
  });
});
