import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import crypto from 'node:crypto';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { AntseedNode } from '@antseed/node';
import { DHTNode } from '@antseed/node/discovery';
import { toPeerId } from '@antseed/node';
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery';
import { setupShutdownHandler } from '../shutdown.js';

export function registerDevCommand(program: Command): void {
  program
    .command('dev')
    .description('Run seller + buyer locally for development and testing')
    .option('-p, --port <number>', 'buyer proxy port', (v) => parseInt(v, 10))
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      if (options.port !== undefined) {
        config.buyer.proxyPort = options.port as number;
      }

      const spinner = ora('Starting local network...').start();

      // 1. Create and start local bootstrap DHT node
      const bootstrapPeerId = toPeerId(crypto.randomBytes(20).toString('hex'));
      const bootstrapDht = new DHTNode({
        peerId: bootstrapPeerId,
        port: 0,
        bootstrapNodes: [],
        reannounceIntervalMs: 60_000,
        operationTimeoutMs: 10_000,
      });

      try {
        await bootstrapDht.start();
      } catch (err) {
        spinner.fail(chalk.red(`Failed to start local DHT: ${(err as Error).message}`));
        process.exit(1);
      }

      const bootstrapPort = bootstrapDht.getPort();
      spinner.text = 'Starting seller node...';

      // 2. Bootstrap config pointing at local node
      const localBootstrap = toBootstrapConfig(parseBootstrapList([`127.0.0.1:${bootstrapPort}`]));

      // 3. Start seller node
      const seller = new AntseedNode({
        role: 'seller',
        bootstrapNodes: localBootstrap,
      });

      try {
        await seller.start();
      } catch (err) {
        await bootstrapDht.stop();
        spinner.fail(chalk.red(`Failed to start seller: ${(err as Error).message}`));
        process.exit(1);
      }

      spinner.text = 'Starting buyer node...';

      // 4. Start buyer node
      const buyer = new AntseedNode({
        role: 'buyer',
        bootstrapNodes: localBootstrap,
        autoReconcileBuyerChannels: false,
      });

      try {
        await buyer.start();
      } catch (err) {
        await seller.stop();
        await bootstrapDht.stop();
        spinner.fail(chalk.red(`Failed to start buyer proxy: ${(err as Error).message}`));
        process.exit(1);
      }

      spinner.succeed(chalk.green('Dev mode running (local network)'));

      const proxyUrl = `http://localhost:${config.buyer.proxyPort}`;

      console.log('');
      console.log(chalk.bold('Proxy running at: ') + chalk.cyan(proxyUrl));
      console.log(chalk.dim(`Local DHT bootstrap on port ${bootstrapPort}`));
      console.log('');
      console.log(chalk.bold('Configure your CLI tools:'));
      console.log(chalk.dim('  # Anthropic (Claude Code)'));
      console.log(`  export ANTHROPIC_BASE_URL=${proxyUrl}`);
      console.log(chalk.dim('  # OpenAI (Codex)'));
      console.log(`  export OPENAI_BASE_URL=${proxyUrl}`);
      console.log(chalk.dim('  # Google'));
      console.log(`  export GOOGLE_API_BASE_URL=${proxyUrl}`);
      console.log('');

      setupShutdownHandler(async () => {
        spinner.start('Shutting down dev environment...');
        await buyer.stop();
        await seller.stop();
        await bootstrapDht.stop();
        spinner.succeed('Dev environment stopped.');
      });
    });
}
