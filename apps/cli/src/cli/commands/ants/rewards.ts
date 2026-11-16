import type { Command } from 'commander';
import { parsePositiveInteger } from '../parse-positive-integer.js';
import chalk from 'chalk';
import { rewards, claim, restake, stakeUsageRewards, compound, formatAnts, type RewardBucket, type CompoundResult } from '@antseed/ants';
import { ants, parseIds, printJson, runAction, runRead } from './shared.js';

export const REWARD_BUCKETS: readonly RewardBucket[] = ['staker', 'seller', 'buyer', 'legacy', 'locked'];

/** Buckets selected by `--staker/--seller/...` flags; an empty list means every bucket. */
export function selectedBuckets(options: Partial<Record<RewardBucket, boolean>>): RewardBucket[] {
  return REWARD_BUCKETS.filter((bucket) => options[bucket] === true);
}

export function parseUsageSide(side: string): 'seller' | 'buyer' {
  if (side !== 'seller' && side !== 'buyer') throw new Error('--side must be seller or buyer.');
  return side;
}

export function compoundSummary(result: CompoundResult): string {
  const parts = [
    result.restakedPositionIds.length ? `staker rewards from ${result.restakedPositionIds.length} position(s)` : '',
    result.sellerEpochs.length ? `seller usage for ${result.sellerEpochs.length} epoch(s)` : '',
    result.buyerEpochs.length ? `buyer usage for ${result.buyerEpochs.length} epoch(s)` : '',
    result.movedPositionIds.length ? `moved ${result.movedPositionIds.length} position(s) to agent ${result.targetAgentId}` : '',
  ].filter(Boolean);
  return `Compounded ${parts.join(', ')} across ${result.transactions.length} transaction(s)`;
}

export function registerAntsRewardsCommand(antsCmd: Command): void {
  const rewardsCmd = antsCmd
    .command('rewards')
    .description('View or claim ANTS rewards (staker, seller usage, buyer usage, legacy, locked)');

  rewardsCmd
    .option('--json', 'output as JSON', false)
    .action(async (options: { json: boolean }) => runRead(antsCmd, 'Loading rewards...', async ({ ctx }) => {
      const view = await rewards(ctx);
      if (options.json) return printJson(view);
      console.log(chalk.bold('ANTS rewards\n'));
      const line = (label: string, amount: string | null, note = '') => {
        console.log(`  ${label.padEnd(28)} ${chalk.green(ants(amount).padStart(24))}  ${chalk.dim(note)}`);
      };
      line('Staker pool rewards', view.staker.total, view.staker.positions.length ? `${view.staker.positions.length} position(s)` : '');
      if (view.staker.source?.error) console.log(chalk.yellow(`    ${view.staker.source.error}`));
      else if (view.staker.source?.indexedBlock !== undefined) console.log(chalk.dim(`    Antscan checkpoint: block ${view.staker.source.indexedBlock}; claims are verified live.`));
      line('Seller usage rewards', view.sellerUsage.total, view.sellerUsage.agentId ? `agent ${view.sellerUsage.agentId}` : 'no seller agent');
      line('Buyer usage rewards', view.buyerUsage.total, view.buyerUsage.operator && !view.buyerUsage.claimable ? `paid to operator ${view.buyerUsage.operator}` : '');
      line('Legacy seller emissions', view.legacy.seller, view.legacy.contract ?? '');
      line('Legacy buyer emissions', view.legacy.buyer);
      line('Locked legacy pool (claimable)', view.locked.claimable, `${formatAnts(view.locked.locked)} locked${view.locked.policy ? '' : ', release policy not installed (M002)'}`);
      console.log(`  ${'Total claimable'.padEnd(28)} ${chalk.bold(ants(view.total).padStart(24))}`);
      for (const position of view.staker.positions.filter((entry) => BigInt(entry.amount) > 0n)) {
        console.log(chalk.dim(`    position ${position.id} (agent ${position.agentId}): ${formatAnts(position.amount)}${position.closed ? ', closed' : ''}`));
      }
      console.log(chalk.dim('\nClaim with: antseed ants rewards claim [--staker|--seller|--buyer|--legacy|--locked]. Compound with: antseed ants rewards restake --epochs <n>.'));
    }));

  rewardsCmd
    .command('claim')
    .description('Claim pending rewards into the wallet (all buckets unless filtered)')
    .option('--staker', 'staker pool rewards', false)
    .option('--seller', 'seller usage rewards', false)
    .option('--buyer', 'buyer usage rewards', false)
    .option('--legacy', 'legacy V2 emissions', false)
    .option('--locked', 'locked legacy pool release', false)
    .option('--recipient <address>', 'send claimed ANTS to another address (staker and locked buckets only)')
    .action(async (options: Partial<Record<RewardBucket, boolean>> & { recipient?: string }) => runAction(antsCmd, 'Claiming rewards...', async ({ ctx }, report) => {
      const result = await claim(ctx, { buckets: selectedBuckets(options), recipient: options.recipient }, report);
      if (result.transactions.length === 0) return 'No pending rewards to claim';
      return `Claimed ${ants(result.claimed)} across ${result.transactions.length} transaction(s)`;
    }));

  rewardsCmd
    .command('restake [ids...]')
    .description('Compound staker rewards into a new locked position (earns the restake weight bonus)')
    .requiredOption('--epochs <n>', 'lock length for the new position', parsePositiveInteger)
    .action(async (ids: string[], options: { epochs: number }) => runAction(antsCmd, 'Restaking rewards...', async ({ ctx }, report) => {
      const result = await restake(ctx, { positionIds: ids.length ? parseIds(ids) : undefined, epochs: options.epochs }, report);
      return `Restaked rewards from position(s) ${result.positionIds.join(', ')} for ${result.epochs} epoch(s)`;
    }));

  rewardsCmd
    .command('compound')
    .description('Restake every restakable reward (staker pool, seller usage, buyer usage when operator) into new locked positions')
    .requiredOption('--epochs <n>', 'lock length for the new positions', parsePositiveInteger)
    .option('--to <agentId>', 'pool to hold the new positions (restaked in place, then moved; default: each reward\'s own pool)', parsePositiveInteger)
    .action(async (options: { epochs: number; to?: number }) => runAction(antsCmd, 'Compounding rewards...', async ({ ctx }, report) => {
      const result = await compound(ctx, { epochs: options.epochs, targetAgentId: options.to }, report);
      return compoundSummary(result);
    }));

  rewardsCmd
    .command('stake-usage')
    .description('Claim usage rewards straight into a new locked position instead of the wallet')
    .requiredOption('--side <seller|buyer>', 'which usage rewards to stake')
    .requiredOption('--epochs <n>', 'lock length for the new position', parsePositiveInteger)
    .option('--agent <agentId>', 'destination pool for buyer rewards (sellers stake into their own agent)', parsePositiveInteger)
    .action(async (options: { side: string; epochs: number; agent?: number }) => runAction(antsCmd, 'Staking usage rewards...', async ({ ctx }, report) => {
      const result = await stakeUsageRewards(ctx, { side: parseUsageSide(options.side), epochs: options.epochs, stakeAgentId: options.agent }, report);
      return `Staked usage rewards for epoch(s) ${result.epochsStaked.join(', ')}`;
    }));
}
