import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ChannelsClient, loadOrCreateIdentity, type StoredChannel } from '@antseed/node';
import { openChannelStore } from '../../payment-utils.js';
import { registerBuyerChannelsCommand } from './channels.js';
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
