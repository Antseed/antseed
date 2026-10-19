import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeInvite } from '@antseed/node';
import { referralLookups, referralScope, resolveBuyerAttribution } from './referral-state.js';

const REFERRER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const INVITE = { epoch: 42n, index: 7n, r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` };

test('buyer attribution resolves the client agent id from env, config, then chain config', () => {
  const chain = { cli: 11, desktop: 12 };
  const fromEnv = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, clientAgentIds: chain, env: { ANTSEED_CLIENT_AGENT_ID: '7' } });
  assert.equal(BigInt(fromEnv.clientId!), 7n);
  assert.equal(fromEnv.invite, undefined);

  const fromConfig = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, clientAgentIds: chain, env: {} });
  assert.equal(BigInt(fromConfig.clientId!), 5n);

  const cli = resolveBuyerAttribution({ referralState: null, clientAgentIds: chain, env: {} });
  assert.equal(BigInt(cli.clientId!), 11n);
  const desktop = resolveBuyerAttribution({ referralState: null, clientAgentIds: chain, env: { ANTSEED_CLIENT_KIND: 'desktop' } });
  assert.equal(BigInt(desktop.clientId!), 12n);

  const none = resolveBuyerAttribution({ referralState: null, env: {} });
  assert.deepEqual(none, {});
});

test('buyer attribution carries a pending invite until it is bound, keeping the client', () => {
  const invited = resolveBuyerAttribution({ referralState: { state: 'invited', invite: encodeInvite(INVITE), referrer: REFERRER }, clientAgentId: 5, env: {} });
  assert.deepEqual(invited.invite, INVITE);
  assert.equal(BigInt(invited.clientId!), 5n);

  const bound = resolveBuyerAttribution({ referralState: { state: 'bound', referrer: REFERRER }, clientAgentId: 5, env: {} });
  assert.equal(bound.invite, undefined);
  assert.equal(BigInt(bound.clientId!), 5n);
});

test('referral scope and lookups follow the configured referrals contract', async () => {
  assert.equal(referralScope({ evmChainId: 8453 }, REFERRER), null);
  assert.deepEqual(referralScope({ evmChainId: 8453, referralsAddress: REFERRER }, BUYER), { wallet: BUYER, chainId: 8453, referralsAddress: REFERRER });

  assert.deepEqual(referralLookups({ explorerApiUrl: 'https://antscan.example', client: null }), {});
  const noExplorer = referralLookups({ client: { referrerOf: async () => '0x0000000000000000000000000000000000000000' } });
  assert.equal(noExplorer.explorer, null);
  assert.equal(await noExplorer.chain!(BUYER), null);
  const withExplorer = referralLookups({ explorerApiUrl: 'https://antscan.example', client: { referrerOf: async () => REFERRER } });
  assert.equal(typeof withExplorer.explorer, 'function');
  assert.equal(await withExplorer.chain!(BUYER), REFERRER);
});
