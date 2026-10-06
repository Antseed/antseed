import type { Command } from 'commander';
import { parsePositiveInteger } from '../parse-positive-integer.js';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { SellerRegistrationVerificationError } from '@antseed/node/payments';
import {
  createIdentityClient,
  loadCryptoContext,
  resolveCliContractStack,
  createSellerRegistryClient,
  createLegacyStakingClient,
  createStakingClient,
} from '../../payment-utils.js';

export function registerSellerRegisterCommand(sellerCmd: Command): void {
  sellerCmd
    .command('register')
    .description('Register your peer identity on-chain')
    .option('--metadata <uri>', 'metadata URI (optional)', '')
    .option('--agent-id <id>', 'existing ERC-8004 agent ID', parsePositiveInteger)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(sellerCmd);
      const config = await loadConfig(globalOpts.config);

      const spinner = ora('Checking registration status...').start();

      try {
        const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
        const stack = await resolveCliContractStack(config);
        const identityClient = createIdentityClient(config);
        console.log(chalk.dim(`Wallet: ${address}`));
        const alreadyRegistered = await identityClient.isRegistered(address);
        let agentId = options.agentId as number | undefined;
        if (!alreadyRegistered) {
          spinner.text = 'Registering peer identity...';
          agentId = await identityClient.register(wallet, options.metadata as string || undefined);
          spinner.succeed(chalk.green('Peer identity registered'));
        } else if (stack.mode === 'legacy') {
          agentId = agentId || await createStakingClient(config).getAgentId(address);
        } else {
          const sellerRegistry = createSellerRegistryClient(config);
          agentId = agentId || await sellerRegistry.getAgentId(address);
          if (!agentId && stack.addresses.legacyStakingContractAddress) agentId = await createLegacyStakingClient(config).getAgentId(address);
        }

        if (stack.mode === 'recognized-usage') {
          if (!agentId) throw new Error('Could not determine agent ID. Pass --agent-id <id>.');
          const sellerRegistry = createSellerRegistryClient(config);
          spinner.start('Checking seller registration...');
          const registered = await sellerRegistry.registerSellerBinding(wallet, agentId,
            (hash) => console.log(chalk.dim(`Transaction: ${hash}`)));
          if (registered) {
            spinner.succeed(chalk.green('Seller bound to recognized-usage registry'));
          } else {
            spinner.succeed(chalk.yellow('Already registered and bound'));
          }
        } else if (alreadyRegistered) {
          spinner.succeed(chalk.yellow('Already registered'));
        }

        if (agentId) console.log(chalk.dim(`Agent ID: ${agentId}`));
      } catch (err) {
        const guidance = err instanceof SellerRegistrationVerificationError ? ' Re-run: antseed seller register' : '';
        spinner.fail(chalk.red(`Registration failed: ${(err as Error).message}${guidance}`));
        process.exit(1);
      }
    });
}
