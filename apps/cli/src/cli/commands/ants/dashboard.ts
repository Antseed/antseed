import { Option, InvalidArgumentError, type Command } from 'commander';
import { getAddress, ZeroAddress } from 'ethers';
import chalk from 'chalk';
import { createAntsServer } from '@antseed/ants';
import { loadAntsContext } from './shared.js';

export const DEFAULT_ANTS_PORT = 3119;

function dashboardAddress(value: string): string {
  try {
    const address = getAddress(value);
    if (address !== ZeroAddress) return address;
  } catch {}
  throw new InvalidArgumentError('Expected a non-zero Ethereum address.');
}

export function registerAntsDashboardAction(antsCmd: Command): void {
  antsCmd
    .option('-p, --port <port>', 'dashboard port', String(DEFAULT_ANTS_PORT))
    .option('--no-open', 'do not open the browser automatically')
    .addOption(new Option('--address <address>', 'pin the dashboard to one account; the connected wallet must be that account (or its authorized operator for buyer actions)').argParser(dashboardAddress))
    .hook('preSubcommand', () => {
      if (antsCmd.opts().address) antsCmd.error('--address only applies to the dashboard, not transaction subcommands.');
    })
    .action(async (options: { port: string; open: boolean; address?: string }) => {
      const port = Number(options.port) || DEFAULT_ANTS_PORT;
      try {
        const { ctx, chain, dataDir, configPath } = await loadAntsContext(antsCmd, { address: options.address });
        const selectedAddress = options.address ? ctx.address : undefined;
        let payments: Awaited<ReturnType<typeof import('@antseed/payments').createServer>> | undefined;
        const server = await createAntsServer({ port, dataDir, configPath, chain, browserWallet: true, address: ctx.address, selectedAddress, onAuthorize: options.address ? undefined : async () => {
          if (!payments) {
            const { createServer } = await import('@antseed/payments');
            payments = await createServer({ port: 0, dataDir, configPath, chainOverrides: { ...chain } });
            await payments.listen({ port: 0, host: '127.0.0.1' });
          }
          const bound = payments.server.address();
          if (!bound || typeof bound === 'string') throw new Error('Payments server is not listening.');
          const params = new URLSearchParams({ token: (payments as unknown as { bearerToken: string }).bearerToken, page: 'pay', action: 'authorize' });
          const { default: open } = await import('open');
          await open(`http://127.0.0.1:${bound.port}?${params}`);
        } });
        const url = await server.listen();
        console.log('');
        console.log(chalk.bold('ANTS staking dashboard'));
        console.log(selectedAddress ? `  Selected account: ${selectedAddress}` : `  Buyer account: ${ctx.address}`);
        console.log(`  Chain:   ${chain.chainId} (${chain.rpcUrl})`);
        console.log(`  URL:     ${chalk.cyan(url)}`);
        console.log(chalk.dim('  The URL carries a one-time session token; connect your wallet in the browser to approve transactions.'));
        console.log(chalk.dim('  Every dashboard action has a CLI equivalent: antseed ants --help. Press Ctrl+C to stop.'));
        console.log('');
        if (options.open) {
          try {
            const { default: open } = await import('open');
            await open(url);
          } catch {
            console.log(chalk.yellow('Could not open a browser automatically; open the URL above manually.'));
          }
        }
        const shutdown = async () => {
          await server.close();
          await payments?.close();
          process.exit(0);
        };
        process.on('SIGINT', () => { void shutdown(); });
        process.on('SIGTERM', () => { void shutdown(); });
      } catch (error) {
        console.error(chalk.red(`Failed to start the ANTS dashboard: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}
