import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearReferralInvite,
  pendingInvite,
  readIssuedInviteIndices,
  readReferralState,
  recordIssuedInvite,
  REFERRAL_CHAIN_RECHECK_MAX_MS,
  REFERRAL_CHAIN_RECHECK_MIN_MS,
  referrerOfLookup,
  saveReferralInvite,
  syncReferralState,
  writeReferralState,
} from '../src/payments/referral-state.js';
import { encodeInvite } from '../src/payments/invites.js';

const REFERRER = '0x1111111111111111111111111111111111111111';
const OTHER_REFERRER = '0x3333333333333333333333333333333333333333';
const BUYER = '0x2222222222222222222222222222222222222222';
const SCOPE = { wallet: BUYER, chainId: 8453, referralsAddress: '0x4444444444444444444444444444444444444444' };
const OTHER_DEPLOYMENT = { ...SCOPE, referralsAddress: '0x5555555555555555555555555555555555555555' };
const OTHER_CHAIN = { ...SCOPE, chainId: 84532 };
const INVITE = { epoch: 42n, index: 7n, r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` };
const ENCODED = encodeInvite(INVITE);
const ENCODED_2 = encodeInvite({ ...INVITE, index: 8n });

const dirs: string[] = [];
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-referral-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A lookup that counts its calls. */
function counted(answer: () => Promise<string | null | undefined>) {
  const lookup = Object.assign(async () => { lookup.calls += 1; return answer(); }, { calls: 0 });
  return lookup;
}

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

  it('records a binding only once referrerOf confirms what Antscan reports', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    let onChain: string | null = null;
    const chain = counted(async () => onChain);
    const now = () => 0;
    // The first sync reconciles with the chain once; until the backoff
    // elapses, only an Antscan hint reads it again.
    expect(await syncReferralState(dir, SCOPE, { explorer: async () => null, chain }, { now })).toMatchObject({ state: 'invited' });
    expect(chain.calls).toBe(1);
    expect(await syncReferralState(dir, SCOPE, { explorer: async () => undefined, chain }, { now })).toMatchObject({ state: 'invited' });
    expect(await syncReferralState(dir, SCOPE, { explorer: async () => { throw new Error('offline'); }, chain }, { now })).toMatchObject({ state: 'invited' });
    expect(chain.calls).toBe(1);

    onChain = REFERRER.toLowerCase();
    const bound = await syncReferralState(dir, SCOPE, { explorer: async () => REFERRER, chain }, { now });
    expect(chain.calls).toBe(2);
    expect(bound).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect(bound?.invite).toBeUndefined();
    expect(pendingInvite(await readReferralState(dir, SCOPE))).toBeNull();
  });

  it('binds a pending invite with only the chain lookup', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    expect(await syncReferralState(dir, SCOPE, { explorer: null, chain: async () => REFERRER })).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect(pendingInvite(await readReferralState(dir, SCOPE))).toBeNull();

    const chainOnly = await dataDir();
    await saveReferralInvite(chainOnly, SCOPE, ENCODED, REFERRER);
    expect(await syncReferralState(chainOnly, SCOPE, { chain: async () => REFERRER })).toMatchObject({ state: 'bound', referrer: REFERRER });
  });

  it('reconciles with the chain while the explorer is down', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    let onChain: string | null = null;
    const chain = counted(async () => onChain);
    const explorer = async (): Promise<string | null> => { throw new Error('offline'); };
    let clock = 0;
    const now = () => clock;
    expect(await syncReferralState(dir, SCOPE, { explorer, chain }, { now })).toMatchObject({ state: 'invited' });
    onChain = REFERRER; // a settlement binds it
    clock = REFERRAL_CHAIN_RECHECK_MIN_MS - 1;
    expect(await syncReferralState(dir, SCOPE, { explorer, chain }, { now })).toMatchObject({ state: 'invited' });
    clock = REFERRAL_CHAIN_RECHECK_MIN_MS;
    expect(await syncReferralState(dir, SCOPE, { explorer, chain }, { now })).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect(chain.calls).toBe(2);
  });

  it('backs off referrerOf reads while Antscan does not report a binding', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    const chain = counted(async () => null);
    let hint: string | null = null;
    const lookups = { explorer: async () => hint, chain };
    const minute = 60_000;
    const callsAt = async (minutes: number[]) => {
      const calls: number[] = [];
      for (const at of minutes) {
        await syncReferralState(dir, SCOPE, lookups, { now: () => at * minute });
        calls.push(chain.calls);
      }
      return calls;
    };
    // Every minute for over two hours: reads at 0, 10, 30, 70, then hourly.
    const minutes = Array.from({ length: 131 }, (_, at) => at);
    const calls = await callsAt(minutes);
    expect(minutes.filter((at) => calls[at] !== (calls[at - 1] ?? 0))).toEqual([0, 10, 30, 70, 130]);
    expect(REFERRAL_CHAIN_RECHECK_MAX_MS).toBe(60 * minute);

    // A hint reads it at once, but a hint the chain keeps denying waits.
    hint = REFERRER;
    expect(await callsAt([131, 132, 133])).toEqual([6, 6, 6]);
    // A newly redeemed invite starts over.
    await saveReferralInvite(dir, SCOPE, ENCODED_2, OTHER_REFERRER);
    hint = null;
    expect(await callsAt([134, 135])).toEqual([7, 7]);
  });

  it('keeps the pending invite when the configured contract does not confirm the binding', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    const explorer = async () => REFERRER;
    // Antscan indexes another deployment, or is wrong.
    expect(await syncReferralState(dir, SCOPE, { explorer, chain: async () => null })).toMatchObject({ state: 'invited', invite: ENCODED });
    // referrerOf unavailable.
    expect(await syncReferralState(dir, SCOPE, { explorer, chain: async () => { throw new Error('rpc down'); } })).toMatchObject({ state: 'invited' });
    expect(await syncReferralState(dir, SCOPE, { explorer })).toMatchObject({ state: 'invited' });
    expect(pendingInvite(await readReferralState(dir, SCOPE))).toEqual(INVITE);
  });

  it('only asks while an invite is pending or a binding is unverified', async () => {
    const dir = await dataDir();
    await writeReferralState(dir, SCOPE, { state: 'none' });
    const explorer = counted(async () => REFERRER);
    const chain = counted(async () => REFERRER);
    await syncReferralState(dir, SCOPE, { explorer, chain });
    await writeReferralState(dir, SCOPE, { state: 'bound', referrer: REFERRER });
    await syncReferralState(dir, SCOPE, { explorer, chain });
    expect([explorer.calls, chain.calls]).toEqual([0, 0]);
  });

  it('never replaces a binding on the same deployment', async () => {
    const dir = await dataDir();
    await writeReferralState(dir, SCOPE, { state: 'bound', referrer: REFERRER });
    expect(await saveReferralInvite(dir, SCOPE, ENCODED, OTHER_REFERRER)).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect(await clearReferralInvite(dir, SCOPE)).toMatchObject({ state: 'bound', referrer: REFERRER });
  });

  it('replaces or clears a pending invite', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    expect(await saveReferralInvite(dir, SCOPE, ENCODED_2, OTHER_REFERRER)).toMatchObject({ state: 'invited', invite: ENCODED_2, referrer: OTHER_REFERRER });
    expect(await clearReferralInvite(dir, SCOPE)).toMatchObject({ state: 'none' });
  });

  it('keeps bindings per chain, deployment and buyer in one data directory', async () => {
    const dir = await dataDir();
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    await syncReferralState(dir, SCOPE, { explorer: async () => REFERRER, chain: async () => REFERRER });

    // Switching deployment: the binding on the first one does not block a new invite.
    expect(await readReferralState(dir, OTHER_DEPLOYMENT)).toBeNull();
    expect(await saveReferralInvite(dir, OTHER_DEPLOYMENT, ENCODED_2, OTHER_REFERRER)).toMatchObject({ state: 'invited', invite: ENCODED_2 });
    expect(pendingInvite(await readReferralState(dir, OTHER_DEPLOYMENT))).toEqual({ ...INVITE, index: 8n });
    expect(await readReferralState(dir, OTHER_CHAIN)).toBeNull();
    expect(await readReferralState(dir, { ...SCOPE, wallet: OTHER_REFERRER })).toBeNull();

    // Switching back finds the first binding intact, checksummed or not.
    expect(await readReferralState(dir, { ...SCOPE, wallet: BUYER.toLowerCase(), referralsAddress: SCOPE.referralsAddress.toLowerCase() }))
      .toMatchObject({ state: 'bound', referrer: REFERRER });
  });

  it('treats an unscoped legacy binding as unverified until referrerOf confirms it', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'referral.json'), JSON.stringify({ state: 'bound', referrer: REFERRER, issued: { epoch: 30, indices: [1] } }));
    expect(await readReferralState(dir, SCOPE)).toMatchObject({ state: 'bound', referrer: REFERRER, unverified: true });

    // Not authoritative: a new invite can replace it.
    expect(await saveReferralInvite(dir, OTHER_DEPLOYMENT, ENCODED_2, OTHER_REFERRER)).toMatchObject({ state: 'invited' });

    const legacyDir = await dataDir();
    await writeFile(join(legacyDir, 'referral.json'), JSON.stringify({ state: 'bound', referrer: REFERRER }));
    expect(await syncReferralState(legacyDir, SCOPE, { chain: async () => { throw new Error('rpc down'); } })).toMatchObject({ unverified: true });
    expect(await syncReferralState(legacyDir, SCOPE, { chain: async () => null })).toMatchObject({ state: 'none' });
    expect((await readReferralState(legacyDir, SCOPE))?.unverified).toBeUndefined();

    const confirmedDir = await dataDir();
    await writeFile(join(confirmedDir, 'referral.json'), JSON.stringify({ state: 'bound', referrer: REFERRER }));
    expect(await syncReferralState(confirmedDir, SCOPE, { chain: async () => OTHER_REFERRER })).toEqual(expect.objectContaining({ state: 'bound', referrer: OTHER_REFERRER }));
    expect(await readReferralState(confirmedDir, SCOPE)).not.toHaveProperty('unverified');
  });

  it('maps referrerOf to a lookup: zero address is unbound, errors reject', async () => {
    expect(await referrerOfLookup({ referrerOf: async () => '0x0000000000000000000000000000000000000000' })(BUYER)).toBeNull();
    expect(await referrerOfLookup({ referrerOf: async () => REFERRER.toLowerCase() })(BUYER)).toBe(REFERRER);
    await expect(referrerOfLookup({ referrerOf: async () => { throw new Error('rpc down'); } })(BUYER)).rejects.toThrow('rpc down');
  });

  it('remembers invites handed out in the latest epoch per signer and deployment', async () => {
    const dir = await dataDir();
    const signer = { ...SCOPE, wallet: REFERRER };
    await recordIssuedInvite(dir, signer, 30, 0);
    await recordIssuedInvite(dir, signer, 30, 1);
    expect(await readIssuedInviteIndices(dir, signer, 30)).toEqual([0, 1]);
    expect(await readIssuedInviteIndices(dir, { ...signer, wallet: OTHER_REFERRER }, 30)).toEqual([]);
    expect(await readIssuedInviteIndices(dir, { ...OTHER_DEPLOYMENT, wallet: REFERRER }, 30)).toEqual([]);
    await saveReferralInvite(dir, SCOPE, ENCODED, REFERRER);
    expect(await readIssuedInviteIndices(dir, signer, 30)).toEqual([0, 1]);
    await recordIssuedInvite(dir, signer, 31, 0);
    expect(await readIssuedInviteIndices(dir, signer, 30)).toEqual([]);
    expect(await readIssuedInviteIndices(dir, signer, 31)).toEqual([0]);
    expect((await readReferralState(dir, SCOPE))?.state).toBe('invited');
  });

  it('still counts legacy issued indices so an invite is never handed out twice', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'referral.json'), JSON.stringify({ state: 'none', issued: { epoch: 30, indices: [2] } }));
    const signer = { ...SCOPE, wallet: REFERRER };
    expect(await readIssuedInviteIndices(dir, signer, 30)).toEqual([2]);
    expect(await recordIssuedInvite(dir, signer, 30, 0)).toEqual([0, 2]);
    expect(JSON.parse(await readFile(join(dir, 'referral.json'), 'utf8')).legacy?.issued).toBeUndefined();
  });

  it('keeps every overlapping update: issued invites and referee records all survive', async () => {
    const dir = await dataDir();
    const signer = { ...SCOPE, wallet: REFERRER };
    const otherBuyer = { ...SCOPE, wallet: OTHER_REFERRER };
    await saveReferralInvite(dir, otherBuyer, ENCODED_2, REFERRER);
    await Promise.all([
      ...Array.from({ length: 12 }, (_, index) => recordIssuedInvite(dir, signer, 30, index)),
      saveReferralInvite(dir, SCOPE, ENCODED, REFERRER),
      clearReferralInvite(dir, otherBuyer),
      writeReferralState(dir, OTHER_CHAIN, { state: 'bound', referrer: REFERRER }),
    ]);
    expect(await readIssuedInviteIndices(dir, signer, 30)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(await readReferralState(dir, SCOPE)).toMatchObject({ state: 'invited', invite: ENCODED });
    expect(await readReferralState(dir, otherBuyer)).toMatchObject({ state: 'none' });
    expect(await readReferralState(dir, OTHER_CHAIN)).toMatchObject({ state: 'bound', referrer: REFERRER });
    expect((await readdir(dir)).sort()).toEqual(['referral.json']); // no temporary or lock files left
  });

  it('waits for another process holding the referral lock before writing', async () => {
    const dir = await dataDir();
    const signer = { ...SCOPE, wallet: REFERRER };
    const lock = join(dir, 'referral.lock');
    await writeFile(lock, JSON.stringify({ pid: process.ppid })); // a live process
    let saved = false;
    const saving = saveReferralInvite(dir, SCOPE, ENCODED, REFERRER).then(() => { saved = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(saved).toBe(false);
    // The other process records an issued invite, then releases the lock.
    await writeFile(join(dir, 'referral.json'), JSON.stringify({ version: 2, referees: {}, issued: { [`8453:${SCOPE.referralsAddress}:${REFERRER}`]: { epoch: 30, indices: [4] } } }));
    await rm(lock);
    await saving;
    expect(await readIssuedInviteIndices(dir, signer, 30)).toEqual([4]);
    expect((await readReferralState(dir, SCOPE))?.state).toBe('invited');
  });

  it('never lets a legacy check erase an invite redeemed while it ran', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'referral.json'), JSON.stringify({ state: 'bound', referrer: REFERRER }));
    const chain = async () => {
      await saveReferralInvite(dir, SCOPE, ENCODED, OTHER_REFERRER);
      return null; // unbound on this deployment
    };
    await syncReferralState(dir, SCOPE, { chain });
    expect(await readReferralState(dir, SCOPE)).toMatchObject({ state: 'invited', invite: ENCODED, referrer: OTHER_REFERRER });
  });

  it('ignores files from the retired network-matching design', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'referral.json'), JSON.stringify({ state: 'accepted', referrer: REFERRER }));
    expect(await readReferralState(dir, SCOPE)).toBeNull();
  });
});
