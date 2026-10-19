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
const scope = { chainId: 8453, referralsAddress, wallet };

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
    // Every referrer epoch Antscan lists is still unclaimed unless a test says otherwise.
    pendingReward: vi.fn(async (_referrer: string, _epoch: number) => 1n),
    claimEpochs: vi.fn(async () => '0xhash'),
    claimRefereeEpochs: vi.fn(async () => '0xreferee'),
    currentEpoch: vi.fn(async () => 40),
    // Epochs 30 and 33 hold an unclaimed, final referee bonus.
    pendingRefereeReward: vi.fn(async (_buyer: string, epoch: number) => (epoch === 30 || epoch === 33 ? 5n : 0n)),
  };
  const ctx = {
    address: wallet,
    buyerAddress: buyer,
    chain: options.referrals === false ? { evmChainId: 8453 } : { evmChainId: 8453, referralsAddress },
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
    await recordIssuedInvite(dir, scope, 30, 0);
    await recordIssuedInvite(dir, scope, 30, 1);
    expect((await referral(fixture().ctx, dir)).invites).toEqual({ epoch: 30, quota: 5, used: 2, left: 3 });
  });

  it('counts |bound ∪ handed out| against the quota', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ants-referral-'));
    dirs.push(dir);
    await recordIssuedInvite(dir, scope, 30, 2);
    const indexed = { invites: { epoch: 30, quota: 7, used: 1, usedIndices: [4] } };
    expect((await referral(fixture({ indexed }).ctx, dir)).invites).toEqual({ epoch: 30, quota: 7, used: 2, left: 5 });
    await recordIssuedInvite(dir, scope, 30, 4); // the bound one, handed out here too
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

    // Another wallet using the same data dir starts with its own issued indices.
    const replacement = Wallet.createRandom();
    const fresh = await issueInvite({ client: inviteClient({ used: [0] }), indexer: null, signer: replacement, chainId: 8453, referralsAddress, dataDir: dir, random: () => 0 });
    expect(fresh.index).toBe(1);
  });

  it('hands the last free index to exactly one of two concurrent requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ants-invite-'));
    dirs.push(dir);
    const client = inviteClient({ quota: 2, used: [0] });
    // Slow on-chain checks widen the window in which both requests read the state.
    client.inviteUsed.mockImplementation(async (_referrer, _epoch, index) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return index === 0;
    });
    const issue = () => issueInvite({ client, indexer: null, signer: new Wallet(key), chainId: 8453, referralsAddress, dataDir: dir, random: () => 0 });
    const results = await Promise.allSettled([issue(), issue()]);
    const created = results.filter((result) => result.status === 'fulfilled');
    expect(created).toHaveLength(1);
    expect((created[0] as PromiseFulfilledResult<{ index: number }>).value.index).toBe(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(InviteQuotaError);
  });

  const indexerReporting = (invites: NonNullable<IndexedReferrer['invites']>) =>
    ({ referrer: vi.fn(async () => ({ ...indexedReferrer, currentEpoch: invites.epoch, invites })) }) as unknown as Indexer;

  it('reads epoch and quota on-chain, and skips the indexes Antscan reports bound for that epoch', async () => {
    const client = inviteClient({ quota: 4 });
    const indexer = indexerReporting({ epoch: 42, quota: 4, used: 2, usedIndices: [0, 1] });
    const created = await issueInvite({ client, indexer, signer: new Wallet(key), chainId: 8453, referralsAddress, dataDir: null, random: () => 0 });
    expect(created).toMatchObject({ epoch: 42, index: 2, quota: 4, left: 1 });
    expect(client.currentEpoch).toHaveBeenCalledTimes(1);
    expect(client.inviteQuota).toHaveBeenCalledWith(new Wallet(key).address, 42);
    expect(client.inviteUsed.mock.calls.map(([, , index]) => index)).toEqual([2]);
  });

  it('issues after an epoch rollover even while Antscan still reports last week\'s zero quota', async () => {
    const client = inviteClient({ quota: 3 });
    const indexer = indexerReporting({ epoch: 41, quota: 0, used: 0, usedIndices: [] });
    const created = await issueInvite({ client, indexer, signer: new Wallet(key), chainId: 8453, referralsAddress, dataDir: null, random: () => 0 });
    expect(created).toMatchObject({ epoch: 42, index: 0, quota: 3, left: 2, expiresEpoch: 46 });
  });

  it('never signs for an Antscan epoch outside the validity window, nor uses its bound indexes', async () => {
    const client = inviteClient({ quota: 2 });
    const indexer = indexerReporting({ epoch: 30, quota: 5, used: 1, usedIndices: [0] });
    const signer = new Wallet(key);
    const created = await issueInvite({ client, indexer, signer, chainId: 8453, referralsAddress, dataDir: null, random: () => 0 });
    expect(created).toMatchObject({ epoch: 42, index: 0, quota: 2, left: 1, expiresEpoch: 46 });
    expect(decodeInvite(created.invite).epoch).toBe(42n);
    expect(client.inviteQuota).toHaveBeenCalledWith(signer.address, 42);
  });

  it('never picks an index Antscan reports used, and picks at random among the rest', async () => {
    const indexer = indexerReporting({ epoch: 42, quota: 4, used: 2, usedIndices: [0, 2] });
    const pick = (random: () => number) => issueInvite({ client: inviteClient({ quota: 4 }), indexer, signer: new Wallet(key), chainId: 8453, referralsAddress, dataDir: null, random });
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
    client.pendingRefereeReward.mockResolvedValue(5n);
    expect(await claimRefereeRewards(ctx)).toEqual({ hash: '0xreferee', epochs: [20, 21] });
    expect(client.claimRefereeEpochs).toHaveBeenCalledWith({}, buyer, [20, 21]);
    // Only the epochs Antscan named are checked, never the 26-epoch scan.
    expect(client.pendingRefereeReward.mock.calls).toEqual([[buyer, 20], [buyer, 21]]);
    await expect(claimRefereeRewards(fixture({ binding: { refereeClaimableEpochs: [] } }).ctx)).rejects.toThrow('No invite bonus');
  });

  it('drops epochs Antscan still lists after they were claimed on-chain', async () => {
    const { ctx, client } = fixture();
    client.pendingRefereeReward.mockImplementation(async (_buyer: string, epoch: number) => (epoch === 21 ? 5n : 0n));
    expect(await claimRefereeRewards(ctx)).toEqual({ hash: '0xreferee', epochs: [21] });
    expect(client.claimRefereeEpochs).toHaveBeenCalledWith({}, buyer, [21]);
    client.pendingRefereeReward.mockResolvedValue(0n);
    client.claimRefereeEpochs.mockClear();
    await expect(claimRefereeRewards(ctx)).rejects.toThrow('No invite bonus');
    expect(client.claimRefereeEpochs).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'no explorer is configured', options: { explorer: false } },
    { name: 'the explorer does not index referrals', options: { binding: { available: false } } },
  ])('scans finalized epochs on-chain when $name', async ({ options }) => {
    const { ctx, client } = fixture(options);
    expect(await claimRefereeRewards(ctx)).toEqual({ hash: '0xreferee', epochs: [30, 33] });
    expect(client.claimRefereeEpochs).toHaveBeenCalledWith({}, buyer, [30, 33]);
    // The 26 claimable epochs up to 38: epoch 39 is in its settlement grace, 40 is current.
    const scanned = client.pendingRefereeReward.mock.calls.map(([, epoch]) => epoch);
    expect(scanned).toEqual(Array.from({ length: 26 }, (_, i) => 13 + i));
    expect(client.pendingRefereeReward.mock.calls.every(([address]) => address === buyer)).toBe(true);
  });

  it('scans on-chain when the explorer request fails', async () => {
    const { ctx, client, indexer } = fixture();
    indexer.referralBinding.mockRejectedValue(new Error('Antscan unavailable'));
    expect(await claimRefereeRewards(ctx)).toEqual({ hash: '0xreferee', epochs: [30, 33] });
    expect(client.claimRefereeEpochs).toHaveBeenCalledWith({}, buyer, [30, 33]);
  });

  it('refuses when the on-chain scan finds nothing payable, and scans nothing before the first claimable epoch', async () => {
    const { ctx, client } = fixture({ explorer: false });
    client.pendingRefereeReward.mockResolvedValue(0n);
    await expect(claimRefereeRewards(ctx)).rejects.toThrow('No invite bonus');
    client.currentEpoch.mockResolvedValue(1);
    client.pendingRefereeReward.mockClear();
    await expect(claimRefereeRewards(ctx)).rejects.toThrow('No invite bonus');
    expect(client.pendingRefereeReward).not.toHaveBeenCalled();
    expect(client.claimRefereeEpochs).not.toHaveBeenCalled();
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
    expect(client.pendingReward.mock.calls).toEqual([[wallet, 3], [wallet, 5]]);
  });

  it('falls back to the on-chain epoch scan without an explorer', async () => {
    const { ctx, client } = fixture({ explorer: false });
    expect(await claimReferralRewards(ctx)).toEqual({ hash: '0xhash', epochs: [7] });
    expect(client.pendingRewards).toHaveBeenCalledWith(wallet);
  });

  it('falls back to the on-chain epoch scan when the explorer request fails', async () => {
    const { ctx, client, indexer } = fixture();
    indexer.referrer.mockRejectedValueOnce(new Error('antscan down'));
    expect(await claimReferralRewards(ctx)).toEqual({ hash: '0xhash', epochs: [7] });
    expect(client.pendingRewards).toHaveBeenCalledWith(wallet);
  });

  it('refuses when nothing is payable', async () => {
    const { ctx, client } = fixture({ indexed: { claimableEpochs: [] } });
    await expect(claimReferralRewards(ctx)).rejects.toThrow('No referral rewards');
    expect(client.claimEpochs).not.toHaveBeenCalled();
  });

  it('drops epochs Antscan still lists after they were claimed on-chain', async () => {
    const { ctx, client } = fixture();
    client.pendingReward.mockImplementation(async (_referrer: string, epoch: number) => (epoch === 5 ? 1n : 0n));
    expect(await claimReferralRewards(ctx)).toEqual({ hash: '0xhash', epochs: [5] });
    expect(client.claimEpochs).toHaveBeenCalledWith({}, wallet, [5]);
    client.pendingReward.mockResolvedValue(0n);
    client.claimEpochs.mockClear();
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
