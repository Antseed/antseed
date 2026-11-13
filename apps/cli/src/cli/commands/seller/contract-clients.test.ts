import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyEmissionsClient, createLegacyStakingClient, requireCryptoConfig } from '../../payment-utils.js';
import type { AntseedConfig } from '../../../config/types.js';

const address = '0x0000000000000000000000000000000000000011';

test('CLI local defaults use the registry nonce rather than the token nonce and preserve overrides', () => {
  const base = { payments: { crypto: { chainId: 'base-local' } } } as AntseedConfig;
  assert.equal(requireCryptoConfig(base).registryContractAddress, '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9');
  assert.equal(requireCryptoConfig({ ...base, payments: { ...base.payments, crypto: { ...base.payments!.crypto!, registryContractAddress: address } } }).registryContractAddress, address);
});

test('legacy factories use V2 and USDC staking with the active mainnet ledger', () => {
  const config = { payments: { crypto: { chainId: 'base-mainnet', rpcUrl: 'http://127.0.0.1:1' } } } as AntseedConfig;
  const chain = requireCryptoConfig(config);
  const emissions = createLegacyEmissionsClient(config);
  const staking = createLegacyStakingClient(config);
  try {
    assert.equal(emissions.contractAddress, chain.legacyEmissionsContractAddress);
    assert.notEqual(emissions.contractAddress, chain.emissionsContractAddress);
    assert.equal(staking.contractAddress, chain.legacyStakingContractAddress);
    assert.notEqual(staking.contractAddress, chain.stakingContractAddress);
  } finally {
    emissions.provider.destroy();
    staking.provider.destroy();
  }
});

test('legacy factories preserve the active ledger legacy overrides', () => {
  const usage = '0x0000000000000000000000000000000000000021';
  const registry = '0x0000000000000000000000000000000000000022';
  const config = { payments: { crypto: {
    chainId: 'base-local', rpcUrl: 'http://127.0.0.1:1',
    emissionsContractAddress: usage, usageAccountingAddress: usage,
    stakingContractAddress: registry, sellerRegistryAddress: registry,
    legacyEmissionsContractAddress: address, legacyStakingContractAddress: address,
  } } } as AntseedConfig;
  const emissions = createLegacyEmissionsClient(config);
  const staking = createLegacyStakingClient(config);
  try {
    assert.equal(emissions.contractAddress, address);
    assert.equal(staking.contractAddress, address);
  } finally {
    emissions.provider.destroy();
    staking.provider.destroy();
  }
});
