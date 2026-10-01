import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pendingReferrer,
  readReferralState,
  resolveBuyerAttribution,
  writeReferralState,
} from './referral-state.js';

const REFERRER = '0x1111111111111111111111111111111111111111';

test('referral state round-trips through the data dir', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-referral-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  assert.equal(await readReferralState(dataDir), null);
  await writeReferralState(dataDir, { state: 'accepted', referrer: REFERRER });
  const stored = await readReferralState(dataDir);
  assert.equal(stored?.state, 'accepted');
  assert.equal(stored?.referrer, REFERRER);
  assert.ok(stored?.updatedAt);
});

test('only accepted referrals are carried as pending referrers', () => {
  assert.equal(pendingReferrer({ state: 'accepted', referrer: REFERRER }), REFERRER);
  assert.equal(pendingReferrer({ state: 'candidate', referrer: REFERRER }), null);
  assert.equal(pendingReferrer({ state: 'bound', referrer: REFERRER }), null);
  assert.equal(pendingReferrer({ state: 'declined' }), null);
  assert.equal(pendingReferrer({ state: 'accepted', referrer: 'not-an-address' }), null);
  assert.equal(pendingReferrer(null), null);
});

test('buyer attribution resolves the client agent id from env, config, then chain config', () => {
  const chain = { cli: 11, desktop: 12 };
  const fromEnv = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, clientAgentIds: chain, env: { ANTSEED_CLIENT_AGENT_ID: '7' } });
  assert.equal(BigInt(fromEnv.clientId!), 7n);
  assert.equal(fromEnv.referrer, undefined);

  const fromConfig = resolveBuyerAttribution({ referralState: { state: 'accepted', referrer: REFERRER }, clientAgentId: 5, clientAgentIds: chain, env: {} });
  assert.equal(BigInt(fromConfig.clientId!), 5n);
  assert.equal(fromConfig.referrer, REFERRER);

  const cli = resolveBuyerAttribution({ referralState: null, clientAgentIds: chain, env: {} });
  assert.equal(BigInt(cli.clientId!), 11n);
  const desktop = resolveBuyerAttribution({ referralState: null, clientAgentIds: chain, env: { ANTSEED_CLIENT_KIND: 'desktop' } });
  assert.equal(BigInt(desktop.clientId!), 12n);

  const none = resolveBuyerAttribution({ referralState: null, env: {} });
  assert.equal(none.clientId, undefined);
});
