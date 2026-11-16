import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { poolsView, formatAnts, formatBps, type PoolView } from '@antseed/ants';
import { ants, printJson, runRead, usdc } from './shared.js';

/** Display name for a pool row: explorer name, else a shortened seller address, else "unbound". */
export function poolLabel(pool: Pick<PoolView, 'profile' | 'seller'>): string {
  if (pool.profile?.name) return pool.profile.name;
  if (pool.seller) return `${pool.seller.slice(0, 6)}…${pool.seller.slice(-4)}`;
  return 'unbound';
}

export function registerAntsPoolsCommand(antsCmd: Command): void {
  antsCmd
    .command('pools')
    .description('Compare seller pools: power, share of network, settled volume, staker reward per power, your position')
    .option('--json', 'output as JSON', false)
    .action(async (options: { json: boolean }) => runRead(antsCmd, 'Loading pools...', async ({ ctx }) => {
      const view = await poolsView(ctx);
      if (options.json) return printJson(view);
      if (view.source === 'chain') console.log(chalk.yellow(`Pool statistics unavailable${view.sourceError ? ` (${view.sourceError})` : ' (no explorer configured)'}; listing only pools you stake in.`));
      if (view.pools.length === 0) return console.log(chalk.yellow('No seller pools have been staked or registered yet.'));
      const [current, last] = view.networkVolumes;
      const table = new Table({
        head: ['Pool', 'Agent', 'Power', 'Share', `Vol e${current?.epoch ?? '?'}`, `Vol e${last?.epoch ?? '?'}`, 'ANTS/1k pwr (last)', 'ANTS/1k pwr (proj.)', 'Your power', 'Your share'],
      });
      for (const pool of view.pools) {
        const name = poolLabel(pool);
        table.push([
          pool.stakeable ? name : chalk.dim(`${name} (not stakeable)`),
          pool.agentId,
          formatAnts(pool.weight, 0),
          formatBps(pool.powerShareBps),
          usdc(pool.volumes[0]?.usdc ?? '0', 0),
          usdc(pool.volumes[1]?.usdc ?? '0', 0),
          pool.lastEpochRewardPer1kPower === null ? '—' : formatAnts(pool.lastEpochRewardPer1kPower, 2),
          pool.projectedRewardPer1kPower === null ? '—' : formatAnts(pool.projectedRewardPer1kPower, 2),
          formatAnts(pool.yourPower, 0),
          formatBps(pool.yourPoolShareBps),
        ]);
      }
      console.log(table.toString());
      console.log(chalk.dim(`Epoch ${view.currentEpoch}. Network power ${formatAnts(view.totalPowerWeight, 0)}; your power ${formatAnts(view.yourTotalPower, 0)} (${formatBps(view.yourNetworkShareBps)} of all pools). Network volume ${usdc(current?.usdc ?? '0', 0)} this epoch, ${usdc(last?.usdc ?? '0', 0)} last. Staker budget ${ants(view.stakerBudget, 0)}.`));
      console.log(chalk.dim('Volume is settled USDC per epoch. ANTS/1k power = staker rewards paid per 1,000 units of pool power; projected uses this epoch\'s usage so far.'));
    }));
}
