import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { ChannelInfo } from '@antseed/node';
import { registerBuyerStatusCommand } from './status.js';
import { buyerChannel, buyerCommandHarness, MISSING_ON_CHAIN, nowSecs, onChain } from './test-helpers.js';

const CHANNEL = '0x' + 'aa'.repeat(32);
const OTHER_WALLET_CHANNEL = '0x' + 'bb'.repeat(32);
const OTHER_BUYER = '0x' + '33'.repeat(20);
const OLDER_CHANNEL = '0x' + 'ab'.repeat(32);

function activeChannels(stdout: string): number {
  return (JSON.parse(stdout) as { activeChannels: number }).activeChannels;
}

test('buyer status stops counting a channel the seller settled on-chain', async (context) => {
  const harness = await buyerCommandHarness(context);
  harness.seed(buyerChannel(CHANNEL, harness.buyer));

  const { stdout } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], {
    [CHANNEL]: onChain(harness.buyer, 2, 400_000n),
  });

  assert.equal(activeChannels(stdout), 0);
  assert.equal(harness.channel(CHANNEL)?.status, 'settled');
  assert.equal(harness.channel(CHANNEL)?.settledAmount, '400000');
});

test('buyer status retires a withdrawn channel of another buyer wallet in the same data dir', async (context) => {
  const harness = await buyerCommandHarness(context);
  harness.seed(buyerChannel(OTHER_WALLET_CHANNEL, OTHER_BUYER));

  await harness.run(registerBuyerStatusCommand, ['status', '--json'], {
    [OTHER_WALLET_CHANNEL]: onChain(OTHER_BUYER, 3),
  });

  assert.equal(harness.channel(OTHER_WALLET_CHANNEL)?.status, 'timeout');
});

test('buyer status retires a reserve that never landed once every ReserveAuth expired', async (context) => {
  const harness = await buyerCommandHarness(context);
  const expired = nowSecs() - 2 * 3600;
  harness.seed(buyerChannel(CHANNEL, harness.buyer, {
    deadline: expired,
    latestReserveDeadline: expired,
    reserveAuthPending: true,
    confirmedReserveAmount: '0',
  }));

  const { stdout } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], { [CHANNEL]: MISSING_ON_CHAIN });

  assert.equal(activeChannels(stdout), 0);
  assert.equal(harness.channel(CHANNEL)?.status, 'ghost');
});

test('buyer status keeps a channel it could not read and warns on stderr only', async (context) => {
  const harness = await buyerCommandHarness(context);
  harness.seed(buyerChannel(CHANNEL, harness.buyer));

  const { stdout, stderr } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], {
    [CHANNEL]: new Error('rpc unreachable'),
  });

  assert.equal(activeChannels(stdout), 1);
  assert.equal(harness.channel(CHANNEL)?.status, 'active');
  assert.equal(stderr.split('\n').length, 1);
  assert.match(stderr, /chain/i);
  assert.match(stderr, /rpc unreachable/);
});

test('buyer status keeps a reserve that can still land', async (context) => {
  const harness = await buyerCommandHarness(context);
  harness.seed(buyerChannel(CHANNEL, harness.buyer, { reserveAuthPending: true, confirmedReserveAmount: '0' }));

  const { stdout } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], { [CHANNEL]: MISSING_ON_CHAIN });

  assert.equal(activeChannels(stdout), 1);
  assert.equal(harness.channel(CHANNEL)?.status, 'active');
});

test('buyer status keeps a channel the chain shows open', async (context) => {
  const harness = await buyerCommandHarness(context);
  harness.seed(buyerChannel(CHANNEL, harness.buyer));

  const { stdout } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], {
    [CHANNEL]: onChain(harness.buyer, 1),
  });

  assert.equal(activeChannels(stdout), 1);
  assert.equal(harness.channel(CHANNEL)?.status, 'active');
});

/** The seller's settled current channel and an older settled one, both active in the store. */
function seedCurrentAndOlder(harness: Awaited<ReturnType<typeof buyerCommandHarness>>): void {
  harness.seed(
    buyerChannel(OLDER_CHANNEL, harness.buyer, { peerId: 'seller-a', createdAt: Date.now() - 60_000 }),
    buyerChannel(CHANNEL, harness.buyer, { peerId: 'seller-a' }),
  );
}

function writeBuyerState(dataDir: string, pid: number): void {
  writeFileSync(join(dataDir, 'buyer.state.json'), JSON.stringify({ state: 'connected', pid, port: 8378 }));
}

function bothSettledOnChain(buyer: string): Record<string, ChannelInfo> {
  return { [CHANNEL]: onChain(buyer, 2, 400_000n), [OLDER_CHANNEL]: onChain(buyer, 2, 100_000n) };
}

test('buyer status leaves the current channel to a running buyer and still retires an older one', async (context) => {
  const harness = await buyerCommandHarness(context);
  seedCurrentAndOlder(harness);
  writeBuyerState(harness.dataDir, process.pid);

  const { stdout } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], bothSettledOnChain(harness.buyer));

  assert.equal(activeChannels(stdout), 1);
  assert.equal(harness.channel(CHANNEL)?.status, 'active');
  assert.equal(harness.channel(OLDER_CHANNEL)?.status, 'settled');
});

test('buyer status leaves the current channel to a running buyer that belongs to another user', async (context) => {
  const harness = await buyerCommandHarness(context);
  seedCurrentAndOlder(harness);
  const otherUsersBuyer = 424_242;
  writeBuyerState(harness.dataDir, otherUsersBuyer);
  const kill = process.kill.bind(process);
  context.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (pid !== otherUsersBuyer) return kill(pid, signal);
    throw Object.assign(new Error(`kill EPERM`), { code: 'EPERM' });
  });

  const { stdout } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], bothSettledOnChain(harness.buyer));

  assert.equal(activeChannels(stdout), 1);
  assert.equal(harness.channel(CHANNEL)?.status, 'active');
  assert.equal(harness.channel(OLDER_CHANNEL)?.status, 'settled');
});

test('buyer status retires the current channel when the buyer that wrote the state file has exited', async (context) => {
  const harness = await buyerCommandHarness(context);
  seedCurrentAndOlder(harness);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.ok(exited.pid);
  writeBuyerState(harness.dataDir, exited.pid);

  const { stdout } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], bothSettledOnChain(harness.buyer));

  assert.equal(activeChannels(stdout), 0);
  assert.equal(harness.channel(CHANNEL)?.status, 'settled');
  assert.equal(harness.channel(OLDER_CHANNEL)?.status, 'settled');
});

test('buyer status retires the current and older channels when no buyer runs', async (context) => {
  const harness = await buyerCommandHarness(context);
  seedCurrentAndOlder(harness);

  const { stdout } = await harness.run(registerBuyerStatusCommand, ['status', '--json'], bothSettledOnChain(harness.buyer));

  assert.equal(activeChannels(stdout), 0);
  assert.equal(harness.channel(CHANNEL)?.status, 'settled');
  assert.equal(harness.channel(OLDER_CHANNEL)?.status, 'settled');
});
