import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { emissions, formatAnts } from '@antseed/ants';
import { ants, epochDate, printJson, runRead } from './shared.js';

/** Share of the epoch emission as a percentage, e.g. 2000/100000 → "2%". */
export function sharePercent(value: number, denominator: number): string {
  return `${(value * 100 / denominator).toFixed(1).replace(/\.0$/, '')}%`;
}

export function registerAntsEmissionsCommand(antsCmd: Command): void {
  antsCmd
    .command('emissions')
    .description('Emission schedule, gate buckets, and dynamic reward shares')
    .option('--json', 'output as JSON', false)
    .action(async (options: { json: boolean }) => runRead(antsCmd, 'Loading emissions...', async ({ ctx }) => {
      const view = await emissions(ctx);
      if (options.json) return printJson(view);
      const share = (value: number) => sharePercent(value, view.shareDenominator);
      console.log(chalk.bold('Emissions\n'));
      console.log(`  Genesis           ${epochDate(view.genesis, view.epochDuration, 0)}`);
      console.log(`  Epoch length      ${view.epochDuration / 86_400} days`);
      console.log(`  Current epoch     ${view.currentEpoch}${view.effectiveEpoch !== null ? ` (recognized usage from epoch ${view.effectiveEpoch})` : ''}`);
      console.log(`  Initial emission  ${ants(view.initialEmission, 0)} per epoch, halving every ${view.halvingInterval} epochs`);
      console.log(`  Current rate      ${formatAnts(view.currentRate)} ANTS per second`);
      console.log(`  Emitted so far    ${ants(view.cumulativeThroughCurrent, 0)} (through the current epoch)`);
      if (view.minters.length > 0) {
        const table = new Table({ head: ['Bucket', 'Share', 'Controller', 'Editable', 'Budget this epoch'] });
        for (const minter of view.minters) {
          table.push([minter.name, `${(minter.shareBps * 100 / view.shareDenominator).toFixed(1)}%`, minter.controller, minter.editable ? 'yes' : 'no', ants(minter.epochBudget, 0)]);
        }
        console.log(table.toString());
      }
      if (view.dynamicStaker) {
        console.log(chalk.dim(`  Staker rewards scale from ${share(view.dynamicStaker.minShareBps)} to ${share(view.dynamicStaker.maxShareBps)} of the epoch emission as active stake approaches ${formatAnts(view.dynamicStaker.stakeShareTarget, 0)} ANTS`));
      }
      if (view.dynamicUsage) {
        console.log(chalk.dim(`  Usage rewards scale with volume (target ${(Number(view.dynamicUsage.volumeShareTarget) / 1e6).toLocaleString()} USDC/epoch): buyers ${share(view.dynamicUsage.buyerMinShareBps)}–${share(view.dynamicUsage.buyerMaxShareBps)}, sellers ${share(view.dynamicUsage.sellerMinShareBps)}–${share(view.dynamicUsage.sellerMaxShareBps)} of the epoch emission`));
      }
      if (view.legacy) {
        console.log(chalk.dim(`  Legacy V2 ${view.legacy.contract}: sellers ${view.legacy.sellerPct}% / buyers ${view.legacy.buyerPct}% / reserve ${view.legacy.reservePct}% / team ${view.legacy.teamPct}%`));
      }
    }));
}
