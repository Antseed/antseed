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
import { ensureRegisteredAgentId, recoveryProgressText } from './agent-id.js';

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
        const { agentId, minted } = await ensureRegisteredAgentId({
          identity: identityClient,
          lookupBoundAgentId: async () => {
            if (stack.mode === 'legacy') return createStakingClient(config).getAgentId(address);
            const bound = await createSellerRegistryClient(config).getAgentId(address);
            if (bound || !stack.addresses.legacyStakingContractAddress) return bound;
            return createLegacyStakingClient(config).getAgentId(address);
          },
          log: (line) => console.log(chalk.dim(line)),
          onMinting: () => { spinner.text = 'Registering peer identity...'; },
          onRecovering: (progress) => { spinner.text = recoveryProgressText(progress); },
        }, wallet, address, {
          agentId: options.agentId as number | undefined,
          metadata: options.metadata as string,
          requireAgentId: stack.mode === 'recognized-usage',
        });
        const alreadyRegistered = !minted;
        if (minted) spinner.succeed(chalk.green('Peer identity registered'));

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

        if (agentId && !minted) console.log(chalk.dim(`Agent ID: ${agentId}`));
      } catch (err) {
        const guidance = err instanceof SellerRegistrationVerificationError ? ' Re-run: antseed seller register' : '';
        spinner.fail(chalk.red(`Registration failed: ${(err as Error).message}${guidance}`));
        process.exit(1);
      }
    });
}
