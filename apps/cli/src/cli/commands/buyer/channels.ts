import type { Command } from 'commander';
import chalk from 'chalk';
import { loadOrCreateIdentity } from '@antseed/node';
import { getGlobalOptions } from '../types.js';
import { formatUsdc, openChannelStore, shortId } from '../../payment-utils.js';
import { registerBuyerChannelWithdrawCommands } from './channel-withdraw.js';

function statusColor(status: string): string {
  switch (status) {
    case 'active': return chalk.green(status);
    case 'settled': return chalk.cyan(status);
    case 'timeout': return chalk.yellow(status);
    case 'ghost': return chalk.red(status);
    default: return status;
  }
}

function usdc(baseUnits: string | null | undefined): string {
  return `${formatUsdc(BigInt(baseUnits ?? '0'))} USDC`;
}

function subtractBigintFloor(left: string | null | undefined, right: string | null | undefined): string {
  const result = BigInt(left ?? '0') - BigInt(right ?? '0');
  return result > 0n ? result.toString() : '0';
}

async function listBuyerChannels(buyerCmd: Command, options: { status?: string; limit?: string; json?: boolean }): Promise<void> {
  const globalOpts = getGlobalOptions(buyerCmd);

  const identity = await loadOrCreateIdentity(globalOpts.dataDir);
  const buyerAddress = identity.wallet.address;

  let store;
  try {
    store = openChannelStore(globalOpts.dataDir);
  } catch (err) {
    console.error(chalk.red(`Failed to open channel store: ${(err as Error).message}`));
    console.error(chalk.dim('Have you connected to the network yet? Channels are stored locally after first use.'));
    process.exit(1);
  }

  try {
    const limit = parseInt(options.limit as string, 10) || 20;
    const statusFilter = options.status as string | undefined;

    const allSessions = store.getBuyerPaymentChannels(buyerAddress);
    let filtered = allSessions;
    if (statusFilter) filtered = filtered.filter((session) => session.status === statusFilter);

    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    const limited = filtered.slice(0, limit);

    if (options.json) {
      console.log(JSON.stringify(limited, null, 2));
      return;
    }

    if (limited.length === 0) {
      console.log(chalk.yellow('No channels found.'));
      return;
    }

    console.log(chalk.bold(`Payment Channels (${limited.length} of ${filtered.length}):\n`));
    for (const session of limited) {
      console.log(`  ${chalk.bold(shortId(session.sessionId, 16))}  ${statusColor(session.status)}  ${chalk.dim(session.role)}`);
      const unsettled = subtractBigintFloor(session.authMax, session.settledAmount);
      console.log(`    Peer: ${chalk.dim(shortId(session.peerId, 16))}  Requests: ${session.requestCount}  Tokens: ${session.tokensDelivered}`);
      console.log(`    Deposit: ${chalk.green(usdc(session.authMax))}  Settled: ${chalk.cyan(usdc(session.settledAmount))}  Unsettled: ${chalk.yellow(usdc(unsettled))}`);
      console.log(`    Created: ${chalk.dim(new Date(session.createdAt).toISOString())}`);
      if (session.settledAt) {
        console.log(`    Settled: ${chalk.dim(new Date(session.settledAt).toISOString())}`);
      }
      console.log('');
    }
  } finally {
    store.close();
  }
}

export function registerBuyerChannelsCommand(buyerCmd: Command): void {
  const channelsCmd = buyerCmd
    .command('channels')
    .description('List, close, request-close, and withdraw buyer payment channels');

  channelsCmd
    .command('list')
    .description('List payment channels from local store')
    .option('--status <status>', 'filter by status: active, settled, timeout, ghost')
    .option('--limit <number>', 'max number of channels to show', '20')
    .option('--json', 'output as JSON', false)
    .action(async (options) => listBuyerChannels(buyerCmd, options));

  channelsCmd
    .option('--status <status>', 'filter by status: active, settled, timeout, ghost')
    .option('--limit <number>', 'max number of channels to show', '20')
    .option('--json', 'output as JSON', false)
    .action(async (options) => listBuyerChannels(buyerCmd, options));

  registerBuyerChannelWithdrawCommands(channelsCmd, buyerCmd);
}
