import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ChannelsClient, loadOrCreateIdentity, type StoredChannel } from '@antseed/node';
import { openChannelStore } from '../../payment-utils.js';
import { registerBuyerChannelsCommand } from './channels.js';
import { buyerChannel, buyerCommandHarness, MISSING_ON_CHAIN, onChain } from './test-helpers.js';
import {
  CHANNEL_CLOSE_GRACE_PERIOD_SECONDS,
  resolveBuyerChannelById,
  secondsUntilChannelWithdrawReady,
} from './channel-withdraw.js';

function channel(sessionId: string): StoredChannel {
  return {
    sessionId,
    peerId: 'peer',
    role: 'buyer',
    sellerEvmAddr: '0x' + '11'.repeat(20),
    buyerEvmAddr: '0x' + '22'.repeat(20),
    nonce: 0,
    authMax: '1000000',
    previousConsumption: '0',
    tokensDelivered: '0',
    deadline: 0,
    previousSessionId: '',
    requestCount: 0,
    reservedAt: 0,
    settledAt: null,
    settledAmount: null,
    status: 'active',
    latestBuyerSig: null,
    latestSpendingAuthSig: null,
    latestMetadata: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

test('resolveBuyerChannelById accepts exact ids and unique prefixes', () => {
  const first = channel('0x' + 'aa'.repeat(32));
  const second = channel('0x' + 'bb'.repeat(32));

  assert.equal(resolveBuyerChannelById([first, second], first.sessionId), first);
  assert.equal(resolveBuyerChannelById([first, second], '0xaaaa'), first);
});

test('resolveBuyerChannelById rejects ambiguous prefixes', () => {
  const first = channel('0xaaaa' + '11'.repeat(30));
  const second = channel('0xaaaa' + '22'.repeat(30));

  assert.throws(
    () => resolveBuyerChannelById([first, second], '0xaaaa'),
    /ambiguous/i,
  );
});

test('secondsUntilChannelWithdrawReady tracks 15 minute timeout grace period', () => {
  assert.equal(
    secondsUntilChannelWithdrawReady(0n, 100),
    CHANNEL_CLOSE_GRACE_PERIOD_SECONDS,
  );
  assert.equal(
    secondsUntilChannelWithdrawReady(100n, 100 + CHANNEL_CLOSE_GRACE_PERIOD_SECONDS - 1),
    1,
  );
  assert.equal(
    secondsUntilChannelWithdrawReady(100n, 100 + CHANNEL_CLOSE_GRACE_PERIOD_SECONDS),
    0,
  );
});

for (const operation of ['list', 'request-close', 'withdraw', 'close'] as const) {
  test(`${operation} includes one-off channels from the current buyer's store`, async (context) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'antseed-channel-recovery-'));
    context.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const identity = await loadOrCreateIdentity(dataDir);
    const videoChannel = {
      ...channel('0x' + 'cc'.repeat(32)),
      buyerEvmAddr: identity.wallet.address,
      channelKind: 'one_off' as const,
      oneOffRequestId: 'video-1',
      reserveMaxAmount: '4200000',
      confirmedReserveAmount: '4200000',
    };
    const store = openChannelStore(dataDir);
    try {
      store.upsertChannel(videoChannel);
      store.upsertChannel({ ...videoChannel, sessionId: 'free', channelKind: 'free' });
      store.upsertChannel({ ...videoChannel, sessionId: 'other-buyer', buyerEvmAddr: '0x' + '33'.repeat(20) });
    } finally {
      store.close();
    }
    const configPath = join(dataDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ payments: { crypto: { chainId: 'base-local' } } }));
    context.mock.method(ChannelsClient.prototype, 'getSession', async () => ({
      buyer: identity.wallet.address,
      status: 1,
      deposit: 4_200_000n,
      settled: 850_000n,
      closeRequestedAt: operation === 'withdraw' ? BigInt(Math.floor(Date.now() / 1000) - 901) : 0n,
    }));
    const requestClose = context.mock.method(ChannelsClient.prototype, 'requestClose', async () => 'close-tx');
    const withdraw = context.mock.method(ChannelsClient.prototype, 'withdraw', async () => 'withdraw-tx');
    const output = context.mock.method(console, 'log', () => {});
    const errors = context.mock.method(console, 'error', () => {});
    context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`Unexpected process.exit(${code})`); });
    const program = new Command()
      .option('--data-dir <path>', '', dataDir)
      .option('--config <path>', '', configPath);
    registerBuyerChannelsCommand(program.command('buyer'));

    const args = ['buyer', 'channels', ...(operation === 'list' ? ['--json'] : [operation, videoChannel.sessionId])];
    if (operation === 'close') {
      await assert.rejects(program.parseAsync(args, { from: 'user' }), /process.exit\(1\)/);
      assert.match(errors.mock.calls.map((call) => call.arguments.join(' ')).join('\n'), /request-close/);
      assert.equal(requestClose.mock.callCount(), 0);
      assert.equal(withdraw.mock.callCount(), 0);
      return;
    }

    await program.parseAsync(args, { from: 'user' });

    if (operation === 'list') {
      const result = JSON.parse(String(output.mock.calls.at(-1)!.arguments[0]));
      assert.deepEqual(result.map((entry: StoredChannel) => entry.sessionId), [videoChannel.sessionId]);
    } else {
      const transaction = operation === 'request-close' ? requestClose : withdraw;
      assert.equal(transaction.mock.callCount(), 1);
      assert.equal(transaction.mock.calls[0]!.arguments[1], videoChannel.sessionId);
      if (operation === 'withdraw') assert.match(String(output.mock.calls.at(-1)!.arguments[0]), /3\.35 USDC/);
    }
  });
}

