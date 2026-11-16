import type { Command } from 'commander';
import { parsePositiveInteger } from '../parse-positive-integer.js';
import chalk from 'chalk';
import Table from 'cli-table3';
import { usage } from '@antseed/ants';
import { printJson, runRead } from './shared.js';

export const DEFAULT_USAGE_EPOCHS = 8;

export function registerAntsUsageCommand(antsCmd: Command): void {
  antsCmd
    .command('usage')
    .description('Your buyer/seller usage points per epoch and network totals')
    .option('--epochs <n>', 'number of recent epochs', parsePositiveInteger, DEFAULT_USAGE_EPOCHS)
    .option('--json', 'output as JSON', false)
    .action(async (options: { epochs: number; json: boolean }) => runRead(antsCmd, 'Loading usage...', async ({ ctx }) => {
      const view = await usage(ctx, { epochs: options.epochs });
      if (options.json) return printJson(view);
      if (view.source === 'chain' && view.sourceError) console.log(chalk.yellow(`Per-epoch usage unavailable: ${view.sourceError}`));
      if (view.epochs.length === 0) {
        console.log(chalk.yellow(`No recognized-usage epochs yet (accounting starts at epoch ${view.firstRewardedEpoch ?? '?'}, current epoch ${view.currentEpoch}).`));
        return;
      }
      const table = new Table({ head: ['Epoch', 'Your buyer pts', 'Weighted', 'Your seller pts', 'Agent', 'Net buyer pts', 'Net seller pts', 'Net pool pts'] });
      for (const row of view.epochs) {
        table.push([row.epoch, row.buyerPoints, row.weightedBuyerPoints, row.sellerPoints, row.agentId || '—', row.totalBuyerPoints, row.totalSellerPoints, row.totalPoolPoints]);
      }
      console.log(table.toString());
      console.log(chalk.dim(`Lifetime buyer points ${view.totals.buyerPoints} (weighted ${view.totals.buyerWeightedPoints}). Points policy ${view.pointsPolicy ?? 'none'}.`));
    }));
}
