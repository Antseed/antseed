import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Wallet, type HDNodeWallet } from 'ethers';
import { AntsContext, type CreatedInviteView } from '@antseed/ants';
import { decodeInvite, encodeInvite, readReferralState, recoverInviter, signInvite } from '@antseed/node';
import {
  createReferralInvite,
  formatInviteCreated,
  formatRedeemResult,
  formatReferralStatus,
  redeemReferralInvite,
  type ReferralStatus,
} from './referral.js';

const REFERRALS = '0x1111111111111111111111111111111111111111';
const DOMAIN = { chainId: 8453, referralsAddress: REFERRALS };
const BUYER = '0x2222222222222222222222222222222222222222';
const strip = (lines: string[]) => lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''));

async function withDataDir(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-referral-cli-'));
  try { await work(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function context(dataDir: string, wallet: HDNodeWallet, client: Record<string, unknown>, indexer: Record<string, unknown> | null = null) {
  const ctx = new AntsContext({ chain: { referralsAddress: REFERRALS, evmChainId: 8453, chainId: 'base-mainnet' } as never, address: wallet.address, signer: wallet });
  (ctx as unknown as { referrals: () => unknown }).referrals = () => client;
  (ctx as unknown as { indexer: () => unknown }).indexer = () => indexer;
  return { ctx, chain: ctx.chain, dataDir };
}

test('invite signs a free index with this wallet and remembers it', async () => {
  await withDataDir(async (dir) => {
    const wallet = Wallet.createRandom();
    const used = new Set([0]);
    const client = {
      currentEpoch: async () => 30,
      inviteQuota: async () => 3,
      inviteUsed: async (_referrer: string, _epoch: number, index: number) => used.has(index),
    };
    const first = await createReferralInvite(context(dir, wallet, client) as never);
    assert.equal(first.epoch, 30);
    assert.ok([1, 2].includes(first.index));
    assert.equal(first.left, 1);
    assert.equal(first.link, `https://antseed.com/invite/${first.invite}`);
    assert.equal(recoverInviter(decodeInvite(first.invite), DOMAIN), wallet.address);

    const second = await createReferralInvite(context(dir, wallet, client) as never);
    assert.equal(second.index, 3 - first.index);
    assert.equal(second.left, 0);
    await assert.rejects(createReferralInvite(context(dir, wallet, client) as never), /All 3 invites for this week are taken/);
  });
});

test('invite reads epoch, quota and bound invites from Antscan when it reports them', async () => {
  await withDataDir(async (dir) => {
    const wallet = Wallet.createRandom();
    const client = {
      currentEpoch: async () => { throw new Error('no RPC epoch read'); },
      inviteQuota: async () => { throw new Error('no RPC quota read'); },
      inviteUsed: async () => false,
    };
    const indexer = { referrer: async () => ({ available: true, currentEpoch: 31, invites: { epoch: 31, quota: 5, used: 2, usedIndices: [0, 1] }, referredCount: 2, payable: '0', claimableEpochs: [], buyers: [] }) };
    const created = await createReferralInvite(context(dir, wallet, client, indexer) as never);
    assert.deepEqual([created.epoch, created.quota, created.left], [31, 5, 2]);
    assert.ok([2, 3, 4].includes(created.index));
  });
});

test('invite explains a zero quota', async () => {
  await withDataDir(async (dir) => {
    const client = { currentEpoch: async () => 30, inviteQuota: async () => 0, inviteUsed: async () => false };
    await assert.rejects(createReferralInvite(context(dir, Wallet.createRandom(), client) as never), /at least 1 USDC of usage or sales in the previous week/);
  });
});

test('redeem saves a valid invite as pending and refuses an invalid one with the reason', async () => {
  await withDataDir(async (dir) => {
    const referrer = Wallet.createRandom();
    const invite = encodeInvite(await signInvite(referrer, DOMAIN, 30, 0));
    const ok = { previewInvite: async () => ({ referrer: referrer.address, failure: null }) };
    const saved = await redeemReferralInvite({ client: ok, dataDir: dir, buyer: BUYER, value: `https://antseed.com/invite/${invite}` });
    assert.equal(saved.ok, true);
    assert.deepEqual(await readReferralState(dir).then((state) => [state?.state, state?.invite, state?.referrer]), ['invited', invite, referrer.address]);
    assert.match(strip(formatRedeemResult(saved)).join('\n'), /Invite from 0x.{4}….{4} saved\.\nBinds with your first paid or free request through `antseed buyer start` \(before week 34\)\./);

    const used = { previewInvite: async () => ({ referrer: referrer.address, failure: 'InviteAlreadyUsed' as const }) };
    const refused = await redeemReferralInvite({ client: used, dataDir: dir, buyer: BUYER, value: invite });
    assert.deepEqual(strip(formatRedeemResult(refused)), ["Can't use this invite: This invite was already used."]);
    const garbage = await redeemReferralInvite({ client: used, dataDir: dir, buyer: BUYER, value: 'not-an-invite' });
    assert.deepEqual(strip(formatRedeemResult(garbage)), ["Can't use this invite: Not a valid invite."]);
  });
});

test('invite output shows the link, the raw invite and what is left', () => {
  const created: CreatedInviteView = { invite: 'AQAe', link: 'https://antseed.com/invite/AQAe', epoch: 30, index: 1, quota: 3, left: 1, expiresEpoch: 34 };
  assert.deepEqual(strip(formatInviteCreated(created)), [
    'Invite created. Share the link; it works once and expires within 4 weeks.',
    '',
    '  https://antseed.com/invite/AQAe',
    '',
    'Invite: AQAe',
    '1 of 3 invites left this week.',
  ]);
});

test('status covers inviter, invite bonus and invitees', () => {
  const hiddenInvites = { available: false, payable: '0', claimableEpochs: [], referredCount: 0, invites: null };
  const hiddenReferee = { available: false, referrer: null, boundEpoch: null, windowEnd: null, weeksLeft: null, payable: '0', claimableEpochs: [] };
  const base: ReferralStatus = { configured: true, state: null, referee: hiddenReferee, invites: hiddenInvites };
  assert.deepEqual(strip(formatReferralStatus({ ...base, configured: false })), ['Referrals are not available on this network.']);
  assert.deepEqual(strip(formatReferralStatus(base)), [
    'No inviter. Redeem an invite with: antseed referral redeem <invite>',
    'Invite stats unavailable (no Antscan explorer configured).',
  ]);
  assert.equal(strip(formatReferralStatus({ ...base, state: { state: 'invited', referrer: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' } }))[0],
    'Invite from 0xe05f…cfF7 pending. Binds with your first paid or free request.');
  assert.deepEqual(strip(formatReferralStatus({
    ...base,
    referee: { available: true, referrer: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7', boundEpoch: 30, windowEnd: 42, weeksLeft: 9, payable: '1500000000000000000', claimableEpochs: [31] },
    invites: { available: true, payable: '250000000000000000', claimableEpochs: [31], referredCount: 2, invites: { epoch: 34, quota: 5, used: 2, left: 3 } },
  })), [
    'Invited by 0xe05f…cfF7 (week 30).',
    'Invite bonus: 9 weeks left · 1.5 ANTS payable. Paid to your authorized wallet.',
    'Your invites: 2 invited · 0.25 ANTS payable · 3 of 5 invites left this week.',
  ]);
});