// The store retires a row when the buyer gives up on it, which does not close the channel: the chain decides.
for (const status of ['ghost', 'settled', 'timeout'] as const) {
  test(`channels request-close starts the exit for a ${status} row the chain holds open`, async (context) => {
    const harness = await buyerCommandHarness(context);
    const id = '0x' + 'b1'.repeat(32);
    harness.seed(buyerChannel(id, harness.buyer, { status }));
    const requestClose = context.mock.method(ChannelsClient.prototype, 'requestClose', async () => 'close-tx');
    context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`Unexpected process.exit(${code})`); });

    const { stdout } = await harness.run(registerBuyerChannelsCommand, ['channels', 'request-close', id, '--json'], { [id]: onChain(harness.buyer, 1) });

    assert.deepEqual(JSON.parse(stdout), { channelId: id, transaction: 'close-tx', withdrawAfterSeconds: CHANNEL_CLOSE_GRACE_PERIOD_SECONDS });
    assert.equal(requestClose.mock.callCount(), 1);
    assert.equal(requestClose.mock.calls[0]!.arguments[1], id);
  });
}

for (const [status, label] of [[2, 'settled'], [3, 'timed out']] as const) {
  test(`channels request-close refuses a retired row the chain shows ${label}`, async (context) => {
    const harness = await buyerCommandHarness(context);
    const id = '0x' + 'b2'.repeat(32);
    harness.seed(buyerChannel(id, harness.buyer, { status: 'ghost' }));
    const requestClose = context.mock.method(ChannelsClient.prototype, 'requestClose', async () => 'close-tx');
    const written: string[] = [];
    context.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`process.exit(${code})`); });

    await assert.rejects(
      harness.run(registerBuyerChannelsCommand, ['channels', 'request-close', id], { [id]: onChain(harness.buyer, status) }),
      /process\.exit\(1\)/,
    );

    // Refused by the chain read, not by the local status.
    assert.match(written.join(''), new RegExp(`On-chain channel is ${label}, not active`));
    assert.equal(requestClose.mock.callCount(), 0);
  });
}

test('channels request-close says when no channel with the id is recorded on-chain', async (context) => {
  const harness = await buyerCommandHarness(context);
  const id = '0x' + 'b3'.repeat(32);
  harness.seed(buyerChannel(id, harness.buyer, { status: 'ghost' }));
  const requestClose = context.mock.method(ChannelsClient.prototype, 'requestClose', async () => 'close-tx');
  const written: string[] = [];
  context.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
  context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`process.exit(${code})`); });

  await assert.rejects(
    harness.run(registerBuyerChannelsCommand, ['channels', 'request-close', id], { [id]: MISSING_ON_CHAIN }),
    /process\.exit\(1\)/,
  );

  assert.match(written.join(''), /No channel with this id is recorded on-chain/);
  assert.equal(requestClose.mock.callCount(), 0);
});

// The chain can hold a reserve for a channel this data directory has no row for; its full id is enough to exit it.
test('channels request-close starts the exit for a full channel id the store has no row for', async (context) => {
  const harness = await buyerCommandHarness(context);
  const id = '0x' + 'B4'.repeat(32);
  const requestClose = context.mock.method(ChannelsClient.prototype, 'requestClose', async () => 'close-tx');
  context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`Unexpected process.exit(${code})`); });

  const { stdout } = await harness.run(registerBuyerChannelsCommand, ['channels', 'request-close', id, '--json'], { [id.toLowerCase()]: onChain(harness.buyer, 1) });

  assert.deepEqual(JSON.parse(stdout), { channelId: id.toLowerCase(), transaction: 'close-tx', withdrawAfterSeconds: CHANNEL_CLOSE_GRACE_PERIOD_SECONDS });
  assert.equal(requestClose.mock.calls[0]!.arguments[1], id.toLowerCase());
});

