import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBytes32String } from 'ethers';
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

test('buyer attribution resolves the client label from env, config, then default', () => {
  const fromEnv = resolveBuyerAttribution({ referralState: null, clientLabel: 'custom', env: { ANTSEED_CLIENT_ID: 'antseed-desktop' } });
  assert.equal(decodeBytes32String(fromEnv.clientId), 'antseed-desktop');
  assert.equal(fromEnv.referrer, undefined);

  const fromConfig = resolveBuyerAttribution({ referralState: { state: 'accepted', referrer: REFERRER }, clientLabel: 'custom', env: {} });
  assert.equal(decodeBytes32String(fromConfig.clientId), 'custom');
  assert.equal(fromConfig.referrer, REFERRER);

  const fallback = resolveBuyerAttribution({ referralState: null, env: {} });
  assert.equal(decodeBytes32String(fallback.clientId), 'antseed-cli');
});
