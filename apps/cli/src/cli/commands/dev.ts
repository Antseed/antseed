import type { Command } from 'commander';
import chalk from 'chalk';

/**
 * Lines `antseed dev` prints. The command never loaded the configured
 * providers or started a buyer proxy, so the proxy URL it printed refused
 * connections. It now stops and points to the commands that work.
 */
export function devCommandRemovedMessage(): string[] {
  return [
    '`antseed dev` has been removed. It never loaded your providers or started a buyer proxy, so the URL it printed did not answer.',
    '',
    'To test your seller:',
    '  1. Add a provider and a service:  antseed config seller add-provider <name> --plugin <plugin>',
    '                                    antseed config seller add-service <name> <serviceId> --input <usd> --output <usd>',
    '  2. Start the seller:              antseed seller start',
    '  3. Get its peer ID:               antseed seller status',
    '  4. From a buyer, call only it:    antseed buyer start --peer <peerId>',
    '',
    'Guide: https://antseed.com/docs/provide/',
  ];
}

export function registerDevCommand(program: Command): void {
  program
    .command('dev', { hidden: true })
    .description('Removed: use antseed seller start and antseed buyer start')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      const [first, ...rest] = devCommandRemovedMessage();
      console.error(chalk.red(first));
      for (const line of rest) console.error(line);
      process.exitCode = 1;
    });
}