test('channels withdraw releases the reserve of a full channel id the store has no row for', async (context) => {
  const harness = await buyerCommandHarness(context);
  const id = '0x' + 'b5'.repeat(32);
  const withdraw = context.mock.method(ChannelsClient.prototype, 'withdraw', async () => 'withdraw-tx');
  context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`Unexpected process.exit(${code})`); });

  const { stdout } = await harness.run(registerBuyerChannelsCommand, ['channels', 'withdraw', id, '--json'], {
    [id]: { ...onChain(harness.buyer, 1, 250_000n), closeRequestedAt: BigInt(Math.floor(Date.now() / 1000) - 901) },
  });

  assert.deepEqual(JSON.parse(stdout), { channelId: id, transaction: 'withdraw-tx', deposit: '1000000', settled: '250000', estimatedRefund: '750000' });
  assert.equal(withdraw.mock.calls[0]!.arguments[1], id);
});

for (const operation of ['request-close', 'withdraw'] as const) {
  test(`channels ${operation} refuses a full channel id that belongs to another buyer on-chain`, async (context) => {
    const harness = await buyerCommandHarness(context);
    const id = '0x' + 'b6'.repeat(32);
    const requestClose = context.mock.method(ChannelsClient.prototype, 'requestClose', async () => 'close-tx');
    const withdraw = context.mock.method(ChannelsClient.prototype, 'withdraw', async () => 'withdraw-tx');
    const written: string[] = [];
    context.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`process.exit(${code})`); });

    await assert.rejects(
      harness.run(registerBuyerChannelsCommand, ['channels', operation, id], { [id]: onChain('0x' + '77'.repeat(20), 1) }),
      /process\.exit\(1\)/,
    );

    assert.match(written.join(''), /is not the on-chain buyer for this channel/);
    assert.equal(requestClose.mock.callCount() + withdraw.mock.callCount(), 0);
  });

  test(`channels ${operation} still refuses a prefix or a short id the store has no row for`, async (context) => {
    const harness = await buyerCommandHarness(context);
    harness.seed(buyerChannel('0x' + 'b7'.repeat(32), harness.buyer));
    context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`process.exit(${code})`); });

    await assert.rejects(
      harness.run(registerBuyerChannelsCommand, ['channels', operation, '0xb8b8'], {}),
      /No local buyer channel found for 0xb8b8/,
    );
  });
}

test('channels withdraw says when no channel with the id is recorded on-chain', async (context) => {
  const harness = await buyerCommandHarness(context);
  const id = '0x' + 'b9'.repeat(32);
  const withdraw = context.mock.method(ChannelsClient.prototype, 'withdraw', async () => 'withdraw-tx');
  const written: string[] = [];
  context.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
  context.mock.method(process, 'exit', (code?: string | number | null) => { throw new Error(`process.exit(${code})`); });

  await assert.rejects(
    harness.run(registerBuyerChannelsCommand, ['channels', 'withdraw', id], { [id]: MISSING_ON_CHAIN }),
    /process\.exit\(1\)/,
  );

  assert.match(written.join(''), /No channel with this id is recorded on-chain/);
  assert.equal(withdraw.mock.callCount(), 0);
});

