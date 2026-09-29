/** Run with Electron after building ants and desktop main. Uses only an existing local Anvil sandbox. */
import { app, shell, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { identityFromPrivateKeyHex } from '@antseed/node';
import { StakingSessionManager } from '../dist/main/staking/session.js';

async function main() {
  await app.whenReady();
  app.setAccessibilitySupportEnabled(true);
  const dataDir = process.argv[process.argv.indexOf('--data-dir') + 1];
  if (!process.argv.includes('--data-dir') || !dataDir) throw new Error('Pass --data-dir pointing to a running ants-sandbox directory.');
  const { payments: { crypto: chain } } = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(chain.evmChainId, 31337, 'This test only accepts Anvil chain 31337.');
  assert.equal(chain.chainId, 'base-local');
  const rpc = new URL(chain.rpcUrl);
  assert.equal(rpc.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname), 'RPC must be local.');
  assert.deepEqual(chain.fallbackRpcUrls, [], 'Public fallback RPCs must be disabled.');
  assert.equal(chain.explorerApiUrl, '', 'Production indexer must be disabled.');
  const response = await fetch(chain.rpcUrl, {
    signal: AbortSignal.timeout(5000),
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  assert.equal(Number((await response.json()).result), 31337);
  const scenario = JSON.parse(await readFile(path.join(dataDir, 'scenario.json'), 'utf8'));
  const identity = identityFromPrivateKeyHex((await readFile(path.join(dataDir, 'identity.key'), 'utf8')).trim());
  const temporary = await mkdtemp(path.join(tmpdir(), 'vpr-staking-smoke-'));
  app.setPath('userData', temporary);
  const bundleIndex = process.argv.indexOf('--bundle');
  const modulePath = bundleIndex < 0
    ? new URL('../dist/main/staking/window.js', import.meta.url).href
    : pathToFileURL(path.join(process.argv[bundleIndex + 1], 'dist/main/staking/window.js')).href;
  const { createStakingWindowSession } = await import(modulePath);
  let completions = 0;
  const manager = new StakingSessionManager(() => createStakingWindowSession({
    chain, signer: identity.wallet, address: scenario.buyerAddress, dataDir: temporary,
    onActionFinished() { console.log(`Action completed (${++completions}); host refresh callback received.`); },
  }, () => null));
  const launched = [];
  const originalOpenExternal = shell.openExternal;
  shell.openExternal = async (url) => { launched.push(url); };
  try {
    await Promise.all([manager.open('rewards'), manager.open('stake')]);
    assert.equal(BrowserWindow.getAllWindows().length, 0, 'Staking must not create an Electron window');
    assert.equal(launched.length, 2);
    assert.equal(new URL(launched[0]).origin, new URL(launched[1]).origin, 'Both destinations reuse the local server session');
    assert.equal(new URLSearchParams(new URL(launched[0]).hash.slice(1)).get('page'), 'rewards');
    assert.equal(new URLSearchParams(new URL(launched[1]).hash.slice(1)).get('page'), 'stake');
    const url = new URL(launched[0]);
    assert.equal(url.hostname, '127.0.0.1');
    assert.notEqual(url.port, '0');
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    const response = await fetch(`${url.origin}/api/config`, { headers: { Authorization: `Bearer ${token}` } });
    const { data } = await response.json();
    assert.equal(data.browserWallet, true);
    assert.equal(data.readOnly, true, 'No transaction signer until a browser wallet connects');
    assert.equal(data.buyerAddress, scenario.buyerAddress);
    assert.equal(data.evmChainId, 31337);
    const rewardResponse = await fetch(`${url.origin}/api/rewards`, { headers: { Authorization: `Bearer ${token}` } });
    const { data: rewardView } = await rewardResponse.json();
    const { readBuyerRewardsSummary } = await import('../dist/main/staking/buyer-rewards.js');
    const { parseUnits } = await import('ethers');
    const summary = await readBuyerRewardsSummary(chain, scenario.buyerAddress);
    assert.equal(parseUnits(summary.pendingAnts, 18), BigInt(rewardView.buyerUsage.total) + BigInt(rewardView.legacy.buyer));
    assert.equal(summary.transfersEnabled, false);
    console.log('PASS: VPR reward summary matches the disconnected dashboard buyer balance.');
    console.log('PASS: system-browser launcher, reused authenticated localhost session, no Electron staking window, no local signer.');
    if (process.argv.includes('--open')) await originalOpenExternal(launched[0]);
    else { await manager.stop(); app.exit(0); }
    process.on('SIGTERM', () => { void manager.stop().finally(() => app.exit(0)); });
  } finally { shell.openExternal = originalOpenExternal; }


}
void main().catch((error) => { console.error(error); app.exit(1); });
