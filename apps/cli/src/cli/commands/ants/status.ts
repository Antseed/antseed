import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { overview, rewards, formatAnts, type OverviewView } from '@antseed/ants';
import { ants, epochDate, printJson, runRead } from './shared.js';

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
}

export function phaseLabel(view: { phase: OverviewView['phase']; epoch: Pick<OverviewView['epoch'], 'effective'> }): string {
  switch (view.phase) {
    case 'legacy': return 'legacy emissions only';
    case 'deployed': return `deployed, activates at epoch ${view.epoch.effective}`;
    case 'active': return 'recognized usage active';
    default: return view.phase;
  }
}

export function registerAntsStatusCommand(antsCmd: Command): void {
  antsCmd
    .command('status')
    .description('Protocol phase, epoch, wallet balances, stake, and claimable rewards')
    .option('--json', 'output as JSON', false)
    .action(async (options: { json: boolean }) => runRead(antsCmd, 'Loading status...', async ({ ctx }) => {
      const view = await overview(ctx);
      const pending = await rewards(ctx).catch(() => null);
      if (options.json) return printJson({ ...view, rewards: pending });
      console.log(chalk.bold('ANTS status\n'));
      const table = new Table({ head: ['Metric', 'Value'], colWidths: [28, 64] });
      table.push(
        ['Chain', `${view.chainId} (${view.rpcUrl})`],
        ['Protocol phase', phaseLabel(view)],
        ['Epoch', `${view.epoch.current} (next boundary ${epochDate(view.epoch.genesis, view.epoch.epochDuration, view.epoch.current + 1)}, in ${formatDuration(view.epoch.secondsToBoundary)})`],
        ['Wallet', view.wallet.address],
        ['ANTS balance', ants(view.wallet.ants)],
        ['ETH balance', `${(Number(view.wallet.eth) / 1e18).toFixed(6)} ETH`],
        ['ANTS transferable', view.wallet.canTransfer ? 'yes' : 'no (transfers disabled, not whitelisted)'],
        ['Active stake', `${ants(view.wallet.totalActiveStake)} in ${view.wallet.positionCount} position(s)`],
        ['Seller agent', view.wallet.agentId ? `${view.wallet.agentId}${view.wallet.sellerBound ? ' (bound in seller registry)' : ' (legacy binding only)'}` : 'none'],
      );
      if (view.network) {
        table.push(
          ['Network active stake', ants(view.network.totalActiveStake)],
          ['Epoch emission', ants(view.network.epochEmission, 0)],
          ['Staker budget (epoch)', ants(view.network.stakerBudget, 0)],
          ['Usage budgets (epoch)', `buyers ${formatAnts(view.network.usageBuyerBudget, 0)} / sellers ${formatAnts(view.network.usageSellerBudget, 0)} ANTS`],
          ['ANTS supply', `${formatAnts(view.network.antsTotalSupply, 0)} / ${formatAnts(view.network.antsMaxSupply, 0)}`],
        );
      }
      if (pending) table.push(['Claimable rewards', ants(pending.total)]);
      console.log(table.toString());
      for (const notice of view.notices) console.log(chalk.yellow(`⚠ ${notice}`));
      console.log(chalk.dim('\nOpen the dashboard with: antseed ants'));
    }));
}
