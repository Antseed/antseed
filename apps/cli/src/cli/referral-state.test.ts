import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeInvite } from '@antseed/node';
import { resolveBuyerAttribution } from './referral-state.js';

const REFERRER = '0x1111111111111111111111111111111111111111';
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
