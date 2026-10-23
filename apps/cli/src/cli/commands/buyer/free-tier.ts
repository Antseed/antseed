import type { Command } from 'commander';
import chalk from 'chalk';
import type { FreeTierDelegation } from '@antseed/node';
import { getGlobalOptions } from '../types.js';
import { loadAuthorizingIdentity, runBrowserWalletAuthorization } from './set-authorized-wallet.js';

interface FreeTierShareOptions {
  open: boolean;
  identity?: string;
}

interface FreeTierIdentityOptions {
  identity?: string;
}

/** Delegations naming `buyer`, with whether each is still valid. */
export function delegationsForBuyer(
  delegations: readonly FreeTierDelegation[],
  buyer: string,
  nowMs = Date.now(),
): Array<FreeTierDelegation & { expired: boolean }> {
  return delegations
    .filter((delegation) => delegation.buyer.toLowerCase() === buyer.toLowerCase())
    .map((delegation) => ({ ...delegation, expired: delegation.expiresAt * 1000 <= nowMs }));
}

/** `delegations` without `staker`'s delegation to `buyer`. */
export function withoutDelegation(
  delegations: readonly FreeTierDelegation[],
  buyer: string,
  staker: string,
): FreeTierDelegation[] {
  return delegations.filter((delegation) =>
    !(delegation.buyer.toLowerCase() === buyer.toLowerCase() && delegation.staker.toLowerCase() === staker.toLowerCase()));
}

export function registerBuyerFreeTierCommands(buyerCmd: Command): void {
  const freeTierCmd = buyerCmd
    .command('free-tier')
    .description('Share ANTS stake with this buyer for larger free-tier allowances on sellers');

  freeTierCmd
    .command('share')
    .description('Open a local page where a staking wallet signs consent to share its stake with this buyer')
    .option('--no-open', 'print the secure local URL without opening a browser')
    .option('--identity <name>', 'share with this buyer identity (e.g. a gateway workspace) instead of the default one')
    .addHelpText('after', '\nThe connected wallet signs a message (no gas, no funds move). On each seller, its positions in that seller\'s pool then count toward this buyer\'s staked free tier there, pooled with the buyer\'s own stake and any other stakers who shared. A running buyer picks it up within a minute.')
    .action(async (options: FreeTierShareOptions) => {
      try {
        const globalOpts = getGlobalOptions(buyerCmd);
        const buyer = await loadAuthorizingIdentity(globalOpts.dataDir, options.identity);
        console.log(chalk.dim(`Buyer: ${buyer.address}`));
        const { createServer } = await import('@antseed/payments');
        const openBrowser = options.open ? (await import('open')).default : undefined;
        await runBrowserWalletAuthorization({
          dataDir: globalOpts.dataDir,
          configPath: globalOpts.config,
          createServer,
          action: 'share-free-tier',
          ...(buyer.identityHex ? { identityHex: buyer.identityHex } : {}),
          ...(openBrowser ? { openBrowser } : {}),
          log: (message) => console.log(chalk.dim(message)),
        });
        console.log(chalk.green('Stake shared with this buyer.'));
      } catch (err) {
        console.error(chalk.red(`Failed to share stake: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  freeTierCmd
    .command('add <code>')
    .description('Save a free-tier code a staker created for this buyer in the ANTS staking dashboard')
    .option('--identity <name>', 'add to this buyer identity (e.g. a gateway workspace) instead of the default one')
    .addHelpText('after', '\nThe staker creates the code under My positions → Share free tier. A running buyer picks it up within a minute.')
    .action(async (code: string, options: FreeTierIdentityOptions) => {
      try {
        const globalOpts = getGlobalOptions(buyerCmd);
        const buyer = await loadAuthorizingIdentity(globalOpts.dataDir, options.identity);
        const { loadConfig } = await import('../../../config/loader.js');
        const { updateFreeTierDelegations } = await import('../../../config/free-tier-delegations.js');
        const { requireCryptoConfig } = await import('../../payment-utils.js');
        const { acceptFreeTierDelegationCode, withFreeTierDelegation } = await import('@antseed/node');
        const config = await loadConfig(globalOpts.config);
        const delegation = acceptFreeTierDelegationCode(code, buyer.address, requireCryptoConfig(config).evmChainId);
        await updateFreeTierDelegations(globalOpts.config, (current) => withFreeTierDelegation(current, delegation));
        const until = new Date(delegation.expiresAt * 1000).toISOString().slice(0, 10);
        console.log(chalk.green(`Added stake from ${delegation.staker} until ${until}.`));
        console.log(chalk.dim(`Buyer: ${buyer.address}`));
      } catch (err) {
        console.error(chalk.red(`Failed to add code: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  freeTierCmd
    .command('list')
    .description('List the stakers sharing their stake with this buyer')
    .option('--identity <name>', 'list for this buyer identity instead of the default one')
    .action(async (options: FreeTierIdentityOptions) => {
      try {
        const globalOpts = getGlobalOptions(buyerCmd);
        const buyer = await loadAuthorizingIdentity(globalOpts.dataDir, options.identity);
        const { loadConfig } = await import('../../../config/loader.js');
        const config = await loadConfig(globalOpts.config);
        const entries = delegationsForBuyer(config.buyer.freeTierDelegations ?? [], buyer.address);
        if (entries.length === 0) {
          console.log(chalk.dim('No stakers share with this buyer. Ask a staker for a code and run `antseed buyer free-tier add <code>`.'));
          return;
        }
        for (const entry of entries) {
          const until = new Date(entry.expiresAt * 1000).toISOString().slice(0, 10);
          console.log(`${entry.staker}  ${entry.expired ? chalk.red(`expired ${until}`) : chalk.dim(`until ${until}`)}`);
        }
      } catch (err) {
        console.error(chalk.red(`Failed to list stakers: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  freeTierCmd
    .command('remove <staker>')
    .description('Stop sending a staker\'s delegation to sellers')
    .option('--identity <name>', 'remove from this buyer identity instead of the default one')
    .addHelpText('after', '\nSellers that already saw the signature may keep honouring it until it expires. To end sharing everywhere at once, the staker moves or withdraws the stake.')
    .action(async (staker: string, options: FreeTierIdentityOptions) => {
      try {
        const globalOpts = getGlobalOptions(buyerCmd);
        const buyer = await loadAuthorizingIdentity(globalOpts.dataDir, options.identity);
        const { updateFreeTierDelegations } = await import('../../../config/free-tier-delegations.js');
        let removed = false;
        await updateFreeTierDelegations(globalOpts.config, (current) => {
          const next = withoutDelegation(current, buyer.address, staker);
          removed = next.length < current.length;
          return next;
        });
        if (!removed) {
          console.log(chalk.yellow(`${staker} does not share with this buyer.`));
          return;
        }
        console.log(chalk.green(`Removed ${staker}.`));
      } catch (err) {
        console.error(chalk.red(`Failed to remove staker: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