// `channels` declares --json too, so commander gives it the flag: every placement a user can type must print JSON.
for (const placement of ['after the subcommand', 'before the subcommand'] as const) {
  const argv = (subcommand: string, ...rest: string[]) => (placement === 'after the subcommand'
    ? ['channels', subcommand, ...rest, '--json']
    : ['channels', '--json', subcommand, ...rest]);

  test(`channels list prints JSON with --json ${placement}`, async (context) => {
    const harness = await buyerCommandHarness(context);
    const id = '0x' + 'a1'.repeat(32);
    harness.seed(buyerChannel(id, harness.buyer));
    const { stdout } = await harness.run(registerBuyerChannelsCommand, argv('list'), { [id]: onChain(harness.buyer, 1) });
    assert.deepEqual(JSON.parse(stdout).map((entry: StoredChannel) => entry.sessionId), [id]);
  });

  test(`channels request-close prints JSON with --json ${placement}`, async (context) => {
    const harness = await buyerCommandHarness(context);
    const id = '0x' + 'a2'.repeat(32);
    harness.seed(buyerChannel(id, harness.buyer));
    context.mock.method(ChannelsClient.prototype, 'requestClose', async () => 'close-tx');
    const { stdout } = await harness.run(registerBuyerChannelsCommand, argv('request-close', id), { [id]: onChain(harness.buyer, 1) });
    assert.deepEqual(JSON.parse(stdout), { channelId: id, transaction: 'close-tx', withdrawAfterSeconds: CHANNEL_CLOSE_GRACE_PERIOD_SECONDS });
  });

  test(`channels withdraw prints JSON with --json ${placement}`, async (context) => {
    const harness = await buyerCommandHarness(context);
    const id = '0x' + 'a3'.repeat(32);
    harness.seed(buyerChannel(id, harness.buyer));
    context.mock.method(ChannelsClient.prototype, 'withdraw', async () => 'withdraw-tx');
    const closing = { ...onChain(harness.buyer, 1, 250_000n), closeRequestedAt: BigInt(Math.floor(Date.now() / 1000) - CHANNEL_CLOSE_GRACE_PERIOD_SECONDS - 1) };
    const { stdout } = await harness.run(registerBuyerChannelsCommand, argv('withdraw', id), { [id]: closing });
    assert.deepEqual(JSON.parse(stdout), { channelId: id, transaction: 'withdraw-tx', deposit: '1000000', settled: '250000', estimatedRefund: '750000' });
  });
}

for (const placement of ['after the subcommand', 'before the subcommand'] as const) {
  const argv = (...flags: string[]) => (placement === 'after the subcommand'
    ? ['channels', 'list', ...flags, '--json']
    : ['channels', ...flags, 'list', '--json']);

  test(`channels list honours --status ${placement}`, async (context) => {
    const harness = await buyerCommandHarness(context);
    const active = '0x' + 'b1'.repeat(32);
    const settled = '0x' + 'b2'.repeat(32);
    harness.seed(buyerChannel(active, harness.buyer), buyerChannel(settled, harness.buyer, { status: 'settled' }));
    const { stdout } = await harness.run(registerBuyerChannelsCommand, argv('--status', 'settled'), { [active]: onChain(harness.buyer, 1), [settled]: onChain(harness.buyer, 2) });
    assert.deepEqual(JSON.parse(stdout).map((entry: StoredChannel) => entry.sessionId), [settled]);
  });

  test(`channels list honours --limit ${placement}`, async (context) => {
    const harness = await buyerCommandHarness(context);
    const newest = '0x' + 'b3'.repeat(32);
    const oldest = '0x' + 'b4'.repeat(32);
    harness.seed(buyerChannel(newest, harness.buyer), buyerChannel(oldest, harness.buyer));
    const { stdout } = await harness.run(registerBuyerChannelsCommand, argv('--limit', '1'), { [newest]: onChain(harness.buyer, 1), [oldest]: onChain(harness.buyer, 1) });
    assert.equal(JSON.parse(stdout).length, 1);
  });
}

test('channels list without --status or --limit lists every channel', async (context) => {
  const harness = await buyerCommandHarness(context);
  const first = '0x' + 'b5'.repeat(32);
  const second = '0x' + 'b6'.repeat(32);
  harness.seed(buyerChannel(first, harness.buyer), buyerChannel(second, harness.buyer, { status: 'settled' }));
  const { stdout } = await harness.run(registerBuyerChannelsCommand, ['channels', 'list', '--json'], { [first]: onChain(harness.buyer, 1), [second]: onChain(harness.buyer, 2) });
  assert.equal(JSON.parse(stdout).length, 2);
});

test('channels request-close without --json prints text', async (context) => {
  const harness = await buyerCommandHarness(context);
  const id = '0x' + 'a4'.repeat(32);
  harness.seed(buyerChannel(id, harness.buyer));
  context.mock.method(ChannelsClient.prototype, 'requestClose', async () => 'close-tx');
  const { stdout } = await harness.run(registerBuyerChannelsCommand, ['channels', 'request-close', id], { [id]: onChain(harness.buyer, 1) });
  assert.match(stdout, /Transaction: close-tx/);
  assert.throws(() => JSON.parse(stdout));
});

test('channels --status active leaves out a channel the seller settled on-chain', async (context) => {
  const harness = await buyerCommandHarness(context);
  const settledId = '0x' + 'ee'.repeat(32);
  harness.seed(buyerChannel(settledId, harness.buyer));

  const { stdout } = await harness.run(registerBuyerChannelsCommand, ['channels', '--status', 'active', '--json'], {
    [settledId]: onChain(harness.buyer, 2, 400_000n),
  });

  assert.deepEqual(JSON.parse(stdout), []);
});
