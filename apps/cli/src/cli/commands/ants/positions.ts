import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { positions, formatAnts, type PositionView } from '@antseed/ants';
import { ants, pct, printJson, runRead } from './shared.js';

/** Exit-slash column: on-chain value when the contract reports one, otherwise the local estimate. */
export function slashColumn(position: Pick<PositionView, 'state' | 'slashBps' | 'projectedSlashBps'>): string {
  if (position.state !== 'active' && position.state !== 'pending') return '—';
  return position.slashBps === null ? `${pct(position.projectedSlashBps)} (est.)` : pct(position.slashBps);
}

export function registerAntsPositionsCommand(antsCmd: Command): void {
  antsCmd
    .command('positions')
    .description('List your lANTS staking positions (closed ones too when the explorer knows them)')
    .option('--json', 'output as JSON', false)
    .action(async (options: { json: boolean }) => runRead(antsCmd, 'Loading positions...', async ({ ctx }) => {
      const view = await positions(ctx);
      if (options.json) return printJson(view);
      if (view.rewardSource?.error) console.log(chalk.yellow(`Staking rewards unavailable: ${view.rewardSource.error}`));
      if (view.positions.length === 0) {
        console.log(chalk.yellow('No staking positions for this wallet.'));
        console.log(chalk.dim('Stake with: antseed ants stake <amount> --agent <agentId> --epochs <n>'));
        return;
      }
      const table = new Table({ head: ['ID', 'Agent', 'Amount', 'Weight', 'Start', 'End', 'Left', 'State', 'Max lock', 'Pending', 'Exit slash'] });
      for (const position of view.positions) {
        table.push([
          position.id,
          position.agentId,
          formatAnts(position.amount),
          formatAnts(position.weightAmount),
          position.stakeStartEpoch,
          position.stakeEndEpoch,
          position.epochsRemaining,
          position.changePending ? `${position.state} (pending)` : position.state,
          position.maxLocked ? 'yes' : 'no',
          formatAnts(position.pendingReward),
          slashColumn(position),
        ]);
      }
      console.log(table.toString());
      console.log(chalk.dim(`Epoch ${view.currentEpoch}. Active stake ${ants(view.totals.activeStake)}, pending staker rewards ${ants(view.totals.pendingRewards)}.`));
      console.log(chalk.dim(`Lock ${view.config.minStakeEpochs}–${view.config.maxStakeEpochs} epochs; early exit burns ${pct(view.config.minEarlyExitSlashBps)}–${pct(view.config.maxSlashBps)}; changes take effect next epoch.`));
    }));
}
