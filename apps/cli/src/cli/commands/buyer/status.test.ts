import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBuyerStatusCommand } from './status.js';
import { buyerChannel, buyerCommandHarness, MISSING_ON_CHAIN, nowSecs, onChain } from './test-helpers.js';

const CHANNEL = '0x' + 'aa'.repeat(32);
const OTHER_WALLET_CHANNEL = '0x' + 'bb'.repeat(32);
const OTHER_BUYER = '0x' + '33'.repeat(20);

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
