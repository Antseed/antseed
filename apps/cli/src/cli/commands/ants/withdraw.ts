import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { previewWithdraw, withdraw, formatAnts, type WithdrawPreview } from '@antseed/ants';
import { ants, confirm, parseIds, pct, runAction } from './shared.js';

export interface WithdrawOptions {
  acceptSlashing: boolean;
  yes: boolean;
  preview: boolean;
}

export type WithdrawDecision = 'preview' | 'send' | 'confirm';

/**
 * What to do after the estimate is shown: stop at the preview, send right
 * away (matured positions, or an accepted early exit with --yes), or ask the
 * user first. Early exits without --accept-slashing are refused.
 */
export function withdrawDecision(preview: Pick<WithdrawPreview, 'earlyExit'>, options: WithdrawOptions): WithdrawDecision {
  if (options.preview) return 'preview';
  if (!preview.earlyExit) return 'send';
  if (!options.acceptSlashing) throw new Error('Positions are still locked. Re-run with --accept-slashing to proceed.');
  return options.yes ? 'send' : 'confirm';
}

export function registerAntsWithdrawCommand(antsCmd: Command): void {
  antsCmd
    .command('withdraw <ids...>')
    .description('Withdraw positions (early exits burn part of the principal)')
    .option('--accept-slashing', 'allow an early exit after reviewing the estimated burn', false)
    .option('-y, --yes', 'skip the interactive confirmation (requires --accept-slashing for early exits)', false)
    .option('--preview', 'only show the estimate', false)
    .action(async (ids: string[], options: WithdrawOptions) => runAction(antsCmd, 'Checking positions...', async ({ ctx }, report, spinner) => {
      const preview = await previewWithdraw(ctx, parseIds(ids));
      spinner.stop();
      const table = new Table({ head: ['ID', 'Amount', 'Slash', 'Burned', 'Returned'] });
      for (const row of preview.positions) {
        table.push([row.id, formatAnts(row.amount), pct(row.slashBps), formatAnts(row.slashedAmount), formatAnts(row.returnedAmount)]);
      }
      console.log(table.toString());
      if (preview.earlyExit) {
        console.log(chalk.red(`Estimated principal burned: ${ants(preview.totalSlashed)}. Final slashing is computed on-chain at confirmation.`));
      }
      const decision = withdrawDecision(preview, options);
      if (decision === 'preview') return 'Preview only; nothing sent';
      if (decision === 'confirm' && !(await confirm(chalk.red(`Withdraw and burn about ${ants(preview.totalSlashed)}? [y/N] `)))) {
        throw new Error('Withdrawal cancelled.');
      }
      spinner.start('Withdrawing...');
      const result = await withdraw(ctx, { positionIds: parseIds(ids), acceptSlashing: options.acceptSlashing, maxSlashedAmount: preview.totalSlashed }, report);
      return `Withdrew ${ids.length} position(s); returned about ${ants(result.preview.totalReturned)}`;
    }));
}
