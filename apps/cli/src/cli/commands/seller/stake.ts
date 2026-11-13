import type { Command } from 'commander';
import { parsePositiveInteger } from '../parse-positive-integer.js';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  createStakingClient,
  createIdentityClient,
  loadCryptoContext,
  formatUsdc,
  parseUsdcToBaseUnits,
  resolveCliContractStack,
  createLegacyStakingClient,
} from '../../payment-utils.js';
import { registerSellerStarterCommand, runPoolStake } from './pool.js';

type GlobalOptions = ReturnType<typeof getGlobalOptions>;

async function runLegacyStake(
  global: GlobalOptions,
  amount: string,
  options: { agentId?: number },
): Promise<void> {
  const config = await loadConfig(global.config);

  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = parseUsdcToBaseUnits(amount);
  } catch {
    console.error(chalk.red('Error: Amount must be a positive number.'));
    process.exit(1);
  }

  const spinner = ora('Verifying registration...').start();

  try {
    const stack = await resolveCliContractStack(config);
    if (stack.mode === 'recognized-usage') {
      spinner.fail(chalk.red('New USDC stakes are closed after the recognized-usage upgrade. Use: antseed seller stake <ants> --epochs <n>'));
      process.exit(1);
    }
    const { wallet, address } = await loadCryptoContext(global.dataDir);
    const stakingClient = createStakingClient(config);
    const identityClient = createIdentityClient(config);
    const isReg = await identityClient.isRegistered(address);
    if (!isReg) {
      spinner.fail(chalk.red('Not registered. Run: antseed seller register'));
      process.exit(1);
    }

    // Look up agentId from staking contract, or use --agent-id for first-time staking
    let agentId = await stakingClient.getAgentId(address);
    if (agentId === 0 && options.agentId) {
      agentId = options.agentId;
    }
    if (agentId === 0) {
      spinner.fail(chalk.red('No agentId found. Pass --agent-id <id> from your antseed seller register output.'));
      process.exit(1);
    }

    const amountFloat = parseFloat(amount);
    console.log(chalk.dim(`Wallet: ${address}`));
    console.log(chalk.dim(`Agent ID: ${agentId}`));
    console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

    spinner.text = 'Staking USDC...';
    const txHash = await stakingClient.stake(wallet, agentId, amountBaseUnits);
    spinner.succeed(chalk.green(`Staked ${amountFloat} USDC`));
    console.log(chalk.dim(`Transaction: ${txHash}`));
  } catch (err) {
    spinner.fail(chalk.red(`Staking failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

async function runLegacyUnstake(global: GlobalOptions): Promise<void> {
  const config = await loadConfig(global.config);
  const spinner = ora('Fetching stake info...').start();

  try {
    const stack = await resolveCliContractStack(config);
    const { wallet, address } = await loadCryptoContext(global.dataDir);
    const stakingClient = stack.mode === 'recognized-usage'
      ? createLegacyStakingClient(config)
      : createStakingClient(config);
    console.log(chalk.dim(`Wallet: ${address}`));
    if (stack.mode === 'recognized-usage') {
      console.log(chalk.yellow('⚠ Withdrawing legacy USDC stake may remove temporary eligibility until your ANTS position becomes active.'));
    }
    const stake = await stakingClient.getStake(address);
    if (stake === 0n) {
      spinner.fail(chalk.yellow('No active stake to withdraw.'));
      return;
    }

    console.log(chalk.dim(`Current stake: ${formatUsdc(stake)} USDC`));

    spinner.text = 'Unstaking...';
    const txHash = await stakingClient.unstake(wallet);
    spinner.succeed(chalk.green('Unstaked successfully'));
    console.log(chalk.dim(`Transaction: ${txHash}`));
  } catch (err) {
    spinner.fail(chalk.red(`Unstake failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

export function registerSellerStakeCommand(sellerCmd: Command): void {
  sellerCmd
    .command('stake <amount>')
    .description('Stake ANTS into your seller pool')
    .option('--epochs <n>', 'required ANTS lock duration in epochs', parsePositiveInteger)
    .action(async (amount: string, options: { epochs?: number }) => {
      const globalOpts = getGlobalOptions(sellerCmd);
      const config = await loadConfig(globalOpts.config);
      const stack = await resolveCliContractStack(config);

      if (stack.mode !== 'recognized-usage') {
        console.error(chalk.red('ANTS staking is not available on this network. For legacy USDC staking, use: antseed seller legacy stake <amount>'));
        process.exitCode = 1;
        return;
      }
      if (options.epochs === undefined) {
        console.error(chalk.red('ANTS pool staking requires a lock duration. Use: antseed seller stake <ants> --epochs <n>'));
        process.exitCode = 1;
        return;
      }
      await runPoolStake(globalOpts, amount, { epochs: options.epochs });
    });

  const legacy = sellerCmd.command('legacy').description('Legacy seller stake and migration commands');
  registerSellerStarterCommand(legacy);

  legacy
    .command('stake <amount>')
    .description('Stake USDC before the recognized-usage upgrade (e.g. "10" = 10 USDC)')
    .option('--agent-id <id>', 'ERC-8004 agent ID (from antseed seller register output)', parsePositiveInteger)
    .action(async (amount: string, options: { agentId?: number }) => {
      await runLegacyStake(getGlobalOptions(legacy), amount, options);
    });

  legacy
    .command('unstake')
    .description('Withdraw legacy USDC stake (subject to slash conditions)')
    .action(async () => {
      await runLegacyUnstake(getGlobalOptions(legacy));
    });
}
