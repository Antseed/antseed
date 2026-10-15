import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearReferralInvite,
  issuedInviteIndices,
  pendingInvite,
  readReferralState,
  recordIssuedInvite,
  saveReferralInvite,
  syncReferralState,
  writeReferralState,
} from '../src/payments/referral-state.js';
import { encodeInvite } from '../src/payments/invites.js';

const REFERRER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const INVITE = { epoch: 42n, index: 7n, r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` };
const ENCODED = encodeInvite(INVITE);

const dirs: string[] = [];
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-referral-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('referral state', () => {
  it('saves a redeemed invite as pending and carries it until bound', async () => {
    const dir = await dataDir();
    expect(await readReferralState(dir)).toBeNull();
    const saved = await saveReferralInvite(dir, ENCODED, REFERRER.toLowerCase());
    expect(saved).toMatchObject({ state: 'invited', invite: ENCODED, referrer: REFERRER });
    expect(saved.updatedAt).toBeTruthy();
    expect(pendingInvite(await readReferralState(dir))).toEqual(INVITE);
    expect(pendingInvite({ state: 'bound', referrer: REFERRER, invite: ENCODED })).toBeNull();
    expect(pendingInvite({ state: 'invited', invite: 'garbage' })).toBeNull();
    expect(pendingInvite(null)).toBeNull();
  });

  it('records the binding Antscan reports and stops carrying the invite', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, ENCODED, REFERRER);
    expect(await syncReferralState(dir, BUYER, async () => undefined)).toMatchObject({ state: 'invited' });
    expect(await syncReferralState(dir, BUYER, async () => null)).toMatchObject({ state: 'invited' });
    expect(await syncReferralState(dir, BUYER, async () => { throw new Error('offline'); })).toMatchObject({ state: 'invited' });
    const bound = await syncReferralState(dir, BUYER, async () => REFERRER.toLowerCase());
    expect(bound).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect(bound?.invite).toBeUndefined();
    expect(pendingInvite(await readReferralState(dir))).toBeNull();
  });

  it('only asks Antscan while an invite is pending', async () => {
    const dir = await dataDir();
    await writeReferralState(dir, { state: 'none' });
    let calls = 0;
    await syncReferralState(dir, BUYER, async () => { calls += 1; return REFERRER; });
    expect(calls).toBe(0);
  });

  it('never replaces a binding', async () => {
    const dir = await dataDir();
    await writeReferralState(dir, { state: 'bound', referrer: REFERRER });
    expect(await saveReferralInvite(dir, ENCODED, BUYER)).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect(await clearReferralInvite(dir)).toMatchObject({ state: 'bound', referrer: REFERRER });
  });

  it('clears a pending invite', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, ENCODED, REFERRER);
    expect(await clearReferralInvite(dir)).toMatchObject({ state: 'none' });
  });

  it('remembers invites handed out in the latest epoch only', async () => {
    const dir = await dataDir();
    await recordIssuedInvite(dir, 30, 0);
    await recordIssuedInvite(dir, 30, 1);
    expect(issuedInviteIndices(await readReferralState(dir), 30)).toEqual([0, 1]);
    await saveReferralInvite(dir, ENCODED, REFERRER);
    expect(issuedInviteIndices(await readReferralState(dir), 30)).toEqual([0, 1]);
    await recordIssuedInvite(dir, 31, 0);
    const state = await readReferralState(dir);
    expect(issuedInviteIndices(state, 30)).toEqual([]);
    expect(issuedInviteIndices(state, 31)).toEqual([0]);
    expect(state?.state).toBe('invited');
  });

  it('ignores files from the retired network-matching design', async () => {
    const dir = await dataDir();
    await writeReferralState(dir, { state: 'accepted' as never, referrer: REFERRER });
    expect(await readReferralState(dir)).toBeNull();
  });
});
