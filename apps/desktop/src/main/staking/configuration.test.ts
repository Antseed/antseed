import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStakingChain } from './configuration.js';

test('local Anvil retains its chain ID, contract overrides and empty indexer/fallbacks', () => {
  const overrides = { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:8545', fallbackRpcUrls: [], explorerApiUrl: '', sellerPoolsAddress: '0x1111111111111111111111111111111111111111' };
  const chain = resolveStakingChain({ payments: { crypto: overrides } });
  for (const [key, value] of Object.entries(overrides)) assert.deepEqual(chain[key as keyof typeof chain], value);
});

test('a selected RPC has no public fallback and a misspelled network fails closed', () => {
  const chain = resolveStakingChain({ payments: { crypto: { chainId: 'base-mainnet', rpcUrl: 'http://127.0.0.1:8545' } } });
  assert.deepEqual(chain.fallbackRpcUrls, []);
  assert.throws(() => resolveStakingChain({ payments: { crypto: { chainId: 'base-typo' } } }), /Unsupported staking network/);
});
