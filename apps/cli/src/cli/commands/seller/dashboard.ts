import type { Command } from 'commander';
import chalk from 'chalk';
import { sellerCommand } from './monitor.js';
import pkg from '../../../../package.json' with { type: 'json' };
import { getGlobalOptions } from '../types.js';
import { resolveConfigPath } from '../../../config/loader.js';
import { hasSeller } from '../../../seller-monitor/reader.js';
import { startSellerDashboard } from '../../../seller-monitor/dashboard-server.js';

export const DEFAULT_SELLER_DASHBOARD_PORT = 3120;

export function registerSellerDashboardCommand(sellerCmd: Command): void {
  sellerCmd
    .command('dashboard')
    .description('Open a local dashboard for this seller: status, model health, gas, earnings, events, settings and alerts')
    .option('-p, --port <port>', 'dashboard port', String(DEFAULT_SELLER_DASHBOARD_PORT))
    .option('--host <host>', 'listen address (keep 127.0.0.1 and use an SSH tunnel for a remote server)', '127.0.0.1')
    .option('--no-open', 'do not open the browser automatically')
    .action(async (options: { port: string; host: string; open: boolean }) => {
      const { dataDir, config } = getGlobalOptions(sellerCmd);
      if (!hasSeller(dataDir)) {
        console.log(chalk.yellow(`No seller has run with data dir ${dataDir} yet; the dashboard will fill in once \`${sellerCommand(sellerCmd, 'start')}\` runs there.`));
      }
      const port = Number(options.port) || DEFAULT_SELLER_DASHBOARD_PORT;
      try {
        const server = await startSellerDashboard({ dataDir, configPath: resolveConfigPath(config), version: pkg.version, host: options.host, port, log: (line) => console.error(chalk.dim(line)) });
        console.log('');
        console.log(chalk.bold('Antseed seller dashboard'));
        console.log(`  Data dir: ${dataDir}`);
        console.log(`  Config:   ${resolveConfigPath(config)}`);
        console.log(`  URL:      ${chalk.cyan(server.url)}`);
        console.log(chalk.dim('  The URL carries a session token; anyone with it can see this seller\'s earnings and change its settings.'));
        console.log(chalk.dim(`  On a remote server: ssh -L ${port}:127.0.0.1:${port} <server>, then open the URL above locally.`));
        console.log(chalk.dim('  Press Ctrl+C to stop.'));
        console.log('');
        if (options.open) {
          try {
            const { default: open } = await import('open');
            await open(server.url);
          } catch {
            console.log(chalk.yellow('Could not open a browser automatically; open the URL above manually.'));
          }
        }
        const shutdown = async () => {
          await server.close();
          process.exit(0);
        };
        process.on('SIGINT', () => { void shutdown(); });
        process.on('SIGTERM', () => { void shutdown(); });
      } catch (error) {
        console.error(chalk.red(`Failed to start the seller dashboard: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}
