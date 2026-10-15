import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, getAddress, zeroPadValue } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeInvite, recordIssuedInvite, recoverInviter } from '@antseed/node';
import type { AntsContext } from './context.js';
import type { IndexedReferrer, Indexer } from './indexer.js';
import {
  InviteQuotaError,
  claimRefereeRewards,
  claimReferralRewards,
  issueInvite,
  refereeBonus,
  refereeBonusFromExplorer,
  referral,
  referralBindingFromExplorer,
  referredBuyers,
} from './referrals.js';

const wallet = '0x0000000000000000000000000000000000000001';
const buyer = '0x0000000000000000000000000000000000000002';
const referrer = getAddress('0xabcdef0000000000000000000000000000000003');
const referralsAddress = '0x1111111111111111111111111111111111111111';

const indexedReferrer: IndexedReferrer = {
  available: true,
  currentEpoch: 30,
  referredCount: 2,
  payable: '700',
  claimableEpochs: [3, 5],
  invites: { epoch: 30, quota: 5, used: 1, usedIndices: [0] },
  buyers: [{ buyer, boundEpoch: 4, points: '250', ants: '550', pendingPoints: '10' }],
};

const binding = {
  available: true, referrer: referrer.toLowerCase(), boundEpoch: 20, refereeWindowEnd: 32,
  refereePayable: '900', refereeClaimableEpochs: [20, 21], currentEpoch: 23,
};

function fixture(options: { referrals?: boolean; explorer?: boolean; indexed?: Partial<IndexedReferrer>; binding?: Partial<typeof binding> } = {}) {
  const indexer = {
    referrer: vi.fn(async () => ({ ...indexedReferrer, ...options.indexed })),
    referralBinding: vi.fn(async () => ({ ...binding, ...options.binding })),
  };
  const client = {
    pendingRewards: vi.fn(async () => [{ epoch: 7, amount: 1n }]),
    claimEpochs: vi.fn(async () => '0xhash'),
    claimRefereeEpochs: vi.fn(async () => '0xreferee'),
  };
  const ctx = {
    address: wallet,
    buyerAddress: buyer,
    chain: options.referrals === false ? {} : { referralsAddress },
    referrals: () => (options.referrals === false ? null : client),
    indexer: () => (options.explorer === false ? null : indexer),
    requireSigner: () => ({}),
  } as unknown as AntsContext;
  return { ctx, indexer, client };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('referral card', () => {
  it('reads counts, invites and payable epochs from Antscan, never the RPC epoch scan', async () => {
    const { ctx, client } = fixture();
    expect(await referral(ctx)).toEqual({
      available: true,
      payable: '700',
      claimableEpochs: [3, 5],
      referredCount: 2,
      invites: { epoch: 30, quota: 5, used: 1, left: 4 },
    });
    expect(client.pendingRewards).not.toHaveBeenCalled();
  });

  it('counts invites already handed out from this install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ants-referral-'));
    dirs.push(dir);
    await recordIssuedInvite(dir, 30, 0);
    await recordIssuedInvite(dir, 30, 1);
    expect((await referral(fixture().ctx, dir)).invites).toEqual({ epoch: 30, quota: 5, used: 2, left: 3 });
  });

  it('counts |bound ∪ handed out| against the quota', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ants-referral-'));
    dirs.push(dir);
    await recordIssuedInvite(dir, 30, 2);
    const indexed = { invites: { epoch: 30, quota: 7, used: 1, usedIndices: [4] } };
    expect((await referral(fixture({ indexed }).ctx, dir)).invites).toEqual({ epoch: 30, quota: 7, used: 2, left: 5 });
    await recordIssuedInvite(dir, 30, 4); // the bound one, handed out here too
    expect((await referral(fixture({ indexed }).ctx, dir)).invites).toEqual({ epoch: 30, quota: 7, used: 2, left: 5 });
  });

  it('is hidden without a referrals contract, an explorer, or an explorer that indexes referrals', async () => {
    const hidden = { available: false, payable: '0', claimableEpochs: [], referredCount: 0, invites: null };
    expect(await referral(fixture({ referrals: false }).ctx)).toEqual(hidden);
    expect(await referral(fixture({ explorer: false }).ctx)).toEqual(hidden);
    expect(await referral(fixture({ indexed: { available: false } }).ctx)).toEqual(hidden);
  });
});

