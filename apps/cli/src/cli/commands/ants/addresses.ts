import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { printJson, runRead } from './shared.js';

export function registerAntsAddressesCommand(antsCmd: Command): void {
  antsCmd
    .command('addresses')
    .description('Contract addresses in use')
    .option('--json', 'output as JSON', false)
    .action(async (options: { json: boolean }) => runRead(antsCmd, 'Loading addresses...', async ({ ctx, chain }) => {
      const addresses = ctx.addresses();
      if (options.json) return printJson({ chainId: chain.chainId, evmChainId: chain.evmChainId, rpcUrl: chain.rpcUrl, addresses });
      const table = new Table({ head: ['Contract', 'Address'] });
      for (const [name, address] of Object.entries(addresses)) table.push([name, String(address)]);
      console.log(table.toString());
      console.log(chalk.dim(`${chain.chainId} via ${chain.rpcUrl}`));
    }));
}
