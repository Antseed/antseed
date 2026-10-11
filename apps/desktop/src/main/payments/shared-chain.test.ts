import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DepositsClient } from '@antseed/node';

// Point the active config at a single local endpoint before the modules read it.
const dir = mkdtempSync(path.join(tmpdir(), 'vpr-shared-chain-'));
const configPath = path.join(dir, 'config.json');
const LOCAL = 'http://127.0.0.1:1';
writeFileSync(configPath, JSON.stringify({ payments: { crypto: { chainId: 'base-local', rpcUrl: LOCAL } } }));
process.env['ANTSEED_CONFIG_PATH'] = configPath;

const { sharedChainContext, sharedChainProvider, resetSharedChain, withSharedProvider } = await import('./shared-chain.js');
const { resolveStakingChain } = await import('../staking/configuration.js');

const chain = resolveStakingChain({ payments: { crypto: { chainId: 'base-local', rpcUrl: LOCAL } } });

test('every caller shares one context and one provider until reset', async () => {
  resetSharedChain();
  const first = await sharedChainContext(chain);
  assert.equal(await sharedChainContext({ ...chain }), first);
  const provider = await sharedChainProvider({ rpcUrl: LOCAL, fallbackRpcUrls: [], chainId: chain.evmChainId });
  assert.equal(provider, first.provider());

  resetSharedChain();
  const second = await sharedChainContext(chain);
  assert.notEqual(second, first);
  assert.notEqual(second.provider(), first.provider());
});

test('a different config builds a new context', async () => {
  resetSharedChain();
  const first = await sharedChainContext(chain);
  const other = await sharedChainContext({ ...chain, rpcUrl: 'http://127.0.0.1:2' });
  assert.notEqual(other, first);
});

test('clients on other endpoints keep their own provider', async () => {
  resetSharedChain();
  assert.equal(await sharedChainProvider({ rpcUrl: 'http://127.0.0.1:2', chainId: chain.evmChainId }), null);
  assert.equal(await sharedChainProvider({ rpcUrl: LOCAL, chainId: 1 }), null);

  const config = { rpcUrl: LOCAL, contractAddress: '0x0000000000000000000000000000000000000001', usdcAddress: '0x0000000000000000000000000000000000000002', evmChainId: chain.evmChainId };
  const shared = await withSharedProvider(new DepositsClient(config), { rpcUrl: LOCAL, chainId: chain.evmChainId });
  assert.equal(shared.provider, (await sharedChainContext(chain)).provider());
  const own = new DepositsClient({ ...config, rpcUrl: 'http://127.0.0.1:2' });
  const ownProvider = own.provider;
  assert.equal((await withSharedProvider(own, { rpcUrl: 'http://127.0.0.1:2', chainId: chain.evmChainId })).provider, ownProvider);
});