describe('referred buyers', () => {
  it('lists the buyers Antscan attributes to the wallet', async () => {
    const { ctx, indexer } = fixture();
    expect(await referredBuyers(ctx)).toEqual({ available: true, buyers: indexedReferrer.buyers });
    expect(indexer.referrer).toHaveBeenCalledWith(wallet);
  });

  it('hides the list rather than scanning RPC when no explorer is configured', async () => {
    const { ctx, client } = fixture({ explorer: false });
    expect(await referredBuyers(ctx)).toEqual({ available: false, buyers: [] });
    expect(client.pendingRewards).not.toHaveBeenCalled();
    expect(await referredBuyers(fixture({ referrals: false }).ctx)).toEqual({ available: false, buyers: [] });
  });
});

describe('invites', () => {
  const key = zeroPadValue('0x0a11ce', 32);

  function inviteClient(overrides: { quota?: number; used?: number[] } = {}) {
    return {
      currentEpoch: vi.fn(async () => 42),
      inviteQuota: vi.fn(async () => overrides.quota ?? 3),
      inviteUsed: vi.fn(async (_referrer: string, _epoch: number, index: number) => (overrides.used ?? []).includes(index)),
    };
  }

  it('signs the next free index for the current epoch and remembers it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ants-invite-'));
    dirs.push(dir);
    const signer = new Wallet(key);
    const client = inviteClient({ used: [0] });
    const first = await issueInvite({ client, indexer: null, signer, chainId: 8453, referralsAddress, dataDir: dir, random: () => 0 });
    expect(first).toMatchObject({ epoch: 42, index: 1, quota: 3, expiresEpoch: 46 });
    expect(first.link).toBe(`https://antseed.com/invite/${first.invite}`);
    expect(recoverInviter(decodeInvite(first.invite), { chainId: 8453, referralsAddress })).toBe(signer.address);

    const second = await issueInvite({ client, indexer: null, signer, chainId: 8453, referralsAddress, dataDir: dir, random: () => 0 });
    expect(second.index).toBe(2);
    expect(second.left).toBe(0);
    await expect(issueInvite({ client, indexer: null, signer, chainId: 8453, referralsAddress, dataDir: dir, random: () => 0 }))
      .rejects.toThrow('All 3 invites for this week are taken');
  });

  it('takes epoch, quota and used invites from Antscan when it reports them', async () => {
    const client = inviteClient();
    const indexer = { referrer: vi.fn(async () => ({ ...indexedReferrer, invites: { epoch: 30, quota: 4, used: 2, usedIndices: [0, 1] } })) } as unknown as Indexer;
    const created = await issueInvite({ client, indexer, signer: new Wallet(key), chainId: 8453, referralsAddress, dataDir: null, random: () => 0 });
    expect(created).toMatchObject({ epoch: 30, index: 2, quota: 4, left: 1 });
    expect(client.currentEpoch).not.toHaveBeenCalled();
    expect(client.inviteQuota).not.toHaveBeenCalled();
  });

  it('never picks an index Antscan reports used, and picks at random among the rest', async () => {
    const indexer = { referrer: vi.fn(async () => ({ ...indexedReferrer, invites: { epoch: 30, quota: 4, used: 2, usedIndices: [0, 2] } })) } as unknown as Indexer;
    const pick = (random: () => number) => issueInvite({ client: inviteClient(), indexer, signer: new Wallet(key), chainId: 8453, referralsAddress, dataDir: null, random });
    expect((await pick(() => 0)).index).toBe(1);
    expect((await pick(() => 0.99)).index).toBe(3);
  });

  it('refuses without last week\'s activity', async () => {
    const error = await issueInvite({ client: inviteClient({ quota: 0 }), indexer: null, signer: new Wallet(key), chainId: 8453, referralsAddress, dataDir: null }).catch((cause) => cause);
    expect(error).toBeInstanceOf(InviteQuotaError);
    expect(error.message).toContain('at least 1 USDC');
  });
});

