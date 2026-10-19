import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearReferralInvite,
  issuedInviteIndices,
  pendingInvite,
  readReferralState,
  recordIssuedInvite,
  saveReferralInvite,
  syncReferralState,
  takeOverStaleLock,
  updateReferralState,
  withIssuedInvite,
  writeReferralState,
} from '../src/payments/referral-state.js';
import { encodeInvite, signInvite } from '../src/payments/invites.js';

const REFERRER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const INVITE = { epoch: 42n, index: 7n, r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` };
const ENCODED = encodeInvite(INVITE);
const SCOPE = { chainId: 8453, referralsAddress: '0x3333333333333333333333333333333333333333' };
const OTHER_SCOPE = { chainId: 84532, referralsAddress: '0x4444444444444444444444444444444444444444' };
const ZERO = '0x0000000000000000000000000000000000000000';

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
    expect(await readReferralState(dir, SCOPE)).toBeNull();
    const saved = await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER.toLowerCase());
    expect(saved).toMatchObject({ state: 'invited', invite: ENCODED, referrer: REFERRER });
    expect(saved.updatedAt).toBeTruthy();
    expect(pendingInvite(await readReferralState(dir, SCOPE))).toEqual(INVITE);
    expect(pendingInvite({ state: 'bound', referrer: REFERRER, invite: ENCODED })).toBeNull();
    expect(pendingInvite({ state: 'invited', invite: 'garbage' })).toBeNull();
    expect(pendingInvite(null)).toBeNull();
  });

  it('records a binding once the contract confirms what Antscan reports', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    const onChain = async () => REFERRER.toLowerCase();
    expect(await syncReferralState(dir, SCOPE, BUYER, async () => undefined, onChain)).toMatchObject({ state: 'invited' });
    expect(await syncReferralState(dir, SCOPE, BUYER, async () => null, onChain)).toMatchObject({ state: 'invited' });
    expect(await syncReferralState(dir, SCOPE, BUYER, async () => { throw new Error('offline'); }, onChain)).toMatchObject({ state: 'invited' });
    const bound = await syncReferralState(dir, SCOPE, BUYER, async () => REFERRER.toLowerCase(), onChain);
    expect(bound).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect(bound?.invite).toBeUndefined();
    expect(pendingInvite(await readReferralState(dir, SCOPE))).toBeNull();
  });

  it('keeps the invite pending when Antscan reports a binding the contract does not', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    const explorer = async () => REFERRER;
    expect(await syncReferralState(dir, SCOPE, BUYER, explorer, async () => ZERO)).toMatchObject({ state: 'invited', invite: ENCODED });
    expect(await syncReferralState(dir, SCOPE, BUYER, explorer, async () => { throw new Error('rpc down'); })).toMatchObject({ state: 'invited' });
    expect(await syncReferralState(dir, SCOPE, BUYER, explorer, null)).toMatchObject({ state: 'invited' });
    expect(pendingInvite(await readReferralState(dir, SCOPE))).toEqual(INVITE);
  });

  it('asks the contract directly without an explorer', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    expect(await syncReferralState(dir, SCOPE, BUYER, null, async () => REFERRER)).toMatchObject({ state: 'bound', referrer: REFERRER });
  });

  it('only asks while an invite is pending', async () => {
    const dir = await dataDir();
    await writeReferralState(dir, SCOPE, { state: 'none' });
    let calls = 0;
    const count = async () => { calls += 1; return REFERRER; };
    await syncReferralState(dir, SCOPE, BUYER, count, count);
    expect(calls).toBe(0);
  });

  it('keeps writes made while a binding was being checked', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    const bound = await syncReferralState(dir, SCOPE, BUYER, null, async () => {
      await recordIssuedInvite(dir, SCOPE, 30, 4);
      return REFERRER;
    });
    expect(bound).toMatchObject({ state: 'bound', issued: { epoch: 30, indices: [4] } });
    expect(issuedInviteIndices(await readReferralState(dir, SCOPE), 30)).toEqual([4]);
  });

  it('never replaces a binding', async () => {
    const dir = await dataDir();
    await writeReferralState(dir, SCOPE, { state: 'bound', referrer: REFERRER });
    expect(await saveReferralInvite(dir, SCOPE, ENCODED, BUYER)).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect(await clearReferralInvite(dir, SCOPE)).toMatchObject({ state: 'bound', referrer: REFERRER });
  });

  it('clears a pending invite', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    expect(await clearReferralInvite(dir, SCOPE)).toMatchObject({ state: 'none' });
  });

  it('remembers invites handed out in the latest epoch only', async () => {
    const dir = await dataDir();
    await recordIssuedInvite(dir, SCOPE, 30, 0);
    await recordIssuedInvite(dir, SCOPE, 30, 1);
    expect(issuedInviteIndices(await readReferralState(dir, SCOPE), 30)).toEqual([0, 1]);
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    expect(issuedInviteIndices(await readReferralState(dir, SCOPE), 30)).toEqual([0, 1]);
    await recordIssuedInvite(dir, SCOPE, 31, 0);
    const state = await readReferralState(dir, SCOPE);
    expect(issuedInviteIndices(state, 30)).toEqual([]);
    expect(issuedInviteIndices(state, 31)).toEqual([0]);
    expect(state?.state).toBe('invited');
  });

  it('ignores files from the retired network-matching design', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'referral.json'), JSON.stringify({ state: 'accepted', referrer: REFERRER }));
    expect(await readReferralState(dir, SCOPE)).toBeNull();
  });

  it('keeps each deployment separate in one data dir', async () => {
    const dir = await dataDir();
    await writeReferralState(dir, SCOPE, { state: 'bound', referrer: REFERRER });
    await recordIssuedInvite(dir, SCOPE, 30, 2);
    expect(await readReferralState(dir, OTHER_SCOPE)).toBeNull();
    expect(await saveReferralInvite(dir, OTHER_SCOPE, ENCODED, REFERRER)).toMatchObject({ state: 'invited', invite: ENCODED });
    expect(issuedInviteIndices(await readReferralState(dir, OTHER_SCOPE), 30)).toEqual([]);
    expect(await readReferralState(dir, SCOPE)).toMatchObject({ state: 'bound', referrer: REFERRER, issued: { epoch: 30, indices: [2] } });
    // Scope keys ignore address casing.
    expect(await readReferralState(dir, { ...SCOPE, referralsAddress: SCOPE.referralsAddress.toUpperCase().replace('0X', '0x') })).toMatchObject({ state: 'bound' });
  });

  it('adopts a pre-scoped pending invite only into the deployment that signed it', async () => {
    const dir = await dataDir();
    const referrer = Wallet.createRandom();
    const signed = encodeInvite(await signInvite(referrer, SCOPE, 30, 1));
    await writeFile(join(dir, 'referral.json'), JSON.stringify({ state: 'invited', invite: signed, referrer: referrer.address }));
    expect(await readReferralState(dir, OTHER_SCOPE)).toBeNull();
    expect(await readReferralState(dir, SCOPE)).toMatchObject({ state: 'invited', invite: signed, referrer: referrer.address });
    await recordIssuedInvite(dir, OTHER_SCOPE, 30, 0);
    expect(await readReferralState(dir, SCOPE)).toMatchObject({ state: 'invited', invite: signed });
    await recordIssuedInvite(dir, SCOPE, 30, 3);
    const file = JSON.parse(await readFile(join(dir, 'referral.json'), 'utf8'));
    expect(file.legacy).toBeUndefined();
    expect(await readReferralState(dir, SCOPE)).toMatchObject({ state: 'invited', invite: signed, issued: { epoch: 30, indices: [3] } });
  });

  it('never treats a pre-scoped binding as bound on any deployment', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'referral.json'), JSON.stringify({ state: 'bound', referrer: REFERRER }));
    expect(await readReferralState(dir, SCOPE)).toBeNull();
    expect(await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER)).toMatchObject({ state: 'invited' });
  });

  it('serializes concurrent writers without losing updates', async () => {
    const dir = await dataDir();
    await Promise.all(Array.from({ length: 20 }, (_, index) => recordIssuedInvite(dir, SCOPE, 30, index)));
    expect(issuedInviteIndices(await readReferralState(dir, SCOPE), 30)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('allocates a single remaining slot to exactly one of two concurrent issuers', async () => {
    const dir = await dataDir();
    await recordIssuedInvite(dir, SCOPE, 30, 0);
    const allocate = () => {
      let index: number | null = null;
      return updateReferralState(dir, SCOPE, async (current) => {
        const taken = issuedInviteIndices(current, 30);
        if (taken.includes(1)) return null;
        await new Promise((resolve) => setTimeout(resolve, 20));
        index = 1;
        return withIssuedInvite(current, 30, 1);
      }).then(() => index);
    };
    const results = await Promise.all([allocate(), allocate()]);
    expect(results.filter((index) => index === 1)).toHaveLength(1);
  });

  it('waits for another process holding the lock and takes over a stale one', async () => {
    const dir = await dataDir();
    const lock = join(dir, 'referral.json.lock');
    await writeFile(lock, '1\n');
    let done = false;
    const write = recordIssuedInvite(dir, SCOPE, 30, 0).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);
    await rm(lock);
    await write;
    expect(issuedInviteIndices(await readReferralState(dir, SCOPE), 30)).toEqual([0]);

    await writeFile(lock, '1\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await recordIssuedInvite(dir, SCOPE, 30, 1);
    expect(issuedInviteIndices(await readReferralState(dir, SCOPE), 30)).toEqual([0, 1]);
    await expect(access(lock)).rejects.toThrow();
  });

  // Fresh module instances share no in-process queue, so they contend on the
  // lock file exactly as separate CLI, Desktop and daemon processes do.
  async function separateWriter(): Promise<typeof import('../src/payments/referral-state.js')> {
    vi.resetModules();
    return import('../src/payments/referral-state.js');
  }

  it('lets exactly one of two writers recovering the same stale lock take the last slot', async () => {
    const dir = await dataDir();
    const lock = join(dir, 'referral.json.lock');
    for (let round = 0; round < 5; round += 1) {
      await rm(join(dir, 'referral.json'), { force: true });
      await recordIssuedInvite(dir, SCOPE, 30, 0);
      await writeFile(lock, 'crashed-holder\n');
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      const writers = await Promise.all([separateWriter(), separateWriter()]);
      const allocate = (writer: (typeof writers)[number]) => {
        let won = false;
        return writer.updateReferralState(dir, SCOPE, async (current) => {
          if (writer.issuedInviteIndices(current, 30).includes(1)) return null;
          await new Promise((resolve) => setTimeout(resolve, 15));
          won = true;
          return writer.withIssuedInvite(current, 30, 1);
        }).then(() => won);
      };
      const results = await Promise.all(writers.map(allocate));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(issuedInviteIndices(await readReferralState(dir, SCOPE), 30)).toEqual([0, 1]);
      await expect(access(lock)).rejects.toThrow();
    }
  });

  it('keeps every update from writers in separate processes', async () => {
    const dir = await dataDir();
    const writers = await Promise.all([separateWriter(), separateWriter(), separateWriter()]);
    await Promise.all(Array.from({ length: 15 }, (_, index) => writers[index % 3]!.recordIssuedInvite(dir, SCOPE, 30, index)));
    expect(issuedInviteIndices(await readReferralState(dir, SCOPE), 30)).toEqual(Array.from({ length: 15 }, (_, index) => index));
  });

  it('never removes a lock another holder now owns', async () => {
    const dir = await dataDir();
    const lock = join(dir, 'referral.json.lock');
    const writer = await separateWriter();
    let release: () => void = () => {};
    const held = writer.updateReferralState(dir, SCOPE, () => new Promise((resolve) => {
      release = () => resolve(null);
    }));
    while (!(await readFile(lock, 'utf8').catch(() => ''))) await new Promise((resolve) => setTimeout(resolve, 5));
    // Someone replaces the lock (e.g. after taking it over); the first holder's release must leave it.
    await writeFile(lock, 'other-holder\n');
    release();
    await held;
    expect((await readFile(lock, 'utf8')).trim()).toBe('other-holder');
  });

  it('recovers a stale lock only while it is still the same stale lock', async () => {
    const dir = await dataDir();
    const lock = join(dir, 'referral.json.lock');
    const old = new Date(Date.now() - 60_000);
    // Seen stale as "crashed", but another recoverer already replaced it with its own lock.
    await writeFile(lock, 'fresh-holder\n');
    await takeOverStaleLock(lock, 'crashed');
    expect((await readFile(lock, 'utf8')).trim()).toBe('fresh-holder');
    // Same holder, but its heartbeat refreshed it since.
    await writeFile(lock, 'crashed\n');
    await takeOverStaleLock(lock, 'crashed');
    expect((await readFile(lock, 'utf8')).trim()).toBe('crashed');
    // Another recovery is in progress: leave it to that one.
    await utimes(lock, old, old);
    await writeFile(`${lock}.takeover`, 'other-recoverer\n');
    await takeOverStaleLock(lock, 'crashed');
    expect((await readFile(lock, 'utf8')).trim()).toBe('crashed');
    await rm(`${lock}.takeover`);
    // Still the same stale lock: removed.
    await takeOverStaleLock(lock, 'crashed');
    await expect(access(lock)).rejects.toThrow();
    await expect(access(`${lock}.takeover`)).rejects.toThrow();
  });
});
