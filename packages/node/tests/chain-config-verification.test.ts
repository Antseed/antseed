import { describe, expect, it, vi } from 'vitest';

const KBF = '0x1111111111111111111111111111111111111111';
const RESULTS = '0x2222222222222222222222222222222222222222';
const OTHER_KBF = '0x3333333333333333333333333333333333333333';
const OTHER_RESULTS = '0x4444444444444444444444444444444444444444';

// Once the split release is recorded, the generated inventory carries a KBF + results pair.
vi.mock('../src/payments/generated-contract-addresses.js', () => ({
  DEPLOYED_CONTRACT_ADDRESSES: {
    'base-mainnet': { verificationContractAddress: KBF, verificationResultsAddress: RESULTS },
    'base-sepolia': {},
  },
}));

const { resolveChainConfig } = await import('../src/payments/chain-config.js');

describe('verification address pairing', () => {
  it('keeps the default pair together', () => {
    expect(resolveChainConfig({ chainId: 'base-mainnet' })).toMatchObject({
      verificationContractAddress: KBF, verificationResultsAddress: RESULTS,
    });
    const sameKbf = resolveChainConfig({ chainId: 'base-mainnet', verificationContractAddress: KBF.toUpperCase().replace('0X', '0x') });
    expect(sameKbf.verificationResultsAddress).toBe(RESULTS);
  });

  it('drops the default results address when another KBF contract is configured without one', () => {
    const config = resolveChainConfig({ chainId: 'base-mainnet', verificationContractAddress: OTHER_KBF });
    expect(config.verificationContractAddress).toBe(OTHER_KBF);
    expect(config.verificationResultsAddress).toBeUndefined();
  });

  it('uses an explicitly paired results address', () => {
    const config = resolveChainConfig({
      chainId: 'base-mainnet', verificationContractAddress: OTHER_KBF, verificationResultsAddress: OTHER_RESULTS,
    });
    expect(config.verificationResultsAddress).toBe(OTHER_RESULTS);
  });
});