describe('referee bonus', () => {
  it('reports the inviter, weeks left and payable amount from Antscan', async () => {
    expect(await refereeBonus(fixture().ctx)).toEqual({
      available: true, referrer, boundEpoch: 20, windowEnd: 32, weeksLeft: 10, payable: '900', claimableEpochs: [20, 21],
    });
    expect(await refereeBonus(fixture({ binding: { currentEpoch: null } }).ctx)).toMatchObject({ weeksLeft: null });
    expect(await refereeBonus(fixture({ binding: { currentEpoch: 40 } }).ctx)).toMatchObject({ weeksLeft: 0 });
  });

  it('is hidden without referrals or an explorer that indexes them', async () => {
    expect((await refereeBonus(fixture({ referrals: false }).ctx)).available).toBe(false);
    expect((await refereeBonus(fixture({ explorer: false }).ctx)).available).toBe(false);
    expect((await refereeBonus(fixture({ binding: { available: false } }).ctx)).available).toBe(false);
  });

  it('claims the payable epochs for the buyer account', async () => {
    const { ctx, client } = fixture();
    expect(await claimRefereeRewards(ctx)).toEqual({ hash: '0xreferee', epochs: [20, 21] });
    expect(client.claimRefereeEpochs).toHaveBeenCalledWith({}, buyer, [20, 21]);
    await expect(claimRefereeRewards(fixture({ binding: { refereeClaimableEpochs: [] } }).ctx)).rejects.toThrow('No invite bonus');
  });

  it('reads the bonus straight from an explorer URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(binding))) as unknown as typeof fetch;
    expect(await refereeBonusFromExplorer('https://antscan.test', buyer, fetchImpl)).toMatchObject({ referrer, payable: '900' });
    expect((await refereeBonusFromExplorer(undefined, buyer, fetchImpl)).available).toBe(false);
  });
});

describe('referral claim', () => {
  it('claims the epochs Antscan reports payable', async () => {
    const { ctx, client } = fixture();
    expect(await claimReferralRewards(ctx)).toEqual({ hash: '0xhash', epochs: [3, 5] });
    expect(client.claimEpochs).toHaveBeenCalledWith({}, wallet, [3, 5]);
    expect(client.pendingRewards).not.toHaveBeenCalled();
  });

  it('falls back to the on-chain epoch scan only without an explorer', async () => {
    const { ctx, client } = fixture({ explorer: false });
    expect(await claimReferralRewards(ctx)).toEqual({ hash: '0xhash', epochs: [7] });
    expect(client.pendingRewards).toHaveBeenCalledWith(wallet);
  });

  it('refuses when nothing is payable', async () => {
    const { ctx, client } = fixture({ indexed: { claimableEpochs: [] } });
    await expect(claimReferralRewards(ctx)).rejects.toThrow('No referral rewards');
    expect(client.claimEpochs).not.toHaveBeenCalled();
  });
});

describe('referral binding lookup', () => {
  const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('returns the checksummed referrer, or null while unbound', async () => {
    const bound = respond({ available: true, buyer, referrer: referrer.toLowerCase(), boundEpoch: 4 });
    expect(await referralBindingFromExplorer('https://antscan.test/', buyer, bound)).toBe(referrer);
    expect((bound as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(`https://antscan.test/api/referrals/buyer/${buyer}`);
    expect(await referralBindingFromExplorer('https://antscan.test', buyer, respond({ available: true, buyer, referrer: null }))).toBeNull();
  });

  it('is undefined when Antscan is unset, does not index referrals, or fails', async () => {
    expect(await referralBindingFromExplorer(undefined, buyer, respond({}))).toBeUndefined();
    expect(await referralBindingFromExplorer('https://antscan.test', buyer, respond({ available: false, referrer: null }))).toBeUndefined();
    expect(await referralBindingFromExplorer('https://antscan.test', buyer, respond({ error: 'x' }, 404))).toBeUndefined();
  });
});
