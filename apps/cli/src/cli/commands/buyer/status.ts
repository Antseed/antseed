import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGlobalOptions } from '../types.js';
import { createDepositsClient, loadCryptoContext, formatUsdc, openChannelStore, reconcileLocalBuyerChannels } from '../../payment-utils.js';
import { loadConfig } from '../../../config/loader.js';
import { getNodeStatus } from '../../../status/node-status.js';

interface BuyerStateFile {
  state?: string;
  pid?: number;
  port?: number;
  pinnedPeerId?: string | null;
}

async function readBuyerState(dataDir: string): Promise<BuyerStateFile | null> {
  try {
    const raw = await readFile(join(dataDir, 'buyer.state.json'), 'utf-8');
    return JSON.parse(raw) as BuyerStateFile;
  } catch {
    return null;
  }
}

export function registerBuyerStatusCommand(buyerCmd: Command): void {
  buyerCmd
    .command('status')
    .description('Show buyer connection status and balance')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      try {
        const globalOpts = getGlobalOptions(buyerCmd);
        const config = await loadConfig(globalOpts.config);
        const nodeStatus = await getNodeStatus(config, globalOpts.dataDir);
        const buyerState = await readBuyerState(globalOpts.dataDir);
        const identity = await loadCryptoContext(globalOpts.dataDir);

        let depositsAvailable: string | null = null;
        let depositsReserved: string | null = null;
        try {
          const depositsClient = createDepositsClient(config);
          const account = await depositsClient.getBuyerBalance(identity.address);
          depositsAvailable = formatUsdc(account.available);
          depositsReserved = formatUsdc(account.reserved);
        } catch {
          // Non-fatal: show the status view even if chain access is unavailable.
        }

        let activeChannels = nodeStatus.activeChannels;
        try {
          const store = openChannelStore(globalOpts.dataDir);
          try {
            await reconcileLocalBuyerChannels(store, config, globalOpts.dataDir);
            activeChannels = store.getActiveChannelsByBuyer('buyer', identity.address).length;
          } finally {
            store.close();
          }
        } catch {
          // Non-fatal: if the local channel DB does not exist yet, keep the
          // daemon-reported value (or zero for a buyer proxy with no channels).
        }

        if (options.json) {
          console.log(JSON.stringify({
            connectionState: nodeStatus.state,
            proxyPort: nodeStatus.proxyPort,
            pinnedPeerId: buyerState?.pinnedPeerId ?? null,
            depositsAvailable,
            depositsReserved,
            activeChannels,
            walletAddress: nodeStatus.walletAddress ?? identity.address,
          }, null, 2));
          return;
        }

        const table = new Table({
          head: [chalk.bold('Metric'), chalk.bold('Value')],
          colWidths: [28, 44],
        });

        table.push(
          ['Connection state', nodeStatus.state === 'connected' ? chalk.green('connected') : chalk.gray('idle')],
          ['Proxy port', nodeStatus.proxyPort ? String(nodeStatus.proxyPort) : chalk.dim('n/a')],
          ['Pinned peer', buyerState?.pinnedPeerId ? chalk.cyan(buyerState.pinnedPeerId) : chalk.dim('none')],
          ['Deposits available', depositsAvailable ? chalk.green(`${depositsAvailable} USDC`) : chalk.dim('unavailable')],
          ['Deposits reserved', depositsReserved ? chalk.yellow(`${depositsReserved} USDC`) : chalk.dim('unavailable')],
          ['Active channels', String(activeChannels)],
          ['Wallet address', nodeStatus.walletAddress ?? identity.address ?? chalk.dim('not configured')],
        );

        console.log(chalk.bold('Buyer Status:\n'));
        console.log(table.toString());
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
