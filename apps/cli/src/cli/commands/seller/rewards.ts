import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AntsContext, closedPositionIds } from '@antseed/ants';
import { legacyEpochs, newEpochs } from '@antseed/node/payments';
import { loadConfig } from '../../../config/loader.js';
import { getGlobalOptions } from '../types.js';
import {
  createEmissionsClient,
  createAntsTokenClient,
  createLegacyEmissionsClient,
  createSellerPoolsClient,
  createSellerPoolsRewardsClient,
  createUsageAccountingClient,
  formatAnts,
  loadCryptoContext,
  resolveCliContractStack,
  requireCryptoConfig,
} from '../../payment-utils.js';
import { pastEpochs } from '../emissions.js';
import { claimEpochRewards, claimPoolRewards, pendingEpochRewards, previewPoolRewards } from '@antseed/node/payments';
import { RewardClaimProgress } from '../reward-actions.js';

export interface SellerRewardSummary {
  legacy: bigint;
  usage: bigint;
  pool: bigint;
  poolPositions: Array<{ id: number; amount: bigint }>;
}

export function totalSellerRewards(summary: SellerRewardSummary): bigint {
  return summary.legacy + summary.usage + summary.pool;
}

async function closedRewardIds(config: Awaited<ReturnType<typeof loadConfig>>, address: string): Promise<number[]> {
  const ctx = new AntsContext({ chain: requireCryptoConfig(config), address });
  return (await closedPositionIds(ctx)).ids;
}

export function registerSellerRewardsCommand(sellerCmd: Command): void {
  const rewards = sellerCmd.command('rewards').description('View or claim all seller ANTS rewards');

  rewards.option('--json', 'output as JSON', false).action(async (options) => {
    const global = getGlobalOptions(rewards);
    const config = await loadConfig(global.config);
    const spinner = ora('Fetching seller rewards...').start();
    try {
      const { address } = await loadCryptoContext(global.dataDir);
      const stack = await resolveCliContractStack(config);
      const legacyIds = stack.mode === 'legacy'
        ? pastEpochs(stack.currentEpoch)
        : legacyEpochs(stack.currentEpoch, stack.firstRewardedEpoch!);
      const legacyClient = stack.mode === 'legacy' ? createEmissionsClient(config)
        : stack.addresses.legacyEmissionsContractAddress ? createLegacyEmissionsClient(config) : undefined;
      const legacy = legacyClient
        ? await pendingEpochRewards(legacyIds, async (epochs) => (await legacyClient.pendingEmissions(address, epochs)).seller)
        : 0n;
      let usage = 0n;
      let poolPositions: Array<{ id: number; amount: bigint }> = [];
      if (stack.mode === 'recognized-usage') {
        const recognizedIds = newEpochs(stack.currentEpoch, stack.firstRewardedEpoch!);
        const usageClient = createUsageAccountingClient(config);
        usage = await pendingEpochRewards(recognizedIds, async (epochs) => (await usageClient.pendingEmissions(address, epochs)).seller);
        const pools = createSellerPoolsClient(config);
        const poolRewards = createSellerPoolsRewardsClient(config);
        poolPositions = await previewPoolRewards(pools, poolRewards, address, undefined, { includeIds: await closedRewardIds(config, address) });
      }
      const pool = poolPositions.reduce((total, position) => total + position.amount, 0n);
      const summary = { legacy, usage, pool, poolPositions };
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify({
          address,
          mode: stack.mode,
          legacy: formatAnts(legacy),
          recognizedUsage: formatAnts(usage),
          pool: formatAnts(pool),
          total: formatAnts(totalSellerRewards(summary)),
          poolPositions: poolPositions.map((position) => ({ id: position.id, amount: formatAnts(position.amount) })),
        }, null, 2));
        return;
      }
      console.log(chalk.bold('Seller Rewards:\n'));
      console.log(`  Legacy emissions:         ${chalk.green(`${formatAnts(legacy)} ANTS`)}`);
      if (stack.mode === 'recognized-usage') {
        console.log(`  Recognized-use emissions: ${chalk.green(`${formatAnts(usage)} ANTS`)}`);
        console.log(`  Pool staking rewards:     ${chalk.green(`${formatAnts(pool)} ANTS`)}`);
      }
      console.log(`  Total:                    ${chalk.green(`${formatAnts(totalSellerRewards(summary))} ANTS`)}`);
      console.log(chalk.dim('\nRun antseed seller rewards claim to collect. Amounts reflect completed epochs at the time of this read.'));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to fetch rewards: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

  rewards.command('claim').description('Claim all pending seller ANTS rewards').action(async () => {
    const global = getGlobalOptions(rewards);
    const config = await loadConfig(global.config);
    const spinner = ora('Claiming seller rewards...').start();
    let progress: RewardClaimProgress | undefined;
    try {
      const { wallet, address } = await loadCryptoContext(global.dataDir);
      const stack = await resolveCliContractStack(config);
      const token = createAntsTokenClient(config);
      progress = new RewardClaimProgress(
        (hash, kind) => console.log(chalk.dim(`${kind === 'accounting' ? 'Preparation' : 'Claim'} transaction confirmed: ${hash}`)),
        (hash) => token.receivedInTransaction(hash, address),
      );
      const legacyIds = stack.mode === 'legacy'
        ? pastEpochs(stack.currentEpoch)
        : legacyEpochs(stack.currentEpoch, stack.firstRewardedEpoch!);
      const legacyClient = stack.mode === 'legacy' ? createEmissionsClient(config)
        : stack.addresses.legacyEmissionsContractAddress ? createLegacyEmissionsClient(config) : undefined;
      if (legacyClient) {
        await claimEpochRewards(legacyIds,
          async (epochs) => (await legacyClient.pendingEmissions(address, epochs)).seller,
          (epochs) => legacyClient.claimSellerEmissions(wallet, epochs), progress.record);
      }
      if (stack.mode === 'recognized-usage') {
        const recognizedIds = newEpochs(stack.currentEpoch, stack.firstRewardedEpoch!);
        const usageClient = createUsageAccountingClient(config);
        await claimEpochRewards(recognizedIds,
          async (epochs) => (await usageClient.pendingEmissions(address, epochs)).seller,
          (epochs) => usageClient.claimSellerEmissions(wallet, epochs), progress.record);
        const pools = createSellerPoolsClient(config);
        const poolRewards = createSellerPoolsRewardsClient(config);
        const includeIds = await closedRewardIds(config, address);
        await claimPoolRewards(pools, poolRewards, wallet, address, address, progress.record, () => {
          spinner.text = 'Updating pool rewards (preparation transactions require gas)...';
        }, undefined, { includeIds });
      }
      if (progress.claimed === 0n) {
        spinner.succeed(chalk.yellow('No pending seller rewards to claim.'));
        return;
      }
      spinner.succeed(chalk.green(`Claimed ${formatAnts(progress.claimed)} ANTS across ${progress.transactions.length} transaction(s)`));
    } catch (error) {
      spinner.fail(chalk.red(progress?.failure((error as Error).message) ?? `Claim failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });
}
