import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { loadCryptoContext, createDepositsClient } from '../../payment-utils.js';
import { assertBuyerIsAuthorizedWallet } from './authorized-wallet-check.js';

export function registerBuyerWithdrawCommand(buyerCmd: Command): void {
  buyerCmd
    .command('withdraw <amount>')
    .description('Withdraw USDC from the deposits contract (amount in human-readable USDC, e.g. "5" = 5 USDC)')
    .action(async (amount: string) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);

      const payments = config.payments;
      if (!payments?.crypto) {
        console.error(chalk.red('Error: No crypto payment configuration found.'));
        console.error(chalk.dim('Configure payments.crypto in your config file.'));
        process.exit(1);
      }

      const amountFloat = parseFloat(amount);
      if (isNaN(amountFloat) || amountFloat <= 0) {
        console.error(chalk.red('Error: Amount must be a positive number.'));
        process.exit(1);
      }

      const amountBaseUnits = BigInt(Math.round(amountFloat * 1_000_000));
      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const depositsClient = createDepositsClient(config);

      console.log(chalk.dim(`Wallet: ${address}`));
      console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

      const spinner = ora('Withdrawing USDC from deposits contract...').start();

      try {
        await assertBuyerIsAuthorizedWallet(depositsClient, address, 'withdraw deposits');
        const txHash = await depositsClient.withdraw(wallet, address, amountBaseUnits);
        spinner.succeed(chalk.green(`Withdrew ${amountFloat} USDC`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Withdrawal failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
