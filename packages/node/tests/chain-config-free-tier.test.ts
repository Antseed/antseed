import { describe, expect, it } from 'vitest';

import { resolveChainConfig } from '../src/payments/chain-config.js';

const BOARD = '0x04C89607413713Ec9775E14b954286519d836FEf';
const OTHER = '0x1111111111111111111111111111111111111111';

describe('free-tier promise board address (base-local)', () => {
  it('comes with the default stack', () => {
    expect(resolveChainConfig({ chainId: 'base-local' }).freeTierTermsAddress).toBe(BOARD);
    const same = resolveChainConfig({ chainId: 'base-local', emissionsGateAddress: '0x67d269191c92caf3cd7723f116c85e6e9bf55933' });
    expect(same.freeTierTermsAddress).toBe(BOARD);
  });

  it.each([
    'registryContractAddress', 'identityRegistryAddress', 'emissionsGateAddress', 'sellerRegistryAddress', 'usageAccountingAddress',
  ] as const)('is dropped when %s points elsewhere', (key) => {
    expect(resolveChainConfig({ chainId: 'base-local', [key]: OTHER }).freeTierTermsAddress).toBeUndefined();
  });

  it('takes a configured board', () => {
    expect(resolveChainConfig({ chainId: 'base-local', registryContractAddress: OTHER, freeTierTermsAddress: OTHER }).freeTierTermsAddress).toBe(OTHER);
  });

  it('is absent on Base until M004 is recorded', () => {
    expect(resolveChainConfig({ chainId: 'base-mainnet' }).freeTierTermsAddress).toBeUndefined();
  });
});
